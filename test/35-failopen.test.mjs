// v1.15.0 fail-open hardening. Five edges found by building the GCForge viewer
// against the library, each reproduced before the fix and pinned here after:
//
//   1. a never-started profiler gated GREEN (checkNoGc -> pass on a summary
//      byte-identical to one that ran and saw nothing);
//   2. formatGithubAnnotations emitted "gate passed" on a document with no
//      verdict, while its sibling formatters threw;
//   3. assertNoEscapes accepted null / {} / a report with no escapes array,
//      reading a MISSING measurement as clean;
//   4. ratchetBaseline handed back the (invalid) first argument under the
//      `baseline` key, so a swapped-in aggregate could be written as a baseline;
//   5. formatJson enveloped arbitrary non-report objects (profiler internals)
//      as a valid lite-gc-report/1, and formatMarkdown/console crashed with an
//      opaque V8 message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    GcProfiler, checkNoGc, assertNoGc,
    GcBudgetError, GcInconclusiveError,
    formatConsole, formatJson, formatMarkdown, formatGithubAnnotations,
    aggregateGc, createBaseline, ratchetBaseline,
    assertNoEscapes, GcPoolEscapeError, GC_MAJOR
} from '../Gc.js';

// A fully-populated, hand-built lite-gc/1 summary. `observed` defaults to true
// so it gates like a real run; pass observed:false / omit it to exercise the
// legacy and unobserved paths explicitly.
function summaryLike(over) {
    const s = {
        schema: 'lite-gc/1', source: 'gc', supported: true, observed: true,
        gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, p99Ms: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 },
        heap: { supported: true, used: 0, peak: 0, firstSample: 0, samples: 0, allocBytes: 0, allocRateBytesPerSec: 0, gcDrops: 0, freedBytes: 0 },
        frames: { count: 0, long: 0 }, phases: {}
    };
    if (over) Object.assign(s, over);
    return s;
}

// ===========================================================================
// 1. A never-started profiler is inconclusive, not a green pass.
// ===========================================================================

test('a pristine profiler reports observed:false', () => {
    assert.equal(new GcProfiler().summary().observed, false);
});

test('start() marks the profiler observed, even if it saw nothing', () => {
    const gc = new GcProfiler().start();
    assert.equal(gc.summary().observed, true);
    gc.stop();
});

test('checkNoGc on a never-started summary is inconclusive with reason not_observed', () => {
    const r = checkNoGc(new GcProfiler().summary(), { maxMajor: 0, maxPauseMs: 4, maxTotalMs: 10 });
    assert.equal(r.verdict, 'inconclusive');
    assert.equal(r.reason, 'not_observed');
    assert.equal(r.ok, false);
    // Every rule the caller set is reported unverifiable, not silently verified.
    assert.equal(r.checked.maxMajor, false);
    assert.equal(r.checked.maxPauseMs, false);
});

test('assertNoGc on a never-started summary throws GcInconclusiveError, never green', () => {
    assert.throws(() => assertNoGc(new GcProfiler().summary()),
        (e) => e instanceof GcInconclusiveError && /not.?observed|start/i.test(e.message));
});

test('a started, genuinely clean run still passes', () => {
    const gc = new GcProfiler().start();
    const r = checkNoGc(gc.summary(), { maxMajor: 0 });
    gc.stop();
    assert.equal(r.verdict, 'pass');
});

test('a record()-only profiler is observed and gates on its synthetic data', () => {
    const gc = new GcProfiler();
    gc.record(GC_MAJOR, 20);                       // synthetic, start()-exempt
    assert.equal(gc.summary().observed, true);
    assert.equal(checkNoGc(gc.summary(), { maxMajor: 0 }).verdict, 'fail');
});

test('a phase()-only profiler is observed (a declared empty phase is a real measurement)', () => {
    const gc = new GcProfiler();
    gc.phase('warmup');
    assert.equal(gc.summary().observed, true);
    assert.equal(checkNoGc(gc.summary(), { maxMajor: 0 }).verdict, 'pass');
});

test('a legacy/hand-built summary (no observed field) is unaffected -- back-compat', () => {
    // observed === undefined must NOT be treated as false.
    const s = summaryLike(); delete s.observed;
    assert.equal(checkNoGc(s, { maxMajor: 0 }).verdict, 'pass');
});

test('the never-observed short-circuit still scopes phase and region rules to false', () => {
    const r = checkNoGc(new GcProfiler().summary(), {
        maxMajor: 0,
        phases: { steady: { maxMajor: 0 } },
        perRegion: { drain: { maxMajor: 0 } }
    });
    assert.equal(r.verdict, 'inconclusive');
    assert.equal(r.checkedByPhase.steady.maxMajor, false);
    assert.equal(r.checkedByRegion.drain.maxMajor, false);
});

// ===========================================================================
// 2. formatGithubAnnotations no longer green-lights a document with no verdict.
// ===========================================================================

test('formatGithubAnnotations throws on a document with no verdict, like its siblings', () => {
    assert.throws(() => formatGithubAnnotations(summaryLike()), TypeError);
});

test('formatGithubAnnotations still annotates real verdicts', () => {
    assert.match(formatGithubAnnotations(checkNoGc(summaryLike(), { maxMajor: 0 })), /::notice.*gate passed/);
    const fail = checkNoGc(summaryLike({ gc: { major: 2, count: 2, totalMs: 10, maxMs: 5, minor: 0, incremental: 0, weakcb: 0, avgMs: 5, p99Ms: 5 } }), { maxMajor: 0 });
    assert.match(formatGithubAnnotations(fail), /::error/);
});

// ===========================================================================
// 5. The three text formatters reject a non-report with a named error.
// ===========================================================================

for (const [name, fn] of [['formatConsole', formatConsole], ['formatJson', formatJson], ['formatMarkdown', formatMarkdown]]) {
    test(name + ' throws a named TypeError on a non-report (no verdict)', () => {
        assert.throws(() => fn(summaryLike()),
            (e) => e instanceof TypeError && new RegExp(name).test(e.message) && /verdict/.test(e.message));
    });
    test(name + ' still formats a real gate report', () => {
        assert.doesNotThrow(() => fn(checkNoGc(summaryLike(), { maxMajor: 0 })));
    });
}

test('formatJson does not envelope a non-report as a valid lite-gc-report/1', () => {
    assert.throws(() => formatJson({ _private: 'engine internals' }), TypeError);
});

// ===========================================================================
// 3. assertNoEscapes rejects a non-report, but still never throws on an empty
//    (valid) report -- the documented "absence is advisory" law is preserved.
// ===========================================================================

for (const bad of [null, undefined, {}, { escapes: null }, { escapeCount: 0 }]) {
    test('assertNoEscapes throws TypeError on a non-report: ' + JSON.stringify(bad), () => {
        assert.throws(() => assertNoEscapes(bad), TypeError);
    });
}

test('assertNoEscapes does NOT throw on a valid empty report (law preserved)', () => {
    assert.doesNotThrow(() => assertNoEscapes({ available: true, escapes: [], escapeCount: 0, note: 'advisory' }));
});

test('assertNoEscapes does NOT throw on a valid unavailable report', () => {
    assert.doesNotThrow(() => assertNoEscapes({ available: false, reason: 'no_gc', escapes: [], note: 'advisory' }));
});

test('assertNoEscapes still throws GcPoolEscapeError on a real escape', () => {
    assert.throws(() => assertNoEscapes({ available: true, escapes: [{ slot: 7 }], escapeCount: 1, label: 'p' }),
        (e) => e instanceof GcPoolEscapeError);
});

// ===========================================================================
// 4. ratchetBaseline returns baseline:null on an invalid baseline, never the
//    mis-passed input echoed back under the baseline key.
// ===========================================================================

test('ratchetBaseline with swapped args returns baseline:null, not the aggregate', () => {
    const agg = aggregateGc([new GcProfiler().start().summary()]);
    const baseline = createBaseline(agg);
    const swapped = ratchetBaseline(agg, baseline);       // args in the wrong order
    assert.equal(swapped.ratcheted, false);
    assert.equal(swapped.reason, 'invalid_baseline');
    assert.equal(swapped.baseline, null);
    assert.notEqual(swapped.baseline, agg);
});

test('ratchetBaseline in the correct order still returns a real baseline', () => {
    const agg = aggregateGc([new GcProfiler().start().summary()]);
    const baseline = createBaseline(agg);
    const r = ratchetBaseline(baseline, agg);
    assert.equal(r.baseline.schema, 'lite-gc-baseline/1');
});
