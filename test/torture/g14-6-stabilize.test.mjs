// Torture scenarios for the stabilize option added in v1.3.1 (G14.6 slot).
// Standard cases live in test/19-stabilize.test.mjs.
//
// Four-axis discipline for stabilize:
//   Axis A -- adversarial: unavailable global.gc, invalid opts, mid-run tamper
//   Axis B -- signal-under-noise: leak survives forced GC, transient collapses
//   Axis C -- perturbation bound: stabilize itself induces no user-visible cost
//   Axis D -- self-consistency: cold-run == warm-run verdict with stabilize
//
// The Axis D scenario is the ecosystem pin -- cold-CI determinism is why
// this feature exists. If it ever regresses, cold assertCompareOps callers
// hit the same collapse the feature was introduced to solve.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureOps, checkOps, compareOps, assertCompareOps, GcBudgetError } from '../../Gc.js';

// =============================================================================
// AXIS A -- adversarial inputs / states
// =============================================================================

test('[axis A] stabilize:true throws before any measurement work happens', () => {
    // The guard must fire at INIT, not partway through. If it fired inside
    // the phase loop, the profiler would already be started and users would
    // pay allocation/observer setup cost before the informative error.
    const savedGc = globalThis.gc;
    globalThis.gc = undefined;
    let workDone = false;
    try {
        assert.throws(() => measureOps(
            () => { workDone = true; },
            { ops: 100, stabilize: true }
        ), RangeError);
        assert.equal(workDone, false, 'stabilize guard must throw before fn runs; fn was called');
    } finally {
        globalThis.gc = savedGc;
    }
});

test('[axis A] stabilize is only recognized as true when === true (not truthy)', () => {
    // Design contract: stabilize is a strict-boolean gate on a mode with
    // real cost (two forced GCs per measurement). Truthy values like 1, 'x',
    // {} must NOT accidentally enable it -- the user would eat the cost
    // without knowing they'd asked. Belt-and-braces regression pin.
    const savedGc = globalThis.gc;
    let calls = 0;
    globalThis.gc = function () { calls++; };
    try {
        for (const truthy of [1, 'yes', {}, [], 'true']) {
            calls = 0;
            measureOps((i) => i | 0, { ops: 50, stabilize: truthy });
            assert.equal(calls, 0,
                'stabilize=' + JSON.stringify(truthy) + ' must NOT enable stabilize mode; got ' + calls + ' gc calls');
        }
        // And only strict true should turn it on:
        calls = 0;
        measureOps((i) => i | 0, { ops: 50, stabilize: true });
        assert.equal(calls, 2, 'stabilize:true (strict) must invoke gc twice; got ' + calls);
    } finally {
        globalThis.gc = savedGc;
    }
});

test('[axis A] error message names --expose-gc explicitly (actionable guidance)', () => {
    // The error must tell CI configurers the exact fix. If we regress to a
    // generic "gc not available" message, users grep node docs and burn an
    // hour figuring out what to do. Pin the specific string.
    const savedGc = globalThis.gc;
    globalThis.gc = undefined;
    try {
        try { measureOps((i) => i, { ops: 10, stabilize: true }); assert.fail('should have thrown'); }
        catch (e) {
            assert.match(e.message, /--expose-gc/,
                'stabilize error must name --expose-gc for actionable CI guidance; got: ' + e.message);
        }
    } finally {
        globalThis.gc = savedGc;
    }
});

// =============================================================================
// AXIS B -- real signal under real noise
// =============================================================================

test('[axis B] retained leak survives stabilize and shows on bytesPerOp', () => {
    // Cannot be gamed by GC: sink retains references across the forced end
    // GC, so the survivors show up in the delta. A retained array is
    // heap-visible on every V8 build and lands far above this threshold --
    // unlike a small plain object, whose retained size is build-dependent and
    // can sit near 20 B/op once pointer compression narrows tagged slots.
    // With an unambiguous signal a single run suffices; no best-of-attempts.
    const sink = [];
    function leaks(i) { sink.push(new Array(64).fill(i)); }
    const r = measureOps(leaks, { ops: 500, warmup: 50, stabilize: true });
    assert.notEqual(r.bytesPerOp, null);
    assert.ok(r.bytesPerOp > 20,
        'retained leak must show through stabilize; got bytesPerOp=' + r.bytesPerOp);
});

test('[axis B] transient allocation collapses under stabilize (survivor semantic)', () => {
    // The RETENTION-VS-TRANSIENT split is the whole reason stabilize exists.
    // Without stabilize, this workload shows ~100 B/op (heap grew during
    // the loop even though nothing is retained). With stabilize, the forced
    // end GC collects the transient objects and the survivors delta is
    // essentially V8 residual noise.
    function transient(i) {
        const tmp = { a: i, b: i * 2, c: i * 3, d: 'x', e: i + 1 };
        return tmp.a | 0;
    }
    // Best-of pattern: V8 residual is noisy but the retention-vs-transient
    // separation is not.
    let bestClean = Infinity;
    for (let attempt = 0; attempt < 5; attempt++) {
        const r = measureOps(transient, { ops: 500, warmup: 50, stabilize: true });
        if (r.bytesPerOp !== null && r.bytesPerOp < bestClean) bestClean = r.bytesPerOp;
    }
    assert.ok(bestClean < 50,
        'transient (non-retained) allocation must not survive stabilize; got best bytesPerOp=' + bestClean);
});

// =============================================================================
// AXIS C -- perturbation bound: stabilize's own cost
// =============================================================================

test('[axis C] stabilize on a noop workload keeps bytesPerOp near zero', () => {
    // The forced GCs happen at boundaries, before/after the steady loop.
    // They compact the heap but don't allocate INSIDE the steady loop.
    // If stabilize's implementation somehow allocated during steady, this
    // catches it -- a noop workload with stabilize should look as clean
    // as (or cleaner than) the same workload without.
    function noop(i) { return i | 0; }
    let best = Infinity;
    for (let attempt = 0; attempt < 5; attempt++) {
        const r = measureOps(noop, { ops: 10_000, warmup: 500, stabilize: true });
        if (r.bytesPerOp !== null && r.bytesPerOp < best) best = r.bytesPerOp;
    }
    assert.ok(best < 5,
        'noop workload + stabilize must land near zero; got best bytesPerOp=' + best);
});

// =============================================================================
// AXIS D -- self-consistency: cold-run == warm-run
// =============================================================================

test('[axis D] cold-run assertCompareOps + stabilize == warm-run + stabilize (ecosystem pin)', () => {
    // The invariant that makes stabilize worth existing: verdict is
    // order-independent when stabilize:true. If this ever regresses, the
    // cold-CI collapse we've been fighting all along has reappeared.
    //
    // Both control and candidate are freshly declared here to defeat any
    // implicit warming from JIT tier-up. The "cold" run happens FIRST with
    // no prior measureOps calls in this test process; the "warm" run runs
    // AFTER the cold run (which itself warms V8 paths). Both must throw
    // GcBudgetError -- same verdict on the same rule set.
    //
    // The leak retains a 1024-slot array per op rather than a small plain
    // object. A 6-key object's retained size is V8-build dependent (pointer
    // compression halves tagged slot width), landing near this rule's 20 B/op
    // threshold on some builds -- and over a 500-op window V8's own live-set
    // jitter is worth a few B/op, enough to flip the verdict between the cold
    // and warm run and make this pin flaky. A retained array is heap-visible
    // on every build and lands orders of magnitude above the threshold, so the
    // pin tests verdict ORDER-INDEPENDENCE (its actual subject) rather than
    // the engine's object layout.
    function coldControl(i)   { return i | 0; }
    const coldSink = [];
    function coldCandidate(i) {
        coldSink.push(new Array(64).fill(i));
        return i;
    }
    // COLD: no prior calls warming these paths.
    let coldThrew = false;
    try {
        assertCompareOps(coldControl, coldCandidate,
            { maxExtraBytesPerOp: 20 },
            { ops: 500, warmup: 50, stabilize: true });
    } catch (e) {
        coldThrew = e instanceof GcBudgetError;
    }

    // WARM: paths above are now hot. Run same-shape functions in fresh closures.
    function warmControl(i)   { return i | 0; }
    const warmSink = [];
    function warmCandidate(i) {
        warmSink.push(new Array(64).fill(i));
        return i;
    }
    let warmThrew = false;
    try {
        assertCompareOps(warmControl, warmCandidate,
            { maxExtraBytesPerOp: 20 },
            { ops: 500, warmup: 50, stabilize: true });
    } catch (e) {
        warmThrew = e instanceof GcBudgetError;
    }

    assert.equal(coldThrew, warmThrew,
        'cold-run and warm-run verdicts must match under stabilize:true '
        + '(cold=' + coldThrew + ', warm=' + warmThrew + ')');
    assert.equal(coldThrew, true, 'both must throw on a real leak vs clean control');
});

test('[axis D] shape-stability: summary.phases.stabilize existence tracks the opt-in', () => {
    // The summary shape is a public contract. If stabilize:false ever
    // started including an empty stabilize phase, downstream consumers
    // that walk phases by name would see spurious entries. If stabilize:true
    // ever OMITTED the stabilize phase, gating tools couldn't tell the
    // measurement was hardened. Both directions pinned.
    const off = measureOps((i) => i | 0, { ops: 50 });
    const on = measureOps((i) => i | 0, { ops: 50, stabilize: true });
    assert.ok(!off.summary.phases.stabilize,
        'stabilize:false must NOT include a stabilize phase in the summary');
    assert.ok(on.summary.phases.stabilize,
        'stabilize:true MUST include the stabilize phase in the summary');
});
