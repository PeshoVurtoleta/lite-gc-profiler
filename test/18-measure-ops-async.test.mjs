// Standard-case tests for the serialized async ops primitives introduced in
// Batch 8 (v1.5.0, G19). Adversarial cases live in
// test/torture/g18-5-ops-async.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    measureOpsAsync, checkOpsAsync, assertOpsAsync,
    compareOpsAsync, assertCompareOpsAsync,
    GcBudgetError, GcInconclusiveError
} from '../Gc.js';

const noopAsync = async (i) => i | 0;
const microtaskAsync = async (i) => { await Promise.resolve(); return i; };

// -----------------------------------------------------------------------------
// measureOpsAsync -- shape and semantics
// -----------------------------------------------------------------------------

test('measureOpsAsync returns the documented shape', async () => {
    const r = await measureOpsAsync(noopAsync, { ops: 200, warmup: 40 });
    assert.equal(r.schema, 'lite-gc-ops-async/1');
    assert.equal(r.ops, 200);
    assert.equal(r.warmupOps, 40);
    assert.ok(r.elapsedMs >= 0);
    assert.ok(r.opsPerSec >= 0);
    assert.ok(r.bytesPerOp === null || typeof r.bytesPerOp === 'number');
    assert.equal(typeof r.bytesPerOpStable, 'boolean');
    assert.equal(typeof r.majorsPerKOp, 'number');
    assert.equal(typeof r.minorsPerKOp, 'number');
    assert.equal(typeof r.maxPauseMsPerOp, 'number');
    assert.equal(typeof r.asyncResidual, 'number');
    assert.ok(r.summary && r.summary.schema === 'lite-gc/1');
});

test('measureOpsAsync: summary has warmup, stabilize, steady phases by default', async () => {
    // Under --expose-gc (the test runner sets it), stabilize defaults ON.
    // That inserts a 'stabilize' phase at the warmup->steady boundary AND
    // at the end. The steady phase is still present and clean of forced GCs.
    const r = await measureOpsAsync(noopAsync, { ops: 100, warmup: 20 });
    assert.ok(r.summary.phases.warmup, 'warmup phase must exist');
    assert.ok(r.summary.phases.stabilize, 'stabilize phase must exist under default stabilize');
    assert.ok(r.summary.phases.steady, 'steady phase must always exist');
});

test('measureOpsAsync: stabilize:false skips the stabilize phase', async () => {
    const r = await measureOpsAsync(noopAsync, { ops: 100, warmup: 20, stabilize: false });
    assert.equal(r.bytesPerOpStable, false,
        'stabilize:false must flag the result as unstabilized');
    // stabilize phase should NOT appear when stabilize is off
    assert.ok(!r.summary.phases.stabilize,
        'stabilize:false must not produce a stabilize phase');
});

test('measureOpsAsync: awaits fn promise before advancing', async () => {
    // Serialization contract -- each op fully drains before the next starts.
    // Prove it with a counter that gets incremented before AND after the await.
    let calls = 0;
    async function asyncFn(i) {
        calls++;
        await Promise.resolve();
        calls++;
    }
    const r = await measureOpsAsync(asyncFn, { ops: 50, warmup: 10 });
    assert.equal(calls, (10 + 50) * 2,
        'async fn body must complete before next op; got ' + calls + ' calls');
    assert.equal(r.ops, 50);
});

test('measureOpsAsync: bytesPerOp is derivable on node (source=gc)', async () => {
    const r = await measureOpsAsync(noopAsync, { ops: 200, warmup: 40 });
    assert.equal(r.source, 'gc');
    assert.notEqual(r.bytesPerOp, null,
        'bytesPerOp must be derivable on node with default source');
});

test('measureOpsAsync: bytesPerOp is null on source=none', async () => {
    const r = await measureOpsAsync(noopAsync, { ops: 100, source: 'none' });
    assert.equal(r.source, 'none');
    assert.equal(r.bytesPerOp, null,
        'bytesPerOp must be null when no memory channel is available');
});

// -----------------------------------------------------------------------------
// Stabilize resolution
// -----------------------------------------------------------------------------

test('measureOpsAsync: stabilize:true throws when --expose-gc is not available', async () => {
    if (typeof globalThis.gc === 'function') return; // skip if gc is available
    await assert.rejects(
        () => measureOpsAsync(noopAsync, { ops: 100, stabilize: true }),
        RangeError
    );
});

test('measureOpsAsync: stabilize defaults ON when --expose-gc is available', async () => {
    if (typeof globalThis.gc !== 'function') return; // skip if gc unavailable
    const r = await measureOpsAsync(noopAsync, { ops: 100, warmup: 20 });
    assert.equal(r.bytesPerOpStable, true,
        'stabilize should default to true under --expose-gc');
});

test('measureOpsAsync: explicit stabilize:false opts out', async () => {
    const r = await measureOpsAsync(noopAsync, { ops: 100, warmup: 20, stabilize: false });
    assert.equal(r.bytesPerOpStable, false);
});

// -----------------------------------------------------------------------------
// Input validation
// -----------------------------------------------------------------------------

test('measureOpsAsync: rejects when fn is not a function', async () => {
    await assert.rejects(() => measureOpsAsync(null, { ops: 10 }), TypeError);
    await assert.rejects(() => measureOpsAsync(42, { ops: 10 }), TypeError);
});

test('measureOpsAsync: rejects when ops is missing/invalid', async () => {
    await assert.rejects(() => measureOpsAsync(noopAsync, {}), RangeError);
    await assert.rejects(() => measureOpsAsync(noopAsync, { ops: 0 }), RangeError);
    await assert.rejects(() => measureOpsAsync(noopAsync, { ops: -1 }), RangeError);
    await assert.rejects(() => measureOpsAsync(noopAsync, { ops: 1.5 }), RangeError);
});

test('measureOpsAsync: rejects when warmup is negative or non-integer', async () => {
    await assert.rejects(
        () => measureOpsAsync(noopAsync, { ops: 10, warmup: -1 }), RangeError);
    await assert.rejects(
        () => measureOpsAsync(noopAsync, { ops: 10, warmup: 1.5 }), RangeError);
});

// -----------------------------------------------------------------------------
// checkOpsAsync / assertOpsAsync
// -----------------------------------------------------------------------------

test('checkOpsAsync: pass on clean workload with reasonable maxBytesPerOp', async () => {
    // Clean workload measured against measured-floor threshold.
    // Portable pattern -- don't hard-code absolute byte thresholds.
    const clean = await measureOpsAsync(noopAsync, { ops: 200, warmup: 40 });
    const floor = Math.max(clean.bytesPerOp, 32);
    const rep = checkOpsAsync(clean, { maxBytesPerOp: floor * 4 });
    assert.equal(rep.verdict, 'pass');
    assert.equal(rep.kind, 'ops-async');
});

test('checkOpsAsync: inconclusive when a rule can\'t be verified on source=none', async () => {
    const r = await measureOpsAsync(noopAsync, { ops: 100, source: 'none' });
    const rep = checkOpsAsync(r, { maxBytesPerOp: 0 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checked.maxBytesPerOp, false);
});

test('checkOpsAsync: throws when result is not a measureOpsAsync result', () => {
    assert.throws(() => checkOpsAsync({}, {}), TypeError);
    assert.throws(() => checkOpsAsync(null, {}), TypeError);
    assert.throws(() => checkOpsAsync({ schema: 'lite-gc-ops/1' }, {}), TypeError);
});

test('assertOpsAsync: returns the report on pass', async () => {
    // Measure floor first, gate above it.
    const clean = await measureOpsAsync(noopAsync, { ops: 100, warmup: 20 });
    const floor = Math.max(clean.bytesPerOp, 32);
    const rep = await assertOpsAsync(noopAsync,
        { maxBytesPerOp: floor * 4 },
        { ops: 100, warmup: 20 });
    assert.equal(rep.verdict, 'pass');
});

test('assertOpsAsync: throws GcBudgetError when rule exceeded', async () => {
    // A workload that retains 1024-slot arrays MUST fail maxBytesPerOp:64
    // on any V8 build (portable typed-slot payload).
    const sink = [];
    async function leakyFn(i) {
        sink.push(new Array(1024).fill(i));
    }
    await assert.rejects(
        () => assertOpsAsync(leakyFn,
            { maxBytesPerOp: 64 },
            { ops: 100, warmup: 20 }),
        GcBudgetError
    );
});

test('assertOpsAsync: throws GcInconclusiveError when rule is unverifiable', async () => {
    await assert.rejects(
        () => assertOpsAsync(noopAsync,
            { maxBytesPerOp: 0 },
            { ops: 100, source: 'none' }),
        GcInconclusiveError
    );
});

test('assertOpsAsync: allowInconclusive passes inconclusive through', async () => {
    const rep = await assertOpsAsync(noopAsync,
        { maxBytesPerOp: 0 },
        { ops: 100, source: 'none', allowInconclusive: true });
    assert.equal(rep.verdict, 'inconclusive');
});

// -----------------------------------------------------------------------------
// compareOpsAsync / assertCompareOpsAsync
// -----------------------------------------------------------------------------

test('compareOpsAsync: two clean workloads with stabilize delta -> pass', async () => {
    // Portability lesson from ops test #276 fix: two-noop compareOps
    // without stabilize hits multi-KB/op cold-start noise. stabilize:true
    // (the default under --expose-gc) makes the delta bounded and small.
    const ctl = await measureOpsAsync(noopAsync, { ops: 200, warmup: 40 });
    const can = await measureOpsAsync(noopAsync, { ops: 200, warmup: 40 });
    const rep = await compareOpsAsync(ctl, can, { maxExtraBytesPerOp: 128 });
    assert.equal(rep.verdict, 'pass');
});

test('compareOpsAsync: convenience form (two functions)', async () => {
    const rep = await compareOpsAsync(noopAsync, noopAsync,
        { maxExtraBytesPerOp: 128 },
        { ops: 200, warmup: 40 });
    assert.equal(rep.verdict, 'pass');
});

test('compareOpsAsync: source mismatch -> inconclusive', async () => {
    const ctl = await measureOpsAsync(noopAsync, { ops: 100, source: 'gc' });
    const can = await measureOpsAsync(noopAsync, { ops: 100, source: 'none' });
    const rep = await compareOpsAsync(ctl, can, { maxExtraBytesPerOp: 0 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.reason, 'source_mismatch');
});

test('assertCompareOpsAsync: returns report on pass', async () => {
    const rep = await assertCompareOpsAsync(noopAsync, noopAsync,
        { maxExtraBytesPerOp: 128 },
        { ops: 200, warmup: 40 });
    assert.equal(rep.verdict, 'pass');
});

// -----------------------------------------------------------------------------
// asyncResidual smoke detector
// -----------------------------------------------------------------------------

test('measureOpsAsync: asyncResidual is reported (non-negative number)', async () => {
    // asyncResidual measures heap growth AFTER settle. Positive value signals
    // fire-and-forget work outliving the ops window. Always present in the
    // result shape.
    const r = await measureOpsAsync(microtaskAsync, { ops: 100, warmup: 20 });
    assert.equal(typeof r.asyncResidual, 'number');
    assert.ok(r.asyncResidual >= 0, 'asyncResidual is a non-negative byte count');
});
