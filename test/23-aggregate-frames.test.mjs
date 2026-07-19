// Standard-case tests for the multi-context frame aggregation primitives
// introduced in Batch 11 (v1.8.0, G23): aggregateFrameReports,
// checkAggregateFramesReport, assertAggregateFramesReport. Adversarial cases
// live in test/torture/g24-5-frames-multi.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    measureFrames,
    aggregateFrameReports, checkAggregateFramesReport, assertAggregateFramesReport,
    GcBudgetError, GcInconclusiveError
} from '../Gc.js';

const noop = (i) => i | 0;
const fastSched = (cb) => setTimeout(cb, 0);

// -----------------------------------------------------------------------------
// aggregateFrameReports: shape and weighted aggregation
// -----------------------------------------------------------------------------

test('aggregateFrameReports: returns lite-gc-frames-multi/1 shape', async () => {
    const r1 = await measureFrames(noop, { frames: 60, warmup: 10, scheduler: fastSched });
    const r2 = await measureFrames(noop, { frames: 60, warmup: 10, scheduler: fastSched });
    const multi = aggregateFrameReports([r1, r2]);
    assert.equal(multi.schema, 'lite-gc-frames-multi/1');
    assert.equal(multi.kind, 'frames-multi');
    assert.equal(multi.contexts, 2);
    assert.ok(multi.aggregate);
    assert.equal(multi.aggregate.totalFrames, 120);
    assert.equal(multi.aggregate.source, 'gc');
    assert.equal(typeof multi.aggregate.droppedFrames, 'number');
    assert.equal(typeof multi.aggregate.asyncResidual, 'number');
});

test('aggregateFrameReports: perContext is a defensive copy', async () => {
    const r = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const inputs = [r];
    const multi = aggregateFrameReports(inputs);
    multi.perContext.push({ frames: 999 });
    assert.equal(inputs.length, 1, 'input array must not gain elements');
});

test('aggregateFrameReports: bytesPerFrame is frames-weighted, not arithmetic mean', () => {
    // ctx A: 10 B/frame * 100 frames = 1000 bytes
    // ctx B: 20 B/frame * 400 frames = 8000 bytes
    // total: 9000 B / 500 frames = 18.0 B/frame (weighted)
    // naive mean would be 15.0 -- wrong
    const rA = { frames: 100, source: 'gc', bytesPerFrame: 10,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 0, asyncResidual: 0 };
    const rB = { frames: 400, source: 'gc', bytesPerFrame: 20,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 0, asyncResidual: 0 };
    const multi = aggregateFrameReports([rA, rB]);
    assert.equal(multi.aggregate.bytesPerFrame, 18,
        'weighted average must be 18, not 15');
    assert.equal(multi.aggregate.totalFrames, 500);
});

test('aggregateFrameReports: majorsPerKFrame is frames-weighted correctly', () => {
    const rA = { frames: 200, source: 'gc', bytesPerFrame: 0,
                 bytesPerFrameStable: true, majorsPerKFrame: 5, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 0, asyncResidual: 0 };
    const rB = { frames: 800, source: 'gc', bytesPerFrame: 0,
                 bytesPerFrameStable: true, majorsPerKFrame: 10, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 0, asyncResidual: 0 };
    const multi = aggregateFrameReports([rA, rB]);
    // (5/1000 * 200 + 10/1000 * 800) / 1000 * 1000 = (1 + 8) = 9
    assert.ok(Math.abs(multi.aggregate.majorsPerKFrame - 9) < 1e-9,
        'frames-weighted rate must be 9/1000; got ' + multi.aggregate.majorsPerKFrame);
});

test('aggregateFrameReports: maxPauseMsPerFrame is MAX across contexts', () => {
    const rA = { frames: 100, source: 'gc', bytesPerFrame: 0,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 2.5, droppedFrames: 0, asyncResidual: 0 };
    const rB = { frames: 100, source: 'gc', bytesPerFrame: 0,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 12.3, droppedFrames: 0, asyncResidual: 0 };
    const rC = { frames: 100, source: 'gc', bytesPerFrame: 0,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 7.8, droppedFrames: 0, asyncResidual: 0 };
    const multi = aggregateFrameReports([rA, rB, rC]);
    assert.equal(multi.aggregate.maxPauseMsPerFrame, 12.3);
});

test('aggregateFrameReports: droppedFrames is SUM across contexts', () => {
    // Drops accumulate cumulatively -- three contexts each dropping 4 frames
    // is 12 dropped frames system-wide, not "an average of 4."
    const rA = { frames: 100, source: 'gc', bytesPerFrame: 0,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 4, asyncResidual: 0 };
    const rB = { frames: 100, source: 'gc', bytesPerFrame: 0,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 4, asyncResidual: 0 };
    const rC = { frames: 100, source: 'gc', bytesPerFrame: 0,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 4, asyncResidual: 0 };
    const multi = aggregateFrameReports([rA, rB, rC]);
    assert.equal(multi.aggregate.droppedFrames, 12,
        'droppedFrames must sum, not average');
});

test('aggregateFrameReports: asyncResidual is SUM across contexts', () => {
    const rA = { frames: 60, source: 'gc', bytesPerFrame: 0,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 0, asyncResidual: 1024 };
    const rB = { frames: 60, source: 'gc', bytesPerFrame: 0,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 0, asyncResidual: 2048 };
    const multi = aggregateFrameReports([rA, rB]);
    assert.equal(multi.aggregate.asyncResidual, 3072);
});

// -----------------------------------------------------------------------------
// frameTimes is DROPPED from aggregate -- documented decision
// -----------------------------------------------------------------------------

test('aggregateFrameReports: frameTimes percentiles are NOT in the aggregate', async () => {
    // Per-context frameTimes hold p50/p95/p99/max, but a system-wide
    // percentile cannot be reconstructed from those summary numbers. The
    // aggregate deliberately drops the field rather than inventing a
    // number.
    const r1 = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const r2 = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    assert.ok(r1.frameTimes, 'per-context reports still have frameTimes');
    const multi = aggregateFrameReports([r1, r2]);
    assert.equal(multi.aggregate.frameTimes, undefined,
        'aggregate deliberately omits frameTimes -- percentiles are not compositional');
});

test('aggregateFrameReports: perContext preserves each frameTimes for per-context inspection', async () => {
    // Users who need distribution stats can still get them per-context
    // from perContext[i].frameTimes.
    const r1 = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const r2 = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const multi = aggregateFrameReports([r1, r2]);
    assert.ok(multi.perContext[0].frameTimes);
    assert.ok(multi.perContext[1].frameTimes);
});

// -----------------------------------------------------------------------------
// bytesPerFrameStable: nuanced AND with provenance
// -----------------------------------------------------------------------------

test('aggregateFrameReports: bytesPerFrameStable is true when all contexts report true', async () => {
    const r1 = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const r2 = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    assert.equal(r1.bytesPerFrameStable, true);
    assert.equal(r2.bytesPerFrameStable, true);
    const multi = aggregateFrameReports([r1, r2]);
    assert.equal(multi.aggregate.bytesPerFrameStable, true);
});

test('aggregateFrameReports: bytesPerFrameStable is false if ANY context reports false', () => {
    const rA = { frames: 60, source: 'gc', bytesPerFrame: 10,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 0, asyncResidual: 0 };
    const rB = { frames: 60, source: 'gc', bytesPerFrame: 10,
                 bytesPerFrameStable: false, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 0, asyncResidual: 0 };
    const multi = aggregateFrameReports([rA, rB]);
    assert.equal(multi.aggregate.bytesPerFrameStable, false,
        'one unstable context must degrade the aggregate flag');
});

test('aggregateFrameReports: mixed presence/absence of stability flag yields false', () => {
    // Some contexts report the flag, others do not. Silence from a lane
    // that could report is unknown provenance -- do not claim stability.
    const rA = { frames: 60, source: 'gc', bytesPerFrame: 10,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 0, asyncResidual: 0 };
    const rB = { frames: 60, source: 'gc', bytesPerFrame: 10,
                 /* bytesPerFrameStable absent */
                 majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 0, asyncResidual: 0 };
    const multi = aggregateFrameReports([rA, rB]);
    assert.equal(multi.aggregate.bytesPerFrameStable, false,
        'mixed presence of stability flag must yield false');
});

// -----------------------------------------------------------------------------
// Source resolution
// -----------------------------------------------------------------------------

test('aggregateFrameReports: unanimous source is preserved', async () => {
    const r1 = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const r2 = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const multi = aggregateFrameReports([r1, r2]);
    assert.equal(multi.aggregate.source, r1.source);
});

test('aggregateFrameReports: mixed sources yield source="mixed"', async () => {
    const rGc = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const rNone = await measureFrames(noop, { frames: 30, source: 'none', scheduler: fastSched });
    const multi = aggregateFrameReports([rGc, rNone]);
    assert.equal(multi.aggregate.source, 'mixed');
});

// -----------------------------------------------------------------------------
// Dilution guard: unknown metrics propagate
// -----------------------------------------------------------------------------

test('aggregateFrameReports: any null bytesPerFrame propagates to aggregate as null', async () => {
    const rGc = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const rNone = await measureFrames(noop, { frames: 30, source: 'none', scheduler: fastSched });
    const multi = aggregateFrameReports([rGc, rNone]);
    assert.equal(multi.aggregate.bytesPerFrame, null);
});

test('aggregateFrameReports: missing majorsPerKFrame in one context marks aggregate rate unknown', () => {
    // Dilution guard: a missing rate metric does NOT get silently
    // averaged as zero. That would let an unmeasurable context read the
    // whole system cleaner than reality.
    const rWithMajors = { frames: 100, source: 'gc', bytesPerFrame: 10,
                          bytesPerFrameStable: true, majorsPerKFrame: 5, minorsPerKFrame: 2,
                          maxPauseMsPerFrame: 1, droppedFrames: 0, asyncResidual: 0 };
    const rWithoutMajors = { frames: 100, source: 'gc', bytesPerFrame: 10,
                             bytesPerFrameStable: true, /* majorsPerKFrame absent */
                             minorsPerKFrame: 2, maxPauseMsPerFrame: 1,
                             droppedFrames: 0, asyncResidual: 0 };
    const multi = aggregateFrameReports([rWithMajors, rWithoutMajors]);
    assert.equal(multi.aggregate.majorsPerKFrame, null,
        'missing majors in any context must propagate as null');
    // Sibling metrics with full coverage still aggregate normally.
    assert.notEqual(multi.aggregate.minorsPerKFrame, null,
        'sibling with full coverage must still aggregate');
});

test('aggregateFrameReports: missing droppedFrames in one context marks aggregate unknown', () => {
    const rA = { frames: 100, source: 'gc', bytesPerFrame: 0,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 5, asyncResidual: 0 };
    const rB = { frames: 100, source: 'gc', bytesPerFrame: 0,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, /* droppedFrames absent */ asyncResidual: 0 };
    const multi = aggregateFrameReports([rA, rB]);
    assert.equal(multi.aggregate.droppedFrames, null,
        'missing droppedFrames in any context must propagate as null');
});

// -----------------------------------------------------------------------------
// Input validation
// -----------------------------------------------------------------------------

test('aggregateFrameReports: rejects non-array input', () => {
    assert.throws(() => aggregateFrameReports(null), TypeError);
    assert.throws(() => aggregateFrameReports({}), TypeError);
    assert.throws(() => aggregateFrameReports(42), TypeError);
});

test('aggregateFrameReports: rejects empty array', () => {
    assert.throws(() => aggregateFrameReports([]), RangeError);
});

test('aggregateFrameReports: rejects reports missing required fields', () => {
    assert.throws(() => aggregateFrameReports([{ source: 'gc' }]), TypeError);
    assert.throws(() => aggregateFrameReports([{ frames: 0, source: 'gc' }]), TypeError);
    assert.throws(() => aggregateFrameReports([{ frames: NaN, source: 'gc' }]), TypeError);
    assert.throws(() => aggregateFrameReports([{ frames: 100 }]), TypeError);
});

// -----------------------------------------------------------------------------
// checkAggregateFramesReport / assertAggregateFramesReport
// -----------------------------------------------------------------------------

test('checkAggregateFramesReport: pass on clean aggregate against reasonable limit', async () => {
    const r1 = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const r2 = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const multi = aggregateFrameReports([r1, r2]);
    const rep = checkAggregateFramesReport(multi, { maxDroppedFrames: 30 });
    assert.equal(rep.verdict, 'pass');
    assert.equal(rep.kind, 'frames-multi');
});

test('checkAggregateFramesReport: fail on droppedFrames sum over limit', () => {
    const rA = { frames: 100, source: 'gc', bytesPerFrame: 0,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 6, asyncResidual: 0 };
    const rB = { frames: 100, source: 'gc', bytesPerFrame: 0,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 6, asyncResidual: 0 };
    const multi = aggregateFrameReports([rA, rB]);
    // Sum is 12, limit is 10.
    const rep = checkAggregateFramesReport(multi, { maxDroppedFrames: 10 });
    assert.equal(rep.verdict, 'fail');
    assert.equal(rep.violations.length, 1);
    assert.equal(rep.violations[0].rule, 'maxDroppedFrames');
});

test('checkAggregateFramesReport: mixed sources yield inconclusive with source_mismatch', async () => {
    const rGc = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const rNone = await measureFrames(noop, { frames: 30, source: 'none', scheduler: fastSched });
    const multi = aggregateFrameReports([rGc, rNone]);
    const rep = checkAggregateFramesReport(multi, { maxDroppedFrames: 30 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.reason, 'source_mismatch');
});

test('checkAggregateFramesReport: rejects unknown rule keys (v1.5.1 hardening)', async () => {
    const r = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const multi = aggregateFrameReports([r]);
    assert.throws(() => checkAggregateFramesReport(multi, { maxDroppedFrame: 5 }), TypeError);
});

test('checkAggregateFramesReport: rejects non-report inputs', () => {
    assert.throws(() => checkAggregateFramesReport(null, {}), TypeError);
    assert.throws(() => checkAggregateFramesReport({ schema: 'lite-gc-ops-multi/1' }, {}), TypeError);
});

test('assertAggregateFramesReport: returns report on pass', async () => {
    const r1 = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const r2 = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const rep = assertAggregateFramesReport([r1, r2], { maxDroppedFrames: 30 });
    assert.equal(rep.verdict, 'pass');
});

test('assertAggregateFramesReport: throws GcBudgetError on fail', () => {
    const rA = { frames: 100, source: 'gc', bytesPerFrame: 0,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 20, asyncResidual: 0 };
    const rB = { frames: 100, source: 'gc', bytesPerFrame: 0,
                 bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
                 maxPauseMsPerFrame: 0, droppedFrames: 20, asyncResidual: 0 };
    assert.throws(() => assertAggregateFramesReport([rA, rB], { maxDroppedFrames: 10 }),
        GcBudgetError);
});

test('assertAggregateFramesReport: throws GcInconclusiveError on inconclusive', async () => {
    const rGc = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const rNone = await measureFrames(noop, { frames: 30, source: 'none', scheduler: fastSched });
    assert.throws(() => assertAggregateFramesReport([rGc, rNone], { maxDroppedFrames: 30 }),
        GcInconclusiveError);
});
