// -----------------------------------------------------------------------------
// The evidence lane's HINT paths.
//
// explainReport/explainDiff carry a set of rule-specific hints and a per-metric
// comparison table that only render when the report contains concrete evidence
// for them. None of that was executed by the suite, which meant the narrator
// could have been saying anything -- or nothing -- in exactly the situations a
// stranger most needs a sentence of help: an unstabilized reading, a non-zero
// async residual, a comparison across mismatched sources.
//
// These pin what the narration SAYS given specific evidence, not merely that the
// lines run. Every fixture is fed to the real check/compare functions, so a
// report-shape change cannot slip past them.
//
// Note on shapes, because it is not obvious and it decides what can be tested:
// _hints() reads `report.result || report.candidate`, so a hint can only appear
// on a report that carries one of those. checkOpsAsync and checkFrames carry
// `.result`; compareOps carries `.candidate`; checkOps and compareFrames carry
// neither, so hints are structurally unreachable there.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOps, checkOpsAsync, checkFrames, compareOps } from '../Gc.js';
import { explainReport, explainDiff } from '../Explain.js';

const opsResult = (o = {}) => ({
    schema: 'lite-gc-ops/1', ops: 2000, warmupOps: 200, source: 'gc',
    bytesPerOp: 5, opsPerSec: 326255, elapsedMs: 6.13, ...o
});

const opsAsyncResult = (o = {}) => ({
    schema: 'lite-gc-ops-async/1', ops: 200, warmupOps: 20, source: 'gc',
    bytesPerOp: 6.4, bytesPerOpStable: true, majorsPerKOp: 0, minorsPerKOp: 1.4,
    maxPauseMsPerOp: 0.02, asyncResidual: 0, opsPerSec: 41000, elapsedMs: 4.9, ...o
});

const framesResult = (o = {}) => ({
    schema: 'lite-gc-frames/1', frames: 60, warmupFrames: 10, source: 'gc',
    bytesPerFrame: 12.4, bytesPerFrameStable: true, droppedFrames: 0,
    asyncResidual: 0, frameTimes: { p50: 0.31, p95: 0.8, p99: 1.02, max: 1.4 }, ...o
});

// --- hint: an unstabilized ops reading ---------------------------------------

test('hint: bytesPerOpStable:false warns that the number is a raw two-point delta', () => {
    const out = explainReport(
        checkOpsAsync(opsAsyncResult({ bytesPerOpStable: false }), { maxBytesPerOp: 4096 }),
        { color: false });
    assert.match(out, /Hints:/);
    assert.match(out, /raw two-point delta/);
    assert.match(out, /--expose-gc/, 'the hint must name the fix, not just the problem');
});

test('hint: bytesPerOpStable:true stays silent', () => {
    const out = explainReport(
        checkOpsAsync(opsAsyncResult({ bytesPerOpStable: true }), { maxBytesPerOp: 4096 }),
        { color: false });
    assert.doesNotMatch(out, /raw two-point delta/,
        'a stabilized reading must not be told to stabilize');
});

// --- hint: an unstabilized frames reading ------------------------------------

test('hint: bytesPerFrameStable:false names the slope estimate', () => {
    const out = explainReport(
        checkFrames(framesResult({ bytesPerFrameStable: false }), { maxBytesPerFrame: 4096 }),
        { color: false });
    assert.match(out, /slope estimate/);
    assert.match(out, /--expose-gc/);
});

test('hint: bytesPerFrameStable:true stays silent', () => {
    const out = explainReport(
        checkFrames(framesResult(), { maxBytesPerFrame: 4096 }), { color: false });
    assert.doesNotMatch(out, /slope estimate/);
});

// --- async residual: run line AND hint ---------------------------------------

test('async residual > 0 is reported in the Run block and explained in Hints', () => {
    const out = explainReport(
        checkOpsAsync(opsAsyncResult({ asyncResidual: 40952 }), { maxBytesPerOp: 4096 }),
        { color: false });
    assert.match(out, /async residual: 40,?952 bytes/, 'the Run block must carry the number');
    assert.match(out, /fire-and-forget/, 'the hint must explain what a residual means');
    assert.match(out, /Attribution across those boundaries is inexact/,
        'the hint must say the attribution is inexact rather than implying a leak');
});

test('async residual of exactly 0 produces neither the run line nor the hint', () => {
    const out = explainReport(
        checkOpsAsync(opsAsyncResult({ asyncResidual: 0 }), { maxBytesPerOp: 4096 }),
        { color: false });
    assert.doesNotMatch(out, /async residual/);
    assert.doesNotMatch(out, /fire-and-forget/);
});

// --- hint: comparing across mismatched sources -------------------------------

test('hint: a source-mismatched comparison says the deltas are not comparable', () => {
    const report = compareOps(opsResult({ source: 'gc' }), opsResult({ source: 'heap' }),
        { maxExtraBytesPerOp: 10 });
    assert.equal(report.verdict, 'inconclusive');
    assert.equal(report.reason, 'source_mismatch');
    const out = explainReport(report, { color: false });
    assert.match(out, /different sources/);
    assert.match(out, /not comparable/,
        'the narration must say the deltas are meaningless, not merely that sources differ');
    assert.match(out, /same explicit source/, 'and it must name the fix');
});

test('a same-source comparison raises no mismatch hint', () => {
    const out = explainReport(
        compareOps(opsResult(), opsResult({ bytesPerOp: 900 }), { maxExtraBytesPerOp: 10 }),
        { color: false });
    assert.doesNotMatch(out, /different sources/);
});

// --- explainDiff: the per-metric comparison table -----------------------------

test('explainDiff renders a Metrics table with signed deltas', () => {
    const out = explainDiff(
        checkFrames(framesResult(), { maxBytesPerFrame: 9999 }),
        checkFrames(framesResult({ bytesPerFrame: 900, droppedFrames: 7 }), { maxBytesPerFrame: 9999 }));
    assert.match(out, /Metrics:/);
    assert.match(out, /bytesPerFrame\s+control=12\.40\s+candidate=900\s+\(\+887\.60\)/);
    assert.match(out, /droppedFrames\s+control=0\s+candidate=7\s+\(\+7\)/);
});

test('explainDiff marks an improvement with a negative delta, not a bare number', () => {
    const out = explainDiff(
        checkFrames(framesResult({ droppedFrames: 9 }), { maxDroppedFrames: 9999 }),
        checkFrames(framesResult({ droppedFrames: 2 }), { maxDroppedFrames: 9999 }));
    assert.match(out, /droppedFrames\s+control=9\s+candidate=2\s+\(-7\)/,
        'a candidate that dropped fewer frames must read as -7, not 7');
});

test('explainDiff omits the delta when a metric did not move', () => {
    const out = explainDiff(
        checkFrames(framesResult({ droppedFrames: 3 }), { maxDroppedFrames: 9999 }),
        checkFrames(framesResult({ droppedFrames: 3 }), { maxDroppedFrames: 9999 }));
    assert.match(out, /droppedFrames\s+control=3\s+candidate=3\s*$/m,
        'an unchanged metric must not be decorated with (+0)');
});

test('explainDiff skips metrics absent from both sides rather than printing undefined', () => {
    const out = explainDiff(
        checkFrames(framesResult(), { maxBytesPerFrame: 9999 }),
        checkFrames(framesResult({ bytesPerFrame: 900 }), { maxBytesPerFrame: 9999 }));
    assert.doesNotMatch(out, /bytesPerOp\s/, 'an ops metric has no place in a frames diff');
    assert.doesNotMatch(out, /undefined/);
    assert.doesNotMatch(out, /NaN/);
});

// --- structural: reports that cannot carry hints must not pretend to ----------

test('a checkOps report carries no hint section, and says so by omission', () => {
    // checkOps returns neither .result nor .candidate, so _hints() has nothing to
    // read. The pin is that this degrades to silence rather than to a broken or
    // half-rendered Hints block.
    const out = explainReport(
        checkOps(opsResult({ bytesPerOp: 5000 }), { maxBytesPerOp: 50 }), { color: false });
    assert.match(out, /gc-gate:\s+FAIL/);
    assert.doesNotMatch(out, /Hints:/);
    assert.doesNotMatch(out, /undefined|NaN/);
});
