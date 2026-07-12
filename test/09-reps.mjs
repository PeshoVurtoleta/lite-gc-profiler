// Standard-case tests for rep-aware gating introduced in v1.2.0 (G5).
// Adversarial cases (empty reps, mixed sources with fingerprint drift) live
// in test/torture/g5-5-reps.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    aggregateGc, gateReps, assertReps,
    REP_POLICY_DEFAULTS,
    GcBudgetError, GcInconclusiveError
} from '../Gc.js';

function makeSummary(source, over) {
    const s = {
        schema: 'lite-gc/1', source, supported: source !== 'none',
        gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, p99Ms: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 },
        heap: { supported: source !== 'none', used: 0, peak: 0, firstSample: 0, samples: 0, allocBytes: 0, allocRateBytesPerSec: 0, gcDrops: 0, freedBytes: 0 },
        frames: { count: 0, long: 0 }, phases: {}
    };
    if (over) {
        if (over.gc) Object.assign(s.gc, over.gc);
        if (over.heap) Object.assign(s.heap, over.heap);
    }
    return s;
}

function clean(source) { return makeSummary(source || 'gc'); }
function dirty(major, source) { return makeSummary(source || 'gc', { gc: { major, count: major, totalMs: major * 5, maxMs: 5 } }); }
function pause(maxMs, source) { return makeSummary(source || 'gc', { gc: { maxMs, count: 1, totalMs: maxMs } }); }

// ---- aggregateGc ----

test('aggregateGc: empty input throws', () => {
    // Actually gateReps throws; aggregate throws on non-array
    assert.throws(() => aggregateGc(null), TypeError);
});

test('aggregateGc: single rep -> min=median=max', () => {
    const agg = aggregateGc([dirty(3)]);
    assert.equal(agg.reps, 1);
    assert.equal(agg.gc.major.min, 3);
    assert.equal(agg.gc.major.median, 3);
    assert.equal(agg.gc.major.max, 3);
});

test('aggregateGc: odd rep count -> exact median', () => {
    const agg = aggregateGc([dirty(1), dirty(3), dirty(5)]);
    assert.equal(agg.gc.major.min, 1);
    assert.equal(agg.gc.major.median, 3);
    assert.equal(agg.gc.major.max, 5);
});

test('aggregateGc: even rep count -> averaged median', () => {
    const agg = aggregateGc([dirty(2), dirty(4)]);
    assert.equal(agg.gc.major.median, 3);
});

test('aggregateGc: unique sources tracked', () => {
    const mixed = [clean('gc'), clean('heap'), clean('gc')];
    const agg = aggregateGc(mixed);
    assert.equal(agg.sources.length, 2);
    assert.ok(agg.sources.includes('gc'));
    assert.ok(agg.sources.includes('heap'));
});

test('aggregateGc: pauses aggregate independently', () => {
    const agg = aggregateGc([pause(1.0), pause(2.0), pause(3.0)]);
    assert.equal(agg.gc.maxMs.min, 1.0);
    assert.equal(agg.gc.maxMs.median, 2.0);
    assert.equal(agg.gc.maxMs.max, 3.0);
});

test('aggregateGc: does not mutate the input array', () => {
    const reps = [dirty(5), dirty(1), dirty(3)];
    const before = reps.map((r) => r.gc.major);
    aggregateGc(reps);
    const after = reps.map((r) => r.gc.major);
    assert.deepEqual(before, after);
});

// ---- gateReps: policy defaults (D4) ----

test('policy default: majors -> all-clean (one dirty rep fails)', () => {
    // Nine clean, one with a major. Under D4 default 'all-clean', this fails.
    const reps = [clean(), clean(), clean(), clean(), clean(), clean(), clean(), clean(), clean(), dirty(1)];
    const rep = gateReps(reps, { maxMajor: 0 });
    assert.equal(rep.verdict, 'fail');
    assert.equal(rep.policy.maxMajor, 'all-clean');
});

test('policy default: pauses -> best-clean (worst rep does not fail if best is clean)', () => {
    // One rep has maxMs=1.0 (best-clean), rest are 6.0. Under best-clean policy
    // and maxPauseMs: 4, the best rep (1.0) satisfies the limit -> pass.
    const reps = [pause(6.0), pause(6.0), pause(1.0), pause(6.0)];
    const rep = gateReps(reps, { maxPauseMs: 4 });
    assert.equal(rep.verdict, 'pass');
    assert.equal(rep.policy.maxPauseMs, 'best-clean');
});

test('REP_POLICY_DEFAULTS is exported and covers all rules', () => {
    assert.equal(REP_POLICY_DEFAULTS.maxMajor, 'all-clean');
    assert.equal(REP_POLICY_DEFAULTS.maxMinor, 'all-clean');
    assert.equal(REP_POLICY_DEFAULTS.maxPauseMs, 'best-clean');
    assert.equal(REP_POLICY_DEFAULTS.maxTotalMs, 'best-clean');
    assert.equal(REP_POLICY_DEFAULTS.maxAllocRate, 'best-clean');
});

// ---- gateReps: policy overrides ----

test('policy override: maxMajor -> median', () => {
    // Reps: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1]. Median = 0 (5th of 10, sorted).
    // Actually with 10 sorted values, median is avg of index 4 (0) and 5 (0) = 0.
    // So under 'median' policy, maxMajor:0 passes.
    const reps = [clean(), clean(), clean(), clean(), clean(), clean(), dirty(1), dirty(1), dirty(1), dirty(1)];
    const rep = gateReps(reps, { maxMajor: 0 }, { policy: { maxMajor: 'median' } });
    assert.equal(rep.verdict, 'pass');
    assert.equal(rep.policy.maxMajor, 'median');
});

test('policy override: maxMajor -> quorum-8 requires 8 of 10 clean', () => {
    // 8 clean, 2 dirty. Quorum-8: needs 8 reps with major<=0. 8 clean satisfy.
    const reps = [clean(), clean(), clean(), clean(), clean(), clean(), clean(), clean(), dirty(1), dirty(1)];
    const rep = gateReps(reps, { maxMajor: 0 }, { policy: { maxMajor: 'quorum-8' } });
    assert.equal(rep.verdict, 'pass');
});

test('policy override: quorum-9 requires 9 of 10, only 8 clean -> fail', () => {
    const reps = [clean(), clean(), clean(), clean(), clean(), clean(), clean(), clean(), dirty(1), dirty(1)];
    const rep = gateReps(reps, { maxMajor: 0 }, { policy: { maxMajor: 'quorum-9' } });
    assert.equal(rep.verdict, 'fail');
});

// ---- gateReps: inconclusive paths ----

test('mixed sources across reps -> inconclusive', () => {
    const reps = [clean('gc'), clean('heap'), clean('gc')];
    const rep = gateReps(reps, { maxMajor: 0 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.reason, 'mixed_sources');
    assert.equal(rep.source, 'mixed');
});

test("all reps 'none' + maxMajor:0 -> inconclusive (kind rule unverifiable)", () => {
    const reps = [clean('none'), clean('none'), clean('none')];
    const rep = gateReps(reps, { maxMajor: 0 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checked.maxMajor, false);
});

test("all reps 'heap' + maxAllocRate w/ samples -> verifiable", () => {
    // heap source + samples -> maxAllocRate is verifiable
    const reps = [
        makeSummary('heap', { heap: { samples: 5, allocRateBytesPerSec: 100 } }),
        makeSummary('heap', { heap: { samples: 5, allocRateBytesPerSec: 200 } })
    ];
    const rep = gateReps(reps, { maxAllocRate: 500 });
    assert.equal(rep.verdict, 'pass');
    assert.equal(rep.checked.maxAllocRate, true);
});

// ---- gateReps: report structure ----

test('gateReps report exposes aggregate for downstream inspection', () => {
    const reps = [dirty(1), dirty(2), dirty(3)];
    const rep = gateReps(reps, { maxMajor: 5 });
    assert.equal(rep.aggregate.reps, 3);
    assert.equal(rep.aggregate.gc.major.min, 1);
    assert.equal(rep.aggregate.gc.major.max, 3);
});

test('violations carry policy metadata', () => {
    const reps = [clean(), clean(), dirty(1)];
    const rep = gateReps(reps, { maxMajor: 0 });
    assert.equal(rep.violations[0].policy, 'all-clean');
    assert.equal(rep.violations[0].actual, 1);       // max under all-clean
});

// ---- assertReps ----

test('assertReps throws GcBudgetError on fail', () => {
    assert.throws(
        () => assertReps([clean(), dirty(1)], { maxMajor: 0 }),
        GcBudgetError
    );
});

test('assertReps throws GcInconclusiveError on mixed-source by default', () => {
    assert.throws(
        () => assertReps([clean('gc'), clean('heap')], { maxMajor: 0 }),
        GcInconclusiveError
    );
});

test('assertReps with allowInconclusive:true returns report on mixed-source', () => {
    const rep = assertReps([clean('gc'), clean('heap')], { maxMajor: 0 }, { allowInconclusive: true });
    assert.equal(rep.verdict, 'inconclusive');
});

test('assertReps returns report on pass', () => {
    const rep = assertReps([clean(), clean(), clean()], { maxMajor: 0 });
    assert.equal(rep.verdict, 'pass');
});

// ---- empty input ----

test('gateReps throws on empty array', () => {
    assert.throws(() => gateReps([], { maxMajor: 0 }), TypeError);
});
