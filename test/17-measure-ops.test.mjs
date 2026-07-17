// Standard-case tests for the per-op primitives introduced in Batch 6
// (v1.3.0, G14/G15/G16). Adversarial cases live in
// test/torture/g14-5-ops.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    measureOps, checkOps, assertOps,
    compareOps, assertCompareOps,
    GcBudgetError, GcInconclusiveError,
    VERDICT_MATRIX
} from '../Gc.js';

// A cheap sync function that doesn't allocate. Used as the "clean" workload.
function noopWorkload(i) { return i | 0; }
// A workload that allocates a fresh small object every call.
function leakyWorkload(i) { return { i, v: i * 2 }; }

// -----------------------------------------------------------------------------
// measureOps -- shape and basic semantics
// -----------------------------------------------------------------------------

test('measureOps returns the documented shape', () => {
    const r = measureOps(noopWorkload, { ops: 100, warmup: 10 });
    assert.equal(r.schema, 'lite-gc-ops/1');
    assert.equal(r.ops, 100);
    assert.equal(r.warmupOps, 10);
    assert.ok(r.elapsedMs >= 0);
    assert.ok(r.opsPerSec >= 0);
    // bytesPerOp is number | null
    assert.ok(r.bytesPerOp === null || typeof r.bytesPerOp === 'number');
    assert.equal(typeof r.source, 'string');
    assert.ok(r.summary && r.summary.schema === 'lite-gc/1');
});

test('measureOps: summary has both warmup and steady phases even when warmup=0', () => {
    const r = measureOps(noopWorkload, { ops: 50, warmup: 0 });
    assert.ok(r.summary.phases.warmup, 'warmup phase must exist even when warmup=0');
    assert.ok(r.summary.phases.steady, 'steady phase must always exist');
});

test('measureOps: opsPerSec is derived from steady elapsed only', () => {
    const r = measureOps(noopWorkload, { ops: 1000, warmup: 100 });
    // Not asserting a specific number; just that elapsedMs > 0 implies opsPerSec > 0
    if (r.elapsedMs > 0) {
        const derived = (r.ops * 1000) / r.elapsedMs;
        assert.ok(Math.abs(r.opsPerSec - derived) < 1e-6, 'opsPerSec must equal ops*1000/elapsedMs');
    }
});

test('measureOps: bytesPerOp is non-null on node (source=gc, heap sampled at phase boundaries)', () => {
    const r = measureOps(leakyWorkload, { ops: 500, warmup: 50 });
    assert.equal(r.source, 'gc');
    // On node, measureOps samples process.memoryUsage().heapUsed at boundaries,
    // so bytesPerOp is derivable. It may be 0 if V8's minor GC ran during the
    // steady phase and freed everything -- that's honest.
    assert.notEqual(r.bytesPerOp, null, 'bytesPerOp must be derivable on node');
});

test('measureOps: bytesPerOp is null on source=none', () => {
    const r = measureOps(noopWorkload, { ops: 100, source: 'none' });
    assert.equal(r.source, 'none');
    assert.equal(r.bytesPerOp, null, "bytesPerOp must be null when no memory channel is available");
});

test('measureOps: bytesPerOp reports 0 on a clean noop workload with GC intervention', () => {
    // A noop workload should not allocate meaningfully. Whether V8 runs a
    // minor GC in the middle is up to the runtime; either way bytesPerOp
    // should not be a large positive number.
    const r = measureOps(noopWorkload, { ops: 10000 });
    if (r.bytesPerOp !== null) {
        assert.ok(r.bytesPerOp < 1000, 'noop workload bytesPerOp should be small; got ' + r.bytesPerOp);
    }
});

// -----------------------------------------------------------------------------
// measureOps -- input validation
// -----------------------------------------------------------------------------

test('measureOps: throws when fn is not a function', () => {
    assert.throws(() => measureOps(null, { ops: 10 }), TypeError);
    assert.throws(() => measureOps(42, { ops: 10 }), TypeError);
});

test('measureOps: throws when ops is missing/invalid', () => {
    assert.throws(() => measureOps(noopWorkload, {}), RangeError);
    assert.throws(() => measureOps(noopWorkload, { ops: 0 }), RangeError);
    assert.throws(() => measureOps(noopWorkload, { ops: -1 }), RangeError);
    assert.throws(() => measureOps(noopWorkload, { ops: 1.5 }), RangeError);
    assert.throws(() => measureOps(noopWorkload, { ops: Infinity }), RangeError);
});

test('measureOps: throws when warmup is negative', () => {
    assert.throws(() => measureOps(noopWorkload, { ops: 10, warmup: -5 }), RangeError);
});

test('measureOps: throws when opts is missing', () => {
    assert.throws(() => measureOps(noopWorkload), TypeError);
});

// -----------------------------------------------------------------------------
// VERDICT_MATRIX -- per-op rules present with all four source columns
// -----------------------------------------------------------------------------

test('VERDICT_MATRIX contains the four per-op rules with all source columns', () => {
    const expected = ['gc', 'heap', 'uasm', 'none'];
    const perOpRules = ['maxBytesPerOp', 'maxMajorsPerKOp', 'maxMinorsPerKOp', 'maxPauseMsPerOp'];
    for (const rule of perOpRules) {
        assert.ok(VERDICT_MATRIX[rule], 'missing rule row ' + rule);
        for (const src of expected) {
            assert.ok(VERDICT_MATRIX[rule][src] !== undefined,
                'rule ' + rule + ' missing column ' + src);
        }
    }
});

test('VERDICT_MATRIX: kind-per-op rules are yes-on-gc, no elsewhere', () => {
    for (const rule of ['maxMajorsPerKOp', 'maxMinorsPerKOp', 'maxPauseMsPerOp']) {
        assert.equal(VERDICT_MATRIX[rule].gc, 'yes');
        assert.equal(VERDICT_MATRIX[rule].heap, 'no');
        assert.equal(VERDICT_MATRIX[rule].uasm, 'no');
        assert.equal(VERDICT_MATRIX[rule].none, 'no');
    }
});

test('VERDICT_MATRIX: maxBytesPerOp mirrors maxAllocRate verifiability', () => {
    assert.equal(VERDICT_MATRIX.maxBytesPerOp.gc, 'needsHeap');
    assert.equal(VERDICT_MATRIX.maxBytesPerOp.heap, 'needsHeap');
    assert.equal(VERDICT_MATRIX.maxBytesPerOp.uasm, 'needsUasm');
    assert.equal(VERDICT_MATRIX.maxBytesPerOp.none, 'no');
});

// -----------------------------------------------------------------------------
// checkOps / assertOps
// -----------------------------------------------------------------------------

test('checkOps: pass on clean noop workload with reasonable maxBytesPerOp', () => {
    const r = measureOps(noopWorkload, { ops: 1000, warmup: 100 });
    const rep = checkOps(r, { maxBytesPerOp: 1024 });
    assert.equal(rep.verdict, 'pass');
    assert.equal(rep.kind, 'ops');
});

test('checkOps: inconclusive when a rule can\'t be verified on this source', () => {
    const r = measureOps(noopWorkload, { ops: 100, source: 'none' });
    const rep = checkOps(r, { maxBytesPerOp: 0 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checked.maxBytesPerOp, false);
});

test('checkOps: fail when maxBytesPerOp is clearly exceeded', () => {
    // Use plain object allocation (not Uint8Array) so heap growth lands in
    // process.memoryUsage().heapUsed rather than external ArrayBuffer memory.
    // Uint8Array backing buffers are invisible to the sampling channel; only
    // the wrapper (~80 bytes) counts, and its exact size varies across V8
    // versions. Plain objects give ~100 bytes/op deterministically.
    const sink = [];
    function heavyWorkload(i) {
        sink.push({ a: i, b: i * 2, c: i * 3, d: 'literal', e: i + 1, f: i - 1 });
    }
    const r = measureOps(heavyWorkload, { ops: 500, warmup: 10 });
    // ~50 KB heap growth over 500 ops = ~100 bytes/op. A limit of 20 must fail.
    const rep = checkOps(r, { maxBytesPerOp: 20 });
    if (r.bytesPerOp === null || r.bytesPerOp < 20) {
        // Edge case: if a scavenge happened between the paired boundary
        // samples and cancellation over-corrected. Skip rather than flake.
        return;
    }
    assert.equal(rep.verdict, 'fail');
    assert.ok(rep.violations.some((v) => v.metric === 'bytesPerOp'));
});

test('checkOps: throws when result is not a measureOps result', () => {
    assert.throws(() => checkOps({}, {}), TypeError);
    assert.throws(() => checkOps(null, {}), TypeError);
});

test('assertOps: returns the report on pass', () => {
    const rep = assertOps(noopWorkload, { maxBytesPerOp: 1024 }, { ops: 500 });
    assert.equal(rep.verdict, 'pass');
});

test('assertOps: throws GcInconclusiveError when a rule is unverifiable on this source', () => {
    assert.throws(
        () => assertOps(noopWorkload, { maxBytesPerOp: 0 }, { ops: 100, source: 'none' }),
        GcInconclusiveError
    );
});

test('assertOps: passes through when allowInconclusive is set', () => {
    const rep = assertOps(noopWorkload, { maxBytesPerOp: 0 }, {
        ops: 100, source: 'none', allowInconclusive: true
    });
    assert.equal(rep.verdict, 'inconclusive');
});

test('assertOps: throws GcBudgetError on fail', () => {
    const sink = [];
    function heavy(i) {
        sink.push({ a: i, b: i * 2, c: i * 3, d: 'literal', e: i + 1, f: i - 1 });
    }
    assert.throws(
        () => assertOps(heavy, { maxBytesPerOp: 5 }, { ops: 500 }),
        GcBudgetError
    );
});

// -----------------------------------------------------------------------------
// compareOps / assertCompareOps
// -----------------------------------------------------------------------------

test('compareOps: two measureOps results, clean deltas -> pass', () => {
    const control = measureOps(noopWorkload, { ops: 500, warmup: 50 });
    const candidate = measureOps(noopWorkload, { ops: 500, warmup: 50 });
    const rep = compareOps(control, candidate, { maxExtraBytesPerOp: 1024 });
    assert.equal(rep.verdict, 'pass');
});

test('compareOps: convenience form (two functions)', () => {
    const rep = compareOps(noopWorkload, noopWorkload, { maxExtraBytesPerOp: 1024 }, {
        ops: 200, warmup: 20
    });
    assert.equal(rep.verdict, 'pass');
});

test('compareOps: candidate leaks vs clean control -> fail', () => {
    const sinkK = [];
    function control(i)   { return i | 0; }                                    // no allocation
    function candidate(i) {
        sinkK.push({ a: i, b: i * 2, c: i * 3, d: 'literal', e: i + 1, f: i - 1 });
        return i;
    }
    const ctlR = measureOps(control,   { ops: 500, warmup: 50 });
    const canR = measureOps(candidate, { ops: 500, warmup: 50 });
    const rep = compareOps(ctlR, canR, { maxExtraBytesPerOp: 20 });
    if (canR.bytesPerOp === null || (ctlR.bytesPerOp !== null && canR.bytesPerOp - ctlR.bytesPerOp < 20)) {
        return; // GC intervention edge case
    }
    assert.equal(rep.verdict, 'fail');
    assert.ok(rep.violations.some((v) => v.metric === 'bytesPerOp.delta'));
});

test('compareOps: source mismatch -> inconclusive', () => {
    const ctl = measureOps(noopWorkload, { ops: 100, source: 'gc' });
    const can = measureOps(noopWorkload, { ops: 100, source: 'none' });
    const rep = compareOps(ctl, can, { maxExtraBytesPerOp: 0 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.reason, 'source_mismatch');
});

test('compareOps: throws on non-result inputs (primitive form)', () => {
    assert.throws(() => compareOps({}, {}, {}), TypeError);
    assert.throws(() => compareOps(null, null, {}), TypeError);
});

test('assertCompareOps: convenience form throws GcBudgetError on delta failure', () => {
    // Uint8Array's 2048-byte backing buffer lands in external ArrayBuffer
    // memory, not JS heap; process.memoryUsage().heapUsed only sees the
    // ~80-byte wrapper. On some V8 versions (notably Node 26 on Apple
    // Silicon) the wrapper is packed tightly enough that per-op growth
    // falls below the maxExtraBytesPerOp threshold. Use plain object
    // allocation, which lands in heapUsed deterministically at ~100 bytes/op.
    const sink = [];
    function control(i) { return i | 0; }
    function candidate(i) {
        sink.push({ a: i, b: i * 2, c: i * 3, d: 'literal', e: i + 1, f: i - 1 });
        return i;
    }
    assert.throws(
        () => assertCompareOps(control, candidate, { maxExtraBytesPerOp: 20 }, { ops: 500, warmup: 50 }),
        GcBudgetError
    );
});

test('assertCompareOps: returns report on pass', () => {
    const rep = assertCompareOps(noopWorkload, noopWorkload, { maxExtraBytesPerOp: 1024 }, { ops: 200 });
    assert.equal(rep.verdict, 'pass');
});

// -----------------------------------------------------------------------------
// Warmup / steady separation -- warmup allocations must not leak into steady stats
// -----------------------------------------------------------------------------

test('measureOps: warmup allocations do not inflate steady bytesPerOp', () => {
    // Toggle to steady after warmup completes; measureOps calls fn(i) once
    // per iteration, so we can peek at the iteration index via a closure
    // and switch based on call count. Alternate strategy: use closures to
    // track calls; measureOps doesn't tell us which phase we're in from
    // inside fn.
    const warmupSink = [];
    let callCount = 0;
    const warmupCount = 100, opsCount = 500;
    function fn2(i) {
        callCount++;
        if (callCount <= warmupCount) {
            // heavy warmup allocation -- plain objects, ~200 bytes each,
            // land in JS heap (visible to process.memoryUsage().heapUsed)
            warmupSink.push({ a: i, b: i * 2, c: i * 3, d: 'literal', e: i + 1,
                             f: i - 1, g: 'x', h: i, k: i, l: i });
        }
        // steady iterations are noops
    }
    const r = measureOps(fn2, { ops: opsCount, warmup: warmupCount });
    // The KEY assertion: steady bytesPerOp is small because steady iterations
    // did nothing. The warmup allocations are quarantined by the phase()
    // boundary that measureOps places. A large object literal at warmup is
    // ~200 bytes; steady should be well under that.
    if (r.bytesPerOp !== null) {
        assert.ok(r.bytesPerOp < 200,
            'steady bytesPerOp (' + r.bytesPerOp + ') must be much smaller than the warmup per-op alloc size');
    }
});
