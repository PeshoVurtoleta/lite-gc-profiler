// Torture tests for Batch 2 (v1.2.0): differential, rep-aware, baseline.
// 17 scenarios: 5 axis-A (inconclusive), 5 axis-B (fail), 4 axis-C (pass),
// 3 axis-D (self-consistency).
//
// Axis A above all: any pass or fail on an adversarial input where the gate
// cannot honestly answer is silent falsification. D4 policy defaults get
// pinned by axis B #1 -- the whole point of D4 gets asserted there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    compareGc, assertCompare,
    aggregateGc, gateReps, assertReps,
    captureFingerprint, createBaseline, checkAgainstBaseline, assertAgainstBaseline,
    checkNoGc,
    GcBudgetError, GcInconclusiveError
} from '../../Gc.js';
import { assertAxisA, assertAxisC, assertAxisD, makeSummary, makePhase } from './harness.mjs';

const dirty = (major, source) => makeSummary(source || 'gc', { gc: { major, count: major, totalMs: major * 5, maxMs: 5 } });
const clean = (source) => makeSummary(source || 'gc');
const pause = (maxMs) => makeSummary('gc', { gc: { maxMs, count: 1, totalMs: maxMs } });
const alloc = (rate, samples) => makeSummary('gc', { heap: { samples, allocRateBytesPerSec: rate } });

// Torture-specific axis helpers -- adapt to differential/rep/baseline report shapes.
function assertAxisA_compare(control, candidate, rules, label) {
    const rep = compareGc(control, candidate, rules);
    if (rep.verdict !== 'inconclusive') {
        assert.fail('AXIS A VIOLATION [' + label + ']: compareGc verdict=' + rep.verdict
            + ' (expected inconclusive on adversarial input).');
    }
    assert.throws(() => assertCompare(control, candidate, rules), GcInconclusiveError, label);
}
function assertAxisA_reps(summaries, rules, label, options) {
    const rep = gateReps(summaries, rules, options);
    if (rep.verdict !== 'inconclusive') {
        assert.fail('AXIS A VIOLATION [' + label + ']: gateReps verdict=' + rep.verdict);
    }
    assert.throws(() => assertReps(summaries, rules, options), GcInconclusiveError, label);
}
function assertAxisA_baseline(currentAgg, baseline, options, label) {
    const rep = checkAgainstBaseline(currentAgg, baseline, options);
    if (rep.verdict !== 'inconclusive') {
        assert.fail('AXIS A VIOLATION [' + label + ']: checkAgainstBaseline verdict=' + rep.verdict);
    }
    assert.throws(() => assertAgainstBaseline(currentAgg, baseline, options), GcInconclusiveError, label);
}

// =============================================================================
// AXIS A -- MUST produce 'inconclusive'
// =============================================================================

test('[axis A] compareGc: source mismatch (gc vs heap)', () => {
    assertAxisA_compare(clean('gc'), clean('heap'), { maxExtraMajor: 0 }, 'gc vs heap');
});

test('[axis A] compareGc: source mismatch (both fake sources)', () => {
    // Same rule verifiable on both individually but sources differ -> inconclusive.
    assertAxisA_compare(clean('none'), clean('gc'), { maxExtraMajor: 0 }, 'none vs gc');
});

test('[axis A] compareGc: maxExtraAllocRate with heap samples on ONE side only', () => {
    const ctl = makeSummary('gc');                                       // 0 samples
    const cnd = makeSummary('gc', { heap: { samples: 5, allocRateBytesPerSec: 5000 } });
    assertAxisA_compare(ctl, cnd, { maxExtraAllocRate: 1000 }, 'alloc rate needs samples on both sides');
});

test('[axis A] gateReps: mixed sources across reps', () => {
    const reps = [clean('gc'), clean('heap'), clean('gc'), clean('gc')];
    assertAxisA_reps(reps, { maxMajor: 0 }, 'mixed sources');
});

test('[axis A] checkAgainstBaseline: fingerprint mismatch defaults to inconclusive', () => {
    const agg = aggregateGc([clean(), clean(), clean()]);
    const baseline = createBaseline(agg);
    // Pretend baseline came from a different machine.
    baseline.fingerprint = { node: 'v20.0.0', v8: '0.0.0', platform: 'aix', arch: 'ppc64', cpu: 'Ancient CPU' };
    assertAxisA_baseline(agg, baseline, undefined, 'fingerprint mismatch');
});

// =============================================================================
// AXIS B -- MUST produce 'fail'
// =============================================================================

test('[axis B] rep policy pin: single dirty rep among nine clean under all-clean majors -> fail', () => {
    // This is THE test that anchors D4. If it ever passes, the 'all-clean' default
    // has silently become 'best-clean' or 'median', and every user "zero major"
    // claim across the ecosystem gets weaker.
    const reps = [clean(), clean(), clean(), clean(), clean(), clean(), clean(), clean(), clean(), dirty(1)];
    const rep = gateReps(reps, { maxMajor: 0 });
    assert.equal(rep.verdict, 'fail', 'D4 default all-clean for majors must fail on any dirty rep');
    assert.equal(rep.policy.maxMajor, 'all-clean', 'D4 policy default must be all-clean for maxMajor');
    assert.equal(rep.violations[0].actual, 1);
    assert.throws(() => assertReps(reps, { maxMajor: 0 }), GcBudgetError);
});

test('[axis B] rep policy pin: best-clean pauses, best rep NOT clean -> fail', () => {
    // If the best rep still exceeds the pause limit, best-clean fails.
    const reps = [pause(6.0), pause(6.0), pause(5.1), pause(6.0)];
    const rep = gateReps(reps, { maxPauseMs: 5.0 });
    assert.equal(rep.verdict, 'fail');
    assert.equal(rep.policy.maxPauseMs, 'best-clean');
    // The min was 5.1 (still > 5.0)
    assert.ok(Math.abs(rep.violations[0].actual - 5.1) < 0.01);
});

test('[axis B] compareGc: harness-noise vs real-signal (delta detects even when absolute noisy)', () => {
    // Control has 3 majors (harness noise). Candidate has 4 majors (harness + 1).
    // Absolute maxMajor:0 rule would fail both; the differential isolates the +1.
    const ctl = dirty(3);
    const cnd = dirty(4);
    const rep = compareGc(ctl, cnd, { maxExtraMajor: 0 });
    assert.equal(rep.verdict, 'fail', 'delta of 1 major must be caught even when absolute is noisy');
    assert.equal(rep.violations[0].actual, 1);
});

test('[axis B] baseline regression: current.median > baseline.max', () => {
    // Baseline captured with maxMs at (2, 2, 2). Current: (3, 5, 5). median=5, max=5.
    // baseline.max=2. Current.median (5) > baseline.max (2) -> fail.
    const baselineReps = [pause(2.0), pause(2.0), pause(2.0)];
    const baseline = createBaseline(aggregateGc(baselineReps));
    const currentReps = [pause(3.0), pause(5.0), pause(5.0)];
    const rep = checkAgainstBaseline(aggregateGc(currentReps), baseline);
    assert.equal(rep.verdict, 'fail');
    const v = rep.violations.find((x) => x.metric === 'gc.maxMs');
    assert.ok(v);
});

test('[axis B] fail beats inconclusive in gateReps: verifiable violation + unverifiable rule', () => {
    // maxMajor is verifiable (source=gc, has evidence). maxAllocRate needs heap
    // samples that aren't present. Verdict must be fail (evidence wins), not
    // inconclusive.
    const reps = [clean(), dirty(1)];   // maxMajor: 1 in one rep, 0 in other
    const rep = gateReps(reps, { maxMajor: 0, maxAllocRate: 1000 });
    assert.equal(rep.verdict, 'fail');
    assert.equal(rep.checked.maxMajor, true);
    assert.equal(rep.checked.maxAllocRate, false);
});

// =============================================================================
// AXIS C -- MUST produce 'pass'
// =============================================================================

test('[axis C] rep policy pin: pause varies 2x across reps but no majors -> pass under defaults', () => {
    // Reps: pause values [1, 2, 1.5, 2, 1] (2x variance) + all clean of majors.
    // best-clean pauses picks min=1, well under maxPauseMs:5 -> pass.
    // all-clean majors: max=0, satisfies maxMajor:0 -> pass.
    const reps = [
        makeSummary('gc', { gc: { maxMs: 1.0, totalMs: 1.0, count: 1 } }),
        makeSummary('gc', { gc: { maxMs: 2.0, totalMs: 2.0, count: 1 } }),
        makeSummary('gc', { gc: { maxMs: 1.5, totalMs: 1.5, count: 1 } }),
        makeSummary('gc', { gc: { maxMs: 2.0, totalMs: 2.0, count: 1 } }),
        makeSummary('gc', { gc: { maxMs: 1.0, totalMs: 1.0, count: 1 } })
    ];
    const rep = gateReps(reps, { maxMajor: 0, maxPauseMs: 5 });
    assert.equal(rep.verdict, 'pass', 'realistic 2x pause variance under defaults must pass');
    assert.equal(rep.violations.length, 0);
});

test('[axis C] compareGc interleaving contract: control and candidate at different wallclock times', () => {
    // The "interleaving contract" is a discipline the harness enforces; the
    // gate itself just compares. Two summaries with same source and same
    // metrics should compare pass regardless of when they were captured.
    const ctl = { ...clean('gc'), _capturedAt: 'T0' };
    const cnd = { ...clean('gc'), _capturedAt: 'T+30min' };
    const rep = compareGc(ctl, cnd, { maxExtraMajor: 0 });
    assert.equal(rep.verdict, 'pass');
});

test('[axis C] baseline: same-machine round-trip preserves pass', () => {
    const agg = aggregateGc([clean(), clean(), clean()]);
    const baseline = createBaseline(agg);
    // Fingerprints will match because both were captured in the same process.
    const rep = checkAgainstBaseline(agg, baseline);
    assert.equal(rep.verdict, 'pass');
});

test('[axis C] rep policy override honored per-rule', () => {
    // Half the reps are dirty on majors. Under all-clean default, this fails.
    // Under quorum-1 override, one clean rep is enough to pass.
    const reps = [dirty(2), dirty(2), clean(), clean()];
    const rep = gateReps(reps, { maxMajor: 0 }, { policy: { maxMajor: 'quorum-2' } });
    assert.equal(rep.verdict, 'pass', 'quorum-2 override honored: 2 clean reps satisfy');
});

// =============================================================================
// AXIS D -- self-consistency invariants
// =============================================================================

test('[axis D] compareGc(pooled, x) fails iff checkNoGc(x, absoluteRules) fails, when control is zero', () => {
    assertAxisD(() => {
        // With a zero-baseline control, the delta equals the candidate's absolute.
        // So compareGc's fail must match checkNoGc's fail on the same limit.
        const control = clean();
        for (const candidate of [clean(), dirty(1), dirty(3)]) {
            const compareRep = compareGc(control, candidate, { maxExtraMajor: 0 });
            const checkRep = checkNoGc(candidate, { maxMajor: 0 });
            assert.equal(compareRep.verdict, checkRep.verdict,
                'inconsistency: compareGc vs checkNoGc disagreed on candidate.major=' + candidate.gc.major);
        }
        return true;
    }, 'compareGc with zero-control degenerates to checkNoGc');
});

test('[axis D] gateReps aggregate matches manual per-rep verdicts under policy', () => {
    assertAxisD(() => {
        const reps = [clean(), clean(), dirty(1), clean(), clean()];
        const rules = { maxMajor: 0 };
        // Manual: under all-clean, since one rep fails, aggregate must fail.
        const perRepFails = reps.map((r) => checkNoGc(r, rules).verdict === 'fail');
        const anyFail = perRepFails.some((x) => x);
        const aggRep = gateReps(reps, rules);
        // 'all-clean' -> aggregate fails iff any rep fails
        assert.equal(aggRep.verdict === 'fail', anyFail,
            'all-clean policy: aggregate should fail iff any rep does');
        return true;
    }, 'aggregate verdict under all-clean matches per-rep manual reasoning');
});

test('[axis D] baseline round-trip through JSON preserves gate outcomes', () => {
    assertAxisD(() => {
        const agg = aggregateGc([pause(2.0), pause(2.5), pause(3.0)]);
        const baseline = createBaseline(agg);
        const roundTripped = JSON.parse(JSON.stringify(baseline));
        // Same aggregate compared to original vs roundtripped baseline must agree.
        const r1 = checkAgainstBaseline(agg, baseline);
        const r2 = checkAgainstBaseline(agg, roundTripped);
        assert.equal(r1.verdict, r2.verdict, 'JSON round-trip changed the verdict');
        // Fail path
        const worseAgg = aggregateGc([pause(10.0), pause(10.0), pause(10.0)]);
        const r3 = checkAgainstBaseline(worseAgg, baseline);
        const r4 = checkAgainstBaseline(worseAgg, roundTripped);
        assert.equal(r3.verdict, r4.verdict);
        return true;
    }, 'baseline JSON round-trip preserves verdict');
});
