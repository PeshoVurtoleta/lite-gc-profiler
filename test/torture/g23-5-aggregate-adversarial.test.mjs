// G23.5 -- adversarial pass over the worker-aggregation lane (v1.7.0).
//
// An aggregator's characteristic failure is arithmetic asymmetry: a context's
// `ops` lands in the denominator while its unmeasurable metric is skipped in
// the numerator, so the broken context DILUTES the result toward clean and the
// gate reads better than reality. `bytesPerOp` was written with the right
// discipline -- unknown propagates as unknown -- and its three sibling metrics
// were not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    aggregateWorkerReports, checkAggregateReport, assertAggregateReport,
    measureOps, GcBudgetError, GcInconclusiveError
} from '../../Gc.js';

const rpt = (o) => ({
    schema: 'lite-gc-ops/1', ops: 1000, source: 'gc', bytesPerOp: 10,
    bytesPerOpStable: true, majorsPerKOp: 0, minorsPerKOp: 1,
    maxPauseMsPerOp: 0.01, ...o
});

// ---------------------------------------------------------------------------
// [axis AA] unknown must never dilute
// ---------------------------------------------------------------------------

test('[axis AA] an unmeasurable context cannot dilute a sibling metric toward clean', () => {
    // Measured before the fix: one context with NaN minorsPerKOp beside one
    // clean context at 1.0 produced an aggregate of 0.5 -- the bad context
    // counted in the denominator and contributed nothing to the numerator.
    for (const bad of [NaN, Infinity, -Infinity, null, undefined]) {
        const a = aggregateWorkerReports([rpt({ minorsPerKOp: bad }), rpt({ minorsPerKOp: 1 })]).aggregate;
        assert.equal(a.minorsPerKOp, null,
            'minorsPerKOp ' + String(bad) + ' produced ' + a.minorsPerKOp + ' instead of null');
        const b = aggregateWorkerReports([rpt({ majorsPerKOp: bad }), rpt({ majorsPerKOp: 4 })]).aggregate;
        assert.equal(b.majorsPerKOp, null, 'majorsPerKOp ' + String(bad) + ' -> ' + b.majorsPerKOp);
        const c = aggregateWorkerReports([rpt({ maxPauseMsPerOp: bad }), rpt({ maxPauseMsPerOp: 9 })]).aggregate;
        assert.equal(c.maxPauseMsPerOp, null, 'maxPauseMsPerOp ' + String(bad) + ' -> ' + c.maxPauseMsPerOp);
    }
});

test('[axis AA] a diluted metric gates inconclusive, never green', () => {
    // The consequence that matters: before the fix this reported majorsPerKOp 0
    // and a passing verdict on a context whose majors were never measured.
    const multi = aggregateWorkerReports([rpt({ majorsPerKOp: NaN }), rpt({ majorsPerKOp: 0 })]);
    const rep = checkAggregateReport(multi, { maxMajorsPerKOp: 0 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checked.maxMajorsPerKOp, false, 'must not claim it checked');
    assert.throws(() => assertAggregateReport(
        [rpt({ majorsPerKOp: NaN }), rpt({ majorsPerKOp: 0 })], { maxMajorsPerKOp: 0 }),
        GcInconclusiveError);
});

test('[axis AA] the sync ops lane carries no GC rates and the aggregate must not invent them', () => {
    // measureOps is synchronous; PerformanceObserver delivers on event-loop
    // turns, so the result has no majorsPerKOp/minorsPerKOp/maxPauseMsPerOp.
    // Treating absent as a zero contribution fabricated a clean GC profile.
    const a = aggregateWorkerReports([
        measureOps((i) => i | 0, { ops: 200, warmup: 40, stabilize: true }),
        measureOps((i) => i | 0, { ops: 200, warmup: 40, stabilize: true })
    ]).aggregate;
    assert.equal(a.majorsPerKOp, null);
    assert.equal(a.minorsPerKOp, null);
    assert.equal(a.maxPauseMsPerOp, null);
    assert.equal(typeof a.bytesPerOp, 'number', 'bytesPerOp IS measured on this lane');
});

test('[axis AA] fully-populated inputs still aggregate as weighted numbers', () => {
    const a = aggregateWorkerReports([
        rpt({ ops: 1000, majorsPerKOp: 2, minorsPerKOp: 10, maxPauseMsPerOp: 0.5 }),
        rpt({ ops: 3000, majorsPerKOp: 6, minorsPerKOp: 2, maxPauseMsPerOp: 0.25 })
    ]).aggregate;
    assert.equal(a.majorsPerKOp, 5);
    assert.equal(a.minorsPerKOp, 4);
    assert.equal(a.maxPauseMsPerOp, 0.5, 'pause aggregates as a max, not a mean');
    assert.equal(checkAggregateReport(
        aggregateWorkerReports([rpt({ majorsPerKOp: 9 })]), { maxMajorsPerKOp: 1 }).verdict, 'fail');
});

// ---------------------------------------------------------------------------
// [axis AB] provenance the aggregate cannot show
// ---------------------------------------------------------------------------

test('[axis AB] a mixed stability set does not claim stability', () => {
    // An all-legacy set has nothing to degrade, so absence alone stays true.
    // But when one context reports the flag and another does not, absence is
    // unknown provenance -- claiming true asserts something unverified.
    const allLegacy = aggregateWorkerReports([
        rpt({ bytesPerOpStable: undefined }), rpt({ bytesPerOpStable: undefined })]).aggregate;
    assert.equal(allLegacy.bytesPerOpStable, true, 'all-legacy set must not be degraded');

    const mixed = aggregateWorkerReports([
        rpt({ bytesPerOpStable: undefined }), rpt({ bytesPerOpStable: true })]).aggregate;
    assert.equal(mixed.bytesPerOpStable, false, 'mixed set claimed stability it cannot show');

    const explicit = aggregateWorkerReports([
        rpt({ bytesPerOpStable: false }), rpt({ bytesPerOpStable: true })]).aggregate;
    assert.equal(explicit.bytesPerOpStable, false);
});

// ---------------------------------------------------------------------------
// [axis AC] properties that already held -- pinned so they keep holding
// ---------------------------------------------------------------------------

test('[axis AC] hostile inputs are rejected at the boundary', () => {
    assert.throws(() => aggregateWorkerReports([]), RangeError);
    assert.throws(() => aggregateWorkerReports({}), TypeError);
    assert.throws(() => aggregateWorkerReports([null]), TypeError);
    assert.throws(() => aggregateWorkerReports([rpt({ ops: -1 })]), TypeError);
    assert.throws(() => aggregateWorkerReports([rpt({ ops: NaN })]), TypeError);
    assert.throws(() => aggregateWorkerReports([rpt({ source: 42 })]), TypeError);
    assert.throws(() => checkAggregateReport(aggregateWorkerReports([rpt({})]), { maxBytesPerOP: 1 }), TypeError);
    assert.throws(() => checkAggregateReport(aggregateWorkerReports([rpt({})]), { maxBytesPerOp: NaN }), RangeError);
});

test('[axis AC] a lying getter is observed exactly once', () => {
    let reads = 0;
    const sneaky = {
        schema: 'lite-gc-ops/1', ops: 1000, source: 'gc', bytesPerOpStable: true,
        majorsPerKOp: 0, minorsPerKOp: 1, maxPauseMsPerOp: 0.01,
        get bytesPerOp() { reads++; return reads === 1 ? 1 : 1e9; }
    };
    const a = aggregateWorkerReports([sneaky]).aggregate;
    assert.equal(reads, 1, 'metric read ' + reads + ' times; provenance must be stable');
    assert.equal(a.bytesPerOp, 1);
});

test('[axis AC] aggregation is order-independent and does not mutate its inputs', () => {
    const A = rpt({ ops: 1234, bytesPerOp: 7.3 });
    const B = rpt({ ops: 99, bytesPerOp: 1e5 });
    const C = rpt({ ops: 5, bytesPerOp: 0.1 });
    const snapshot = JSON.stringify([A, B, C]);
    const fwd = aggregateWorkerReports([A, B, C]).aggregate.bytesPerOp;
    const rev = aggregateWorkerReports([C, B, A]).aggregate.bytesPerOp;
    assert.equal(fwd, rev, 'aggregation is order-dependent');
    assert.equal(JSON.stringify([A, B, C]), snapshot, 'inputs were mutated');
});

test('[axis AC] an overflowing aggregate is inconclusive, not a number it cannot stand behind', () => {
    // Finite inputs, non-finite sum: 1e308 * 2 twice overflows the accumulator.
    const multi = aggregateWorkerReports([rpt({ ops: 2, bytesPerOp: 1e308 }), rpt({ ops: 2, bytesPerOp: 1e308 })]);
    assert.ok(!Number.isFinite(multi.aggregate.bytesPerOp));
    assert.equal(checkAggregateReport(multi, { maxBytesPerOp: 1000 }).verdict, 'inconclusive');
});

test('[axis AC] mixed sources refuse to fabricate a comparable verdict', () => {
    const multi = aggregateWorkerReports([rpt({ source: 'gc' }), rpt({ source: 'none' })]);
    assert.equal(multi.aggregate.source, 'mixed');
    const rep = checkAggregateReport(multi, { maxBytesPerOp: 1 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.reason, 'source_mismatch');
});

test('[axis AC] a genuinely over-budget aggregate still fails', () => {
    assert.throws(() => assertAggregateReport(
        [...Array(9)].map(() => rpt({ bytesPerOp: 5 })).concat([rpt({ bytesPerOp: 5000 })]),
        { maxBytesPerOp: 20 }), GcBudgetError);
});
