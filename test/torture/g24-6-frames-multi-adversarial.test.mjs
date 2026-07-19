// G24.6 -- adversarial pass over the multi-context FRAMES lane (v1.8.0).
//
// The frames lane carries the v1.7.0 lesson correctly: unknown propagates as
// unknown through both the frames-weighted rates and the droppedFrames SUM, so
// an unmeasurable context can neither dilute a rate nor vanish from a total.
// These pin that, plus the one metric where the rule did not hold.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    aggregateFrameReports, checkAggregateFramesReport, aggregateWorkerReports
} from '../../Gc.js';

const F = (o) => ({
    schema: 'lite-gc-frames/1', frames: 600, source: 'gc', bytesPerFrame: 100,
    bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 2,
    maxPauseMsPerFrame: 0.5, droppedFrames: 3, asyncResidual: 0, ...o
});
const O = () => ({
    schema: 'lite-gc-ops/1', ops: 1000, source: 'gc', bytesPerOp: 10,
    bytesPerOpStable: true, majorsPerKOp: 0, minorsPerKOp: 1, maxPauseMsPerOp: 0.01
});

test('[axis AD] a corrupt residual reading is not folded in as zero', () => {
    // asyncResidual is a smoke signal, so an ABSENT value legitimately counts
    // as zero -- a lane that does not track it has no residual. But a PRESENT
    // non-finite value is a broken reading, and summing it as zero made the
    // aggregate under-report precisely when something was wrong: one context
    // with NaN residual beside one reporting 1000 summed to 1000, reading as
    // if nothing were unaccounted for.
    const absent = aggregateFrameReports([F({ asyncResidual: undefined }), F({ asyncResidual: 1000 })]).aggregate;
    assert.equal(absent.asyncResidual, 1000, 'an absent residual must still count as zero');

    for (const bad of [NaN, Infinity, -Infinity]) {
        const a = aggregateFrameReports([F({ asyncResidual: bad }), F({ asyncResidual: 1000 })]).aggregate;
        assert.equal(a.asyncResidual, null,
            'residual ' + String(bad) + ' summed to ' + a.asyncResidual + ' instead of null');
    }
});

test('[axis AD] a dropped-frame SUM cannot lose a context silently', () => {
    for (const bad of [NaN, null, undefined, Infinity]) {
        const a = aggregateFrameReports([F({ droppedFrames: bad }), F({ droppedFrames: 3 })]).aggregate;
        assert.equal(a.droppedFrames, null, 'droppedFrames ' + String(bad) + ' -> ' + a.droppedFrames);
    }
    const good = aggregateFrameReports([F({ droppedFrames: 6 }), F({ droppedFrames: 6 })]);
    assert.equal(good.aggregate.droppedFrames, 12, 'SUM, not mean');
    assert.equal(checkAggregateFramesReport(good, { maxDroppedFrames: 10 }).verdict, 'fail');
});

test('[axis AD] an unmeasurable context cannot dilute a frames-weighted rate', () => {
    for (const bad of [NaN, null, undefined, Infinity]) {
        const a = aggregateFrameReports([F({ majorsPerKFrame: bad }), F({ majorsPerKFrame: 4 })]).aggregate;
        assert.equal(a.majorsPerKFrame, null);
        const b = aggregateFrameReports([F({ bytesPerFrame: bad }), F({ bytesPerFrame: 100 })]).aggregate;
        assert.equal(b.bytesPerFrame, null);
        const c = aggregateFrameReports([F({ maxPauseMsPerFrame: bad }), F({ maxPauseMsPerFrame: 9 })]).aggregate;
        assert.equal(c.maxPauseMsPerFrame, null);
    }
    const multi = aggregateFrameReports([F({ majorsPerKFrame: NaN }), F({ majorsPerKFrame: 0 })]);
    const rep = checkAggregateFramesReport(multi, { maxMajorsPerKFrame: 0 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checked.maxMajorsPerKFrame, false);
});

test('[axis AD] a mixed stability set does not claim stability', () => {
    assert.equal(aggregateFrameReports([
        F({ bytesPerFrameStable: undefined }), F({ bytesPerFrameStable: undefined })]).aggregate.bytesPerFrameStable,
        true, 'all-legacy has nothing to degrade');
    assert.equal(aggregateFrameReports([
        F({ bytesPerFrameStable: undefined }), F({ bytesPerFrameStable: true })]).aggregate.bytesPerFrameStable,
        false, 'mixed presence is unknown provenance');
});

test('[axis AE] the two aggregation lanes cannot be crossed', () => {
    // A frames report has no `ops` and an ops report has no `frames`; feeding
    // one to the other must fail at the boundary naming the missing field,
    // not aggregate a nonsense mixture.
    assert.throws(() => aggregateWorkerReports([F({})]), /reports\[0\]\.ops/);
    assert.throws(() => aggregateFrameReports([O()]), /reports\[0\]\.frames/);
    assert.throws(() => aggregateFrameReports([F({}), O()]), /reports\[1\]\.frames/);
});

test('[axis AE] hostile inputs are rejected at the boundary', () => {
    assert.throws(() => aggregateFrameReports([]), RangeError);
    assert.throws(() => aggregateFrameReports({}), TypeError);
    assert.throws(() => aggregateFrameReports([null]), TypeError);
    for (const bad of [0, -5, NaN, Infinity, '600']) {
        assert.throws(() => aggregateFrameReports([F({ frames: bad })]), TypeError, 'frames=' + String(bad));
    }
    assert.throws(() => aggregateFrameReports([F({ source: 42 })]), TypeError);
    const ok = aggregateFrameReports([F({})]);
    assert.throws(() => checkAggregateFramesReport(ok, { maxBytesPerFrames: 1 }), TypeError);
    assert.throws(() => checkAggregateFramesReport(ok, { maxBytesPerFrame: NaN }), RangeError);
    assert.throws(() => checkAggregateFramesReport(ok, { maxBytesPerOp: 1 }), TypeError,
        'an ops rule is not part of the frames vocabulary');
});

test('[axis AE] structural properties hold', () => {
    const A = F({ frames: 1234, bytesPerFrame: 7 });
    const B = F({ frames: 99, bytesPerFrame: 1e5 });
    const C = F({ frames: 5, bytesPerFrame: 1 });
    const snapshot = JSON.stringify([A, B, C]);
    assert.equal(aggregateFrameReports([A, B, C]).aggregate.bytesPerFrame,
                 aggregateFrameReports([C, B, A]).aggregate.bytesPerFrame, 'order-dependent');
    assert.equal(JSON.stringify([A, B, C]), snapshot, 'inputs mutated');

    let reads = 0;
    const sneaky = {
        schema: 'lite-gc-frames/1', frames: 600, source: 'gc', bytesPerFrameStable: true,
        majorsPerKFrame: 0, minorsPerKFrame: 2, maxPauseMsPerFrame: 0.5,
        droppedFrames: 0, asyncResidual: 0,
        get bytesPerFrame() { reads++; return reads === 1 ? 1 : 1e9; }
    };
    assert.equal(aggregateFrameReports([sneaky]).aggregate.bytesPerFrame, 1);
    assert.equal(reads, 1, 'metric read ' + reads + ' times');
});

test('[axis AE] an overflowing aggregate and a mixed source both stay inconclusive', () => {
    const ov = aggregateFrameReports([
        F({ frames: 2, bytesPerFrame: 1e308 }), F({ frames: 2, bytesPerFrame: 1e308 })]);
    assert.ok(!Number.isFinite(ov.aggregate.bytesPerFrame));
    assert.equal(checkAggregateFramesReport(ov, { maxBytesPerFrame: 10 }).verdict, 'inconclusive');

    const mixed = aggregateFrameReports([F({ source: 'gc' }), F({ source: 'none' })]);
    assert.equal(mixed.aggregate.source, 'mixed');
    const rep = checkAggregateFramesReport(mixed, { maxBytesPerFrame: 1 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.reason, 'source_mismatch');
});
