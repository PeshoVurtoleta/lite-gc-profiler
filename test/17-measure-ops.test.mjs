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
    // A retained array is heap-visible on every V8 build and lands hundreds of
    // bytes per op, unlike a typed array (backing buffer invisible to the
    // sampling channel) or a small plain object (retained size varies with
    // pointer compression). stabilize:true GC-anchors the boundaries, so a
    // scavenge landing between the paired samples can no longer cancel the
    // signal -- which is why this test no longer needs its "skip rather than
    // flake" early-return. A silent skip can pass a real regression unnoticed.
    const sink = [];
    function heavyWorkload(i) { sink.push(new Array(64).fill(i)); }
    const r = measureOps(heavyWorkload, { ops: 500, warmup: 10, stabilize: true });
    const rep = checkOps(r, { maxBytesPerOp: 20 });
    assert.notEqual(r.bytesPerOp, null);
    assert.equal(rep.verdict, 'fail');
    assert.ok(rep.violations.some((v) => v.metric === 'bytesPerOp'));
});

test('checkOps: throws when result is not a measureOps result', () => {
    assert.throws(() => checkOps({}, {}), TypeError);
    assert.throws(() => checkOps(null, {}), TypeError);
});

test('assertOps: returns the report on pass', () => {
    // stabilize:true is load-bearing, not decoration. The subject here is that
    // assertOps RETURNS the report when the verdict is pass -- the measurement
    // is scaffolding, and the unanchored path is the noisy one. Measured on one
    // box, five runs of this exact noop at 500 ops: 1.4 to 51.5 B/op without
    // stabilize, 0.0 to 1.6 with it. On an M4 the unanchored path reached
    // 1057 B/op and threw GcBudgetError against this 1024 budget, failing a
    // test that has nothing to do with budgets.
    const rep = assertOps(noopWorkload, { maxBytesPerOp: 1024 },
        { ops: 2000, warmup: 200, stabilize: true });
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
    // This needs all three protections, and previously had none of them.
    //
    // Without `warmup`, the first ops carry JIT tier-up churn. Without
    // `stabilize`, bytesPerOp is a raw two-point delta that a mid-steady GC
    // can compact BELOW the start sample -- the reading clamps to 0, `0 > 5`
    // is false, no violation is recorded, and the expected throw never
    // happens. Measured on the 1-CPU reference box: 4 of 60 runs of this exact
    // scenario collapsed to <= 5 B/op. That is a ~7% flake that presents as
    // "Missing expected exception", which tells you nothing about the cause.
    //
    // A retained array is also heap-visible on every V8 build, unlike a small
    // plain object whose retained size roughly halves under pointer
    // compression. Stabilized and warmed, this reads ~570 B/op against a
    // threshold of 5 -- a 100x margin instead of a coin flip.
    // 1024 slots, not 64: bytesPerOp clamps at zero when the end anchor lands
    // below the start anchor, and a clamped zero clears no threshold no matter
    // how large the margin would otherwise be. Retaining ~4 MB across the
    // anchors means a clamp would require more than 4 MB of residual garbage
    // being freed between two post-GC samples, which is not a plausible run.
    const sink = [];
    function heavy(i) { sink.push(new Array(1024).fill(i)); }
    assert.throws(
        () => assertOps(heavy, { maxBytesPerOp: 5 }, { ops: 500, warmup: 50, stabilize: true }),
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
    // Retained array (heap-visible on every V8 build, hundreds of B/op) plus
    // stabilize:true, which GC-anchors both measurements so the control reads
    // ~0 instead of cold-start JIT churn. Together the delta clears the 20 B/op
    // rule by more than an order of magnitude on any machine -- so this test no
    // longer needs the "GC intervention edge case" early-return it used to
    // carry. That silent skip could pass a real regression unnoticed.
    // Array(256), not Array(64), and 2000 ops rather than 500. A tagged slot is
    // 8 bytes on a plain build and 4 under pointer compression, so Array(64)
    // measured ~560 B/op on one machine and roughly half that on a compressed
    // one -- while the noop CONTROL at 500 ops can pick up a few hundred B/op
    // of its own. Once the control's noise is within an order of magnitude of
    // the candidate's signal, the delta can collapse below the 20 B/op rule and
    // this reads 'pass', which is what happened on an M4. Measured here at
    // Array(256)/2000 ops: delta 2109 B/op across five runs, spread of 0.
    const sinkK = [];
    function control(i)   { return i | 0; }                                    // no allocation
    function candidate(i) { sinkK.push(new Array(256).fill(i)); return i; }
    const ctlR = measureOps(control,   { ops: 2000, warmup: 200, stabilize: true });
    const canR = measureOps(candidate, { ops: 2000, warmup: 200, stabilize: true });
    assert.notEqual(canR.bytesPerOp, null);
    const rep = compareOps(ctlR, canR, { maxExtraBytesPerOp: 20 });
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
    // Two independent portability hazards, both fixed here.
    //
    // 1. WHAT is allocated. A typed array's backing buffer lands in external
    //    ArrayBuffer memory, not the JS heap, so heapUsed only sees the small
    //    wrapper. A plain object IS heap-visible but its retained size is
    //    V8-build dependent (pointer compression narrows tagged slots), so it
    //    shrinks several-fold on Apple Silicon and can slip under the
    //    threshold. A retained plain ARRAY is heap-visible on every build and
    //    stays hundreds of bytes per op.
    //
    // 2. WHETHER the delta is measured against noise. Without stabilize the
    //    two-point heap delta includes cold-start churn: a noop control can
    //    itself read ~50 B/op from JIT tier-up, and the candidate's
    //    allocations can be partly collected mid-loop -- so the DIFFERENCE
    //    lands under maxExtraBytesPerOp and the expected throw never happens.
    //    stabilize:true GC-anchors both boundaries, so the control reads ~0
    //    and the delta is the true survivor rate.
    const sink = [];
    function control(i) { return i | 0; }
    function candidate(i) { sink.push(new Array(64).fill(i)); return i; }
    assert.throws(
        () => assertCompareOps(control, candidate,
            { maxExtraBytesPerOp: 20 }, { ops: 500, warmup: 50, stabilize: true }),
        GcBudgetError
    );
});

test('assertCompareOps: returns report on pass', () => {
    // Two identical noop workloads must net to ~0 extra bytes. Over only 200
    // ops with no warmup, the raw two-point heap delta is pure cold-start
    // noise (a stray allocation between the candidate's start/end samples can
    // read multiple KB/op on a fast machine). stabilize:true GC-anchors both
    // boundaries so the comparison is deterministic. Requires --expose-gc,
    // which the test script sets.
    const rep = assertCompareOps(noopWorkload, noopWorkload,
        { maxExtraBytesPerOp: 1024 }, { ops: 200, stabilize: true });
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
