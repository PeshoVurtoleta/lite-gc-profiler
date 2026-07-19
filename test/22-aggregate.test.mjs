// Standard-case tests for the multi-context aggregation primitives introduced
// in Batch 10 (v1.7.0, G22): aggregateWorkerReports, checkAggregateReport,
// assertAggregateReport. Adversarial cases live in
// test/torture/g22-5-multi.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    measureOps, measureOpsAsync,
    aggregateWorkerReports, checkAggregateReport, assertAggregateReport,
    GcBudgetError, GcInconclusiveError
} from '../Gc.js';

const noop = (i) => i | 0;
const asyncNoop = async (i) => i | 0;

// -----------------------------------------------------------------------------
// aggregateWorkerReports: shape and weighted aggregation
// -----------------------------------------------------------------------------

test('aggregateWorkerReports: returns lite-gc-ops-multi/1 shape', () => {
    const r1 = measureOps(noop, { ops: 200, warmup: 40, stabilize: true });
    const r2 = measureOps(noop, { ops: 200, warmup: 40, stabilize: true });
    const multi = aggregateWorkerReports([r1, r2]);
    assert.equal(multi.schema, 'lite-gc-ops-multi/1');
    assert.equal(multi.kind, 'ops-multi');
    assert.equal(multi.contexts, 2);
    assert.ok(multi.aggregate);
    assert.equal(multi.aggregate.totalOps, 400);
    assert.equal(multi.aggregate.source, 'gc');
    assert.equal(typeof multi.aggregate.bytesPerOp, 'number');
    // measureOps is the SYNCHRONOUS lane: PerformanceObserver delivers GC
    // entries on event-loop turns and a sync op loop never yields, so its
    // result carries no majorsPerKOp/minorsPerKOp/maxPauseMsPerOp at all.
    // This test used to assert those were numbers -- which they were, because
    // the aggregator treated an absent metric as a contribution of zero and
    // reported majorsPerKOp: 0. That is a number invented from data that was
    // never measured, and a `maxMajorsPerKOp: 0` gate passed on it. Unknown
    // now propagates as null, so the gate says inconclusive instead of green.
    assert.equal(multi.aggregate.majorsPerKOp, null,
        'sync measureOps carries no major-GC rate; the aggregate must not invent one');
    assert.equal(multi.aggregate.minorsPerKOp, null);
    assert.equal(multi.aggregate.maxPauseMsPerOp, null);
});

test('aggregateWorkerReports: metrics the inputs DO carry are still numbers', () => {
    // The mirror of the pin above: when every context reports a metric, the
    // aggregate reports a number, weighted by ops.
    const mk = (ops, majors, minors, pause) => ({
        schema: 'lite-gc-ops/1', ops, source: 'gc', bytesPerOp: 10,
        bytesPerOpStable: true, majorsPerKOp: majors, minorsPerKOp: minors,
        maxPauseMsPerOp: pause
    });
    const multi = aggregateWorkerReports([mk(1000, 2, 10, 0.5), mk(3000, 6, 2, 0.25)]);
    const a = multi.aggregate;
    assert.equal(typeof a.majorsPerKOp, 'number');
    assert.equal(typeof a.minorsPerKOp, 'number');
    assert.equal(typeof a.maxPauseMsPerOp, 'number');
    assert.equal(a.majorsPerKOp, 5, 'weighted: (2*1000 + 6*3000) / 4000');
    assert.equal(a.minorsPerKOp, 4, 'weighted: (10*1000 + 2*3000) / 4000');
    assert.equal(a.maxPauseMsPerOp, 0.5, 'pause is a max, not a mean');
});

test('aggregateWorkerReports: perContext is a defensive copy, not a shared reference', () => {
    const r1 = measureOps(noop, { ops: 100, warmup: 20, stabilize: true });
    const inputs = [r1];
    const multi = aggregateWorkerReports(inputs);
    // Mutating the aggregator's perContext must not touch the caller's array,
    // and vice versa. Prevents downstream code from clobbering an aggregate's
    // provenance.
    multi.perContext.push({ ops: 999 });
    assert.equal(inputs.length, 1, 'input array must not gain elements');
});

test('aggregateWorkerReports: single report round-trips its own values', () => {
    // A single-context aggregate should reflect that context's own numbers.
    // This is the simplest non-trivial case: N=1.
    const r = measureOps(noop, { ops: 300, warmup: 60, stabilize: true });
    const multi = aggregateWorkerReports([r]);
    assert.equal(multi.contexts, 1);
    assert.equal(multi.aggregate.totalOps, 300);
    // bytesPerOp for a single context of ops O with rate B is (B * O) / O = B.
    if (r.bytesPerOp !== null) {
        assert.ok(Math.abs(multi.aggregate.bytesPerOp - r.bytesPerOp) < 1e-9,
            'single-context aggregate bytesPerOp must equal the context\'s own reading');
    }
});

test('aggregateWorkerReports: bytesPerOp is a byte-weighted average, not an arithmetic mean', () => {
    // Two synthetic reports with different ops counts to prove the aggregator
    // uses (totalBytes / totalOps), not (b1 + b2) / 2.
    //   ctx A: 10 bytes/op * 100 ops = 1000 bytes
    //   ctx B: 20 bytes/op * 400 ops = 8000 bytes
    //   total: 9000 bytes / 500 ops = 18.0 bytes/op
    //   naive mean would be 15.0 -- wrong
    const rA = { ops: 100, source: 'gc', bytesPerOp: 10, majorsPerKOp: 0, minorsPerKOp: 0, maxPauseMsPerOp: 0 };
    const rB = { ops: 400, source: 'gc', bytesPerOp: 20, majorsPerKOp: 0, minorsPerKOp: 0, maxPauseMsPerOp: 0 };
    const multi = aggregateWorkerReports([rA, rB]);
    assert.equal(multi.aggregate.bytesPerOp, 18,
        'weighted average must be 18, not 15 (naive mean)');
    assert.equal(multi.aggregate.totalOps, 500);
});

test('aggregateWorkerReports: majorsPerKOp is also ops-weighted correctly', () => {
    // ctx A: 5 majors/1000 ops over 200 ops = 1 major
    // ctx B: 10 majors/1000 ops over 800 ops = 8 majors
    // total: 9 majors / 1000 ops = 9 majors per 1000 ops
    const rA = { ops: 200, source: 'gc', bytesPerOp: 0, majorsPerKOp: 5, minorsPerKOp: 0, maxPauseMsPerOp: 0 };
    const rB = { ops: 800, source: 'gc', bytesPerOp: 0, majorsPerKOp: 10, minorsPerKOp: 0, maxPauseMsPerOp: 0 };
    const multi = aggregateWorkerReports([rA, rB]);
    assert.ok(Math.abs(multi.aggregate.majorsPerKOp - 9) < 1e-9,
        'ops-weighted majors rate must be 9/1000; got ' + multi.aggregate.majorsPerKOp);
});

test('aggregateWorkerReports: maxPauseMsPerOp is the MAX across contexts, not the mean', () => {
    const rA = { ops: 100, source: 'gc', bytesPerOp: 0, majorsPerKOp: 0, minorsPerKOp: 0, maxPauseMsPerOp: 2.5 };
    const rB = { ops: 100, source: 'gc', bytesPerOp: 0, majorsPerKOp: 0, minorsPerKOp: 0, maxPauseMsPerOp: 12.3 };
    const rC = { ops: 100, source: 'gc', bytesPerOp: 0, majorsPerKOp: 0, minorsPerKOp: 0, maxPauseMsPerOp: 7.8 };
    const multi = aggregateWorkerReports([rA, rB, rC]);
    assert.equal(multi.aggregate.maxPauseMsPerOp, 12.3,
        'aggregate pause is the worst pause anywhere in the system');
});

// -----------------------------------------------------------------------------
// bytesPerOpStable: logical AND across contexts
// -----------------------------------------------------------------------------

test('aggregateWorkerReports: bytesPerOpStable ANDs across contexts', async () => {
    // Two async-ops results: one stabilized, one deliberately unstabilized.
    // Aggregate must be flagged false -- the aggregate can only be as
    // trustworthy as its least-trustworthy source.
    const stable = await measureOpsAsync(asyncNoop, { ops: 100, warmup: 20 });
    const unstable = await measureOpsAsync(asyncNoop, { ops: 100, warmup: 20, stabilize: false });
    assert.equal(stable.bytesPerOpStable, true);
    assert.equal(unstable.bytesPerOpStable, false);
    const multi = aggregateWorkerReports([stable, unstable]);
    assert.equal(multi.aggregate.bytesPerOpStable, false,
        'one unstable context must degrade the aggregate flag');
});

test('aggregateWorkerReports: bytesPerOpStable defaults to true when no context reports false', () => {
    // Sync measureOps doesn't emit bytesPerOpStable at all. That is NOT the
    // same as "false" -- the primitive doesn't distinguish. Aggregate stays
    // true.
    const r1 = measureOps(noop, { ops: 100, warmup: 20, stabilize: true });
    const r2 = measureOps(noop, { ops: 100, warmup: 20, stabilize: true });
    assert.equal(r1.bytesPerOpStable, undefined);
    const multi = aggregateWorkerReports([r1, r2]);
    assert.equal(multi.aggregate.bytesPerOpStable, true);
});

// -----------------------------------------------------------------------------
// Source resolution
// -----------------------------------------------------------------------------

test('aggregateWorkerReports: unanimous source is preserved', () => {
    const r1 = measureOps(noop, { ops: 100, warmup: 20, stabilize: true });
    const r2 = measureOps(noop, { ops: 100, warmup: 20, stabilize: true });
    const multi = aggregateWorkerReports([r1, r2]);
    assert.equal(multi.aggregate.source, r1.source);
});

test('aggregateWorkerReports: mixed sources produce source="mixed"', () => {
    const rGc = measureOps(noop, { ops: 100, warmup: 20, source: 'gc' });
    const rNone = measureOps(noop, { ops: 100, source: 'none' });
    const multi = aggregateWorkerReports([rGc, rNone]);
    assert.equal(multi.aggregate.source, 'mixed');
});

// -----------------------------------------------------------------------------
// bytesPerOp null propagation
// -----------------------------------------------------------------------------

test('aggregateWorkerReports: any null bytesPerOp propagates to aggregate as null', () => {
    // A context that couldn't measure memory (source=none) reports
    // bytesPerOp=null. The aggregate can't measure memory either if any
    // context couldn't.
    const rGc = measureOps(noop, { ops: 100, warmup: 20, source: 'gc' });
    const rNone = measureOps(noop, { ops: 100, source: 'none' });
    const multi = aggregateWorkerReports([rGc, rNone]);
    assert.equal(multi.aggregate.bytesPerOp, null,
        'a null bytesPerOp in any context propagates to the aggregate');
});

// -----------------------------------------------------------------------------
// Input validation
// -----------------------------------------------------------------------------

test('aggregateWorkerReports: rejects non-array input', () => {
    assert.throws(() => aggregateWorkerReports(null), TypeError);
    assert.throws(() => aggregateWorkerReports(undefined), TypeError);
    assert.throws(() => aggregateWorkerReports({}), TypeError);
    assert.throws(() => aggregateWorkerReports('reports'), TypeError);
    assert.throws(() => aggregateWorkerReports(42), TypeError);
});

test('aggregateWorkerReports: rejects an empty array', () => {
    assert.throws(() => aggregateWorkerReports([]), RangeError);
});

test('aggregateWorkerReports: rejects reports missing required fields', () => {
    // Missing ops
    assert.throws(() => aggregateWorkerReports([{ source: 'gc' }]), TypeError);
    // ops not positive
    assert.throws(() => aggregateWorkerReports([{ ops: 0, source: 'gc' }]), TypeError);
    assert.throws(() => aggregateWorkerReports([{ ops: -1, source: 'gc' }]), TypeError);
    // ops not finite
    assert.throws(() => aggregateWorkerReports([{ ops: NaN, source: 'gc' }]), TypeError);
    assert.throws(() => aggregateWorkerReports([{ ops: Infinity, source: 'gc' }]), TypeError);
    // Missing source
    assert.throws(() => aggregateWorkerReports([{ ops: 100 }]), TypeError);
});

// -----------------------------------------------------------------------------
// checkAggregateReport / assertAggregateReport
// -----------------------------------------------------------------------------

test('checkAggregateReport: pass on clean aggregate against a reasonable limit', () => {
    const r1 = measureOps(noop, { ops: 200, warmup: 40, stabilize: true });
    const r2 = measureOps(noop, { ops: 200, warmup: 40, stabilize: true });
    const multi = aggregateWorkerReports([r1, r2]);
    const rep = checkAggregateReport(multi, { maxBytesPerOp: 1024 });
    assert.equal(rep.verdict, 'pass');
    assert.equal(rep.kind, 'ops-multi');
});

test('checkAggregateReport: mixed-source aggregate yields inconclusive with source_mismatch', () => {
    const rGc = measureOps(noop, { ops: 100, warmup: 20, source: 'gc' });
    const rNone = measureOps(noop, { ops: 100, source: 'none' });
    const multi = aggregateWorkerReports([rGc, rNone]);
    const rep = checkAggregateReport(multi, { maxBytesPerOp: 5 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.reason, 'source_mismatch');
});

test('checkAggregateReport: fail when the weighted bytesPerOp exceeds the limit', () => {
    // Synthetic: two contexts with a nonzero bytesPerOp; gate with a limit
    // below the weighted average.
    const rA = { ops: 100, source: 'gc', bytesPerOp: 50, majorsPerKOp: 0, minorsPerKOp: 0, maxPauseMsPerOp: 0 };
    const rB = { ops: 100, source: 'gc', bytesPerOp: 150, majorsPerKOp: 0, minorsPerKOp: 0, maxPauseMsPerOp: 0 };
    const multi = aggregateWorkerReports([rA, rB]);
    // weighted avg = (50 * 100 + 150 * 100) / 200 = 100
    const rep = checkAggregateReport(multi, { maxBytesPerOp: 80 });
    assert.equal(rep.verdict, 'fail');
    assert.equal(rep.violations.length, 1);
    assert.equal(rep.violations[0].rule, 'maxBytesPerOp');
});

test('checkAggregateReport: rejects an unknown rule key (v1.5.1 hardening applies)', () => {
    const r = measureOps(noop, { ops: 100, warmup: 20, stabilize: true });
    const multi = aggregateWorkerReports([r]);
    // Typo -- the fail-closed rule validation must fire on aggregate too.
    assert.throws(() => checkAggregateReport(multi, { maxBytesPerOP: 5 }), TypeError);
});

test('checkAggregateReport: rejects a non-report input', () => {
    assert.throws(() => checkAggregateReport(null, {}), TypeError);
    assert.throws(() => checkAggregateReport({}, {}), TypeError);
    // Wrong schema
    assert.throws(() => checkAggregateReport({ schema: 'lite-gc-ops/1' }, {}), TypeError);
});

test('assertAggregateReport: returns report on pass', () => {
    const r1 = measureOps(noop, { ops: 100, warmup: 20, stabilize: true });
    const r2 = measureOps(noop, { ops: 100, warmup: 20, stabilize: true });
    const rep = assertAggregateReport([r1, r2], { maxBytesPerOp: 1024 });
    assert.equal(rep.verdict, 'pass');
});

test('assertAggregateReport: throws GcBudgetError on fail', () => {
    // Synthetic reports guaranteed to fail against a low ceiling.
    const rA = { ops: 100, source: 'gc', bytesPerOp: 500, majorsPerKOp: 0, minorsPerKOp: 0, maxPauseMsPerOp: 0 };
    const rB = { ops: 100, source: 'gc', bytesPerOp: 500, majorsPerKOp: 0, minorsPerKOp: 0, maxPauseMsPerOp: 0 };
    assert.throws(() => assertAggregateReport([rA, rB], { maxBytesPerOp: 10 }), GcBudgetError);
});

test('assertAggregateReport: throws GcInconclusiveError on inconclusive', () => {
    const rGc = measureOps(noop, { ops: 100, warmup: 20, source: 'gc' });
    const rNone = measureOps(noop, { ops: 100, source: 'none' });
    assert.throws(() => assertAggregateReport([rGc, rNone], { maxBytesPerOp: 5 }),
        GcInconclusiveError);
});

test('assertAggregateReport: allowInconclusive passes inconclusive through', () => {
    const rGc = measureOps(noop, { ops: 100, warmup: 20, source: 'gc' });
    const rNone = measureOps(noop, { ops: 100, source: 'none' });
    const rep = assertAggregateReport([rGc, rNone], { maxBytesPerOp: 5 }, { allowInconclusive: true });
    assert.equal(rep.verdict, 'inconclusive');
});
