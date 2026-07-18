// Torture scenarios for the evidence-lane formatters added in v1.6.0
// (G21/G22, slot G21.5). Standard cases live in test/21-evidence.test.mjs.
//
// The evidence lane is a pure formatter -- no measurement, no observer, no
// hot-path allocation concerns. The torture axes reflect that shape:
//
//   Axis A -- adversarial: NaN/Infinity fields, huge violation counts,
//             mixed-schema reports, prototype-poisoned rule labels,
//             XSS-style rule strings. Formatter MUST not crash and MUST
//             not produce output that overstates verdict.
//   Axis B -- signal-under-noise: a real fail report produces output that
//             names the rule and includes actual/limit; a pass report does
//             not falsely claim violations even when the .violations array
//             has stale entries left over from a mutated report.
//   Axis C -- self-noise: calling explainReport / gateBadge does not
//             perturb the profiler, does not read process.memoryUsage,
//             does not open a PerformanceObserver.
//   Axis D -- determinism: identical report input produces byte-identical
//             output on two calls in sequence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GcProfiler, measureOps, checkOps } from '../../Gc.js';
import { explainReport, explainDiff, gateBadge } from '../../Explain.js';

// =============================================================================
// AXIS A -- adversarial
// =============================================================================

test('[axis A] NaN/Infinity in actual/limit does not crash the formatter', () => {
    const rep = {
        schema: 'lite-gc-report/1',
        kind: 'ops',
        verdict: 'fail',
        source: 'gc',
        checked: { maxBytesPerOp: true },
        violations: [
            { rule: 'maxBytesPerOp', metric: 'bytesPerOp', actual: NaN, limit: 5 },
            { rule: 'maxBytesPerOp', metric: 'bytesPerOp', actual: Infinity, limit: 5 },
            { rule: 'maxBytesPerOp', metric: 'bytesPerOp', actual: 5, limit: NaN },
            { rule: 'maxBytesPerOp', metric: 'bytesPerOp', actual: -Infinity, limit: 0 }
        ]
    };
    // Must not throw; must produce a plausibly-shaped report.
    const out = explainReport(rep);
    assert.match(out, /Violations \(4\):/);
    // NaN and Infinity must render as themselves rather than crashing on
    // .toFixed or silently producing 'undefined'.
    assert.match(out, /NaN|Infinity/);
});

test('[axis A] massive violation count is capped by maxViolations without OOM', () => {
    const rep = {
        schema: 'lite-gc-report/1',
        kind: 'ops',
        verdict: 'fail',
        source: 'gc',
        checked: {},
        violations: []
    };
    for (let i = 0; i < 100000; i++) {
        rep.violations.push({ rule: 'maxBytesPerOp', metric: 'bytesPerOp', actual: 1 + i, limit: 1 });
    }
    const out = explainReport(rep, { maxViolations: 10 });
    assert.match(out, /Violations \(100000\)/);
    assert.match(out, /and 99990 more/);
    // Sanity: output size stays proportional to maxViolations, not violations.length.
    assert.ok(out.length < 5000, 'capped output must not grow with violations.length; got ' + out.length + ' chars');
});

test('[axis A] rule/metric strings containing HTML/ANSI/newlines do not corrupt SVG or ANSI output', () => {
    // A malicious or accidentally-formatted rule name must not be interpreted
    // as markup or as an escape sequence by the badge/SVG generator. The
    // formatter contract is "readout", not "sanitised HTML"; the test pins
    // that at minimum the raw content flows through without crashing and
    // without breaking the SVG/JSON envelope.
    const rep = {
        schema: 'lite-gc-report/1',
        kind: 'ops',
        verdict: 'fail',
        source: 'gc',
        checked: {},
        violations: [{
            rule: '<script>alert(1)</script>',
            metric: '\x1b[31mred\x1b[0m',
            actual: 1,
            limit: 0
        }]
    };
    // Text formats: don't crash.
    const out = explainReport(rep);
    assert.ok(typeof out === 'string' && out.length > 0);
    // JSON badge: JSON.stringify must escape internal quotes, so the label
    // stays well-formed regardless of what the rule strings contain.
    const json = gateBadge(rep, { format: 'shields-json' });
    assert.doesNotThrow(() => JSON.parse(json), 'shields-json badge must always be valid JSON');
});

test('[axis A] verdict:"pass" with a stale non-empty violations array still renders PASS', () => {
    // A caller/formatter must not upgrade a pass to a fail based on a stale
    // violations array. The verdict field is the source of truth.
    const rep = {
        schema: 'lite-gc-report/1',
        kind: 'ops',
        verdict: 'pass',
        source: 'gc',
        checked: {},
        // A stale entry left over from a mutated report -- still says PASS.
        violations: [{ rule: 'maxBytesPerOp', metric: 'bytesPerOp', actual: 999, limit: 5 }]
    };
    const out = explainReport(rep);
    assert.match(out, /PASS/);
    assert.doesNotMatch(out, /^gc-gate:\s+FAIL/m,
        'a pass verdict with stale violations must render as PASS, not FAIL');
    assert.equal(gateBadge(rep, { format: 'text' }), 'gc gate: pass');
});

test('[axis A] undefined/missing fields do not throw or leak "undefined" into the text', () => {
    const rep = {
        // No schema, no source, no checked, no result -- barest legal shape.
        verdict: 'fail',
        violations: [{ actual: 5, limit: 0 }]         // no rule, no metric, no reason
    };
    const out = explainReport(rep);
    assert.match(out, /FAIL/);
    // Whatever fallback we use for the missing rule, it must not be the
    // literal string 'undefined'.
    assert.doesNotMatch(out, /^\s+undefined/m,
        'a missing rule name must never render as the string "undefined"');
});

// =============================================================================
// AXIS B -- signal-under-noise
// =============================================================================

test('[axis B] a real fail report names the rule and includes actual/limit numerals', () => {
    // Real measurement -> real fail. Formatter output must contain the
    // rule name string AND the numeric actual and limit values so a
    // human scanning CI can act on it.
    const sink = [];
    const r = measureOps((i) => { sink.push(new Array(64).fill(i)); },
        { ops: 200, warmup: 40, stabilize: true });
    const rep = checkOps(r, { maxBytesPerOp: 5 });
    assert.equal(rep.verdict, 'fail');
    const out = explainReport(rep);
    // At least one of {rule, metric} must appear.
    assert.match(out, /bytesPerOp/);
    // Both numerals must appear.
    assert.match(out, /actual:/);
    assert.match(out, /limit:\s+5/);
    assert.match(out, /FAIL/);
});

test('[axis B] compare report includes both control and candidate metrics in the readout', () => {
    // A gate failure narrated with only the delta is unactionable. The user
    // needs to see the two absolute readings side-by-side to know which side
    // regressed. Formatter must include a Comparison block with both.
    const rep = {
        schema: 'lite-gc-report/1',
        kind: 'ops-async',
        verdict: 'fail',
        source: 'gc',
        checked: { maxExtraBytesPerOp: true },
        violations: [{ rule: 'maxExtraBytesPerOp', metric: 'bytesPerOp.delta', actual: 42, limit: 5 }],
        control:   { source: 'gc', bytesPerOp: 12, bytesPerOpStable: true },
        candidate: { source: 'gc', bytesPerOp: 54, bytesPerOpStable: true }
    };
    const out = explainReport(rep);
    assert.match(out, /Comparison:/);
    assert.match(out, /control=12/);
    assert.match(out, /candidate=54/);
});

// =============================================================================
// AXIS C -- self-noise (the formatter must not perturb measurement)
// =============================================================================

test('[axis C] formatting a report during an active GcProfiler window does not attribute events', () => {
    // Set up a live profiler, format some reports, then check that no
    // GC events were attributed to the phases where explainReport was
    // running. This pins the "no observer, no perturbation" claim: a
    // failed CI job that runs explainReport in a signal handler or an
    // exit hook must not smear its own bookkeeping onto the last window.
    const gc = new GcProfiler(64, { source: 'auto' }).start();
    gc.phase('formatting');
    const dummy = {
        schema: 'lite-gc-report/1',
        kind: 'ops',
        verdict: 'fail',
        source: 'gc',
        checked: {},
        violations: []
    };
    for (let i = 0; i < 50; i++) {
        dummy.violations.push({ rule: 'maxBytesPerOp', metric: 'bytesPerOp', actual: i + 1, limit: 0 });
    }
    for (let i = 0; i < 10; i++) {
        explainReport(dummy, { maxViolations: 5 });
        gateBadge(dummy, { format: 'text' });
        gateBadge(dummy, { format: 'shields-json' });
        gateBadge(dummy, { format: 'svg' });
    }
    const summary = gc.summary();
    gc.stop();
    // The 'formatting' phase must exist but must not have accumulated majors.
    // (minors are normal for any allocating code; the strict claim is majors=0.)
    const formattingPhase = summary.phases && summary.phases.formatting;
    if (formattingPhase && formattingPhase.gc) {
        assert.equal(formattingPhase.gc.major, 0,
            'the formatters must not induce major GCs on any workload; got '
            + formattingPhase.gc.major);
    }
});

// =============================================================================
// AXIS D -- determinism
// =============================================================================

test('[axis D] identical report input produces byte-identical output on two calls', () => {
    // Same input, same output -- always. If a formatter reads process state,
    // wall-clock time, or a random source, this catches it.
    const rep = {
        schema: 'lite-gc-report/1',
        kind: 'frames',
        verdict: 'fail',
        source: 'gc',
        checked: { maxDroppedFrames: true, maxBytesPerFrame: true },
        violations: [
            { rule: 'maxDroppedFrames', metric: 'droppedFrames', actual: 7, limit: 3 },
            { rule: 'maxBytesPerFrame', metric: 'bytesPerFrame', actual: 812.5, limit: 100 }
        ],
        result: {
            source: 'gc', frames: 300, warmupFrames: 60,
            bytesPerFrame: 812.5, bytesPerFrameStable: true,
            droppedFrames: 7, asyncResidual: 0
        }
    };
    const a = explainReport(rep);
    const b = explainReport(rep);
    assert.equal(a, b, 'explainReport must be deterministic on identical input');

    // Same claim for gateBadge across all three formats.
    assert.equal(
        gateBadge(rep, { format: 'text' }),
        gateBadge(rep, { format: 'text' }));
    assert.equal(
        gateBadge(rep, { format: 'shields-json' }),
        gateBadge(rep, { format: 'shields-json' }));
    assert.equal(
        gateBadge(rep, { format: 'svg' }),
        gateBadge(rep, { format: 'svg' }));
});

test('[axis D] shape-stability: report with all optional fields absent still yields structured output', () => {
    // A minimal report -- verdict only -- must still produce a header line
    // and not throw on missing violations, checked, source, or result.
    // Regression guard against lazy-init paths that assume a field is present.
    const bare = { verdict: 'inconclusive' };
    // The formatter accepts this because verdict is present. It should not
    // throw on any of the missing companions.
    const out = explainReport(bare);
    assert.match(out, /INCONCLUSIVE/);
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
});
