// Standard-case tests for the stabilize option added in v1.3.1 (CI
// hardening, part 2). Adversarial cases live in
// test/torture/g14-6-stabilize.test.mjs.
//
// stabilize:true forces globalThis.gc() at each steady-phase boundary so
// bytesPerOp reflects the SURVIVING-allocation delta (bytes still retained
// across the forced GC) rather than transient allocation. This is the
// semantic cold-CI users want: "my signal notification retains zero bytes"
// is a stronger claim than "my signal notification allocated zero transiently."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureOps, checkOps, assertOps, compareOps, assertCompareOps } from '../Gc.js';

// -----------------------------------------------------------------------------
// Init-time validation
// -----------------------------------------------------------------------------

test('measureOps: stabilize:true throws when globalThis.gc is unavailable', () => {
    // Simulate a runtime without --expose-gc by stashing gc as undefined.
    // Under --expose-gc, globalThis.gc is non-configurable so we can't
    // delete it, but the code checks `typeof globalThis.gc !== 'function'`
    // which is true when we assign undefined.
    const savedGc = globalThis.gc;
    globalThis.gc = undefined;
    try {
        assert.throws(
            () => measureOps((i) => i | 0, { ops: 100, stabilize: true }),
            (e) => e instanceof RangeError && /expose-gc/.test(e.message)
        );
    } finally {
        globalThis.gc = savedGc;
    }
});

test('measureOps: stabilize:false (default) does not touch globalThis.gc', () => {
    // A run without stabilize must be portable to runtimes without --expose-gc
    // even if we're currently running with it. Prove the code path is gated.
    const savedGc = globalThis.gc;
    let calls = 0;
    globalThis.gc = function () { calls++; };
    try {
        measureOps((i) => i | 0, { ops: 100 });                        // no stabilize
        assert.equal(calls, 0, 'default path must not invoke global.gc');
    } finally {
        globalThis.gc = savedGc;
    }
});

test('measureOps: stabilize:true invokes globalThis.gc exactly twice per run', () => {
    // Once before steady start, once before steady end. Any more and the
    // forced-GC cost is bleeding into the accounting; any fewer and the
    // retention semantic isn't holding.
    const savedGc = globalThis.gc;
    let calls = 0;
    globalThis.gc = function () { calls++; savedGc && savedGc(); };
    try {
        measureOps((i) => i | 0, { ops: 100, stabilize: true });
        assert.equal(calls, 2, 'stabilize:true must invoke global.gc exactly twice; got ' + calls);
    } finally {
        globalThis.gc = savedGc;
    }
});

// -----------------------------------------------------------------------------
// Phase attribution: stabilize events must NOT contaminate steady counters
// -----------------------------------------------------------------------------

test('stabilize: adds stabilize phase to summary shape without contaminating steady', () => {
    // Design contract: with stabilize:true, the summary MUST include the
    // stabilize phase (shape-stable output), and steady counters MUST NOT
    // reflect the forced fulls. The forced-GC events themselves arrive
    // asynchronously via perf_hooks and typically land AFTER measureOps
    // returns, so the stabilize.gc counters are UNRELIABLE for gating --
    // users get the retention benefit on bytesPerOp, but should not attempt
    // to gate on maxMajorsPerKOp when combined with stabilize:true.
    //
    // The invariant this pins: steady.gc.major is zero on a workload that
    // itself does not induce majors, regardless of stabilize's forced fulls.
    // If a future refactor accidentally routes the forced GCs into steady
    // attribution, this fails immediately.
    const r = measureOps((i) => i | 0, { ops: 100, stabilize: true });
    // stabilize phase is part of the summary shape when opted in
    assert.ok(r.summary.phases.stabilize,
        'stabilize phase must be present in summary when stabilize:true');
    // steady stays clean: no majors from a noop workload
    const steady = r.summary.phases.steady && r.summary.phases.steady.gc;
    assert.ok(steady, 'steady phase always present');
    assert.equal(steady.major, 0,
        'steady must not see any majors on a noop workload, even with stabilize:true');
});

test('stabilize:false: no stabilize phase in summary', () => {
    const r = measureOps((i) => i | 0, { ops: 100 });
    assert.ok(!r.summary.phases.stabilize,
        'stabilize phase must be absent when stabilize:false (existing shape preserved)');
});

// -----------------------------------------------------------------------------
// bytesPerOp semantics: retention vs transient
// -----------------------------------------------------------------------------

test('stabilize: retained allocation is captured (candidate leak survives forced GC)', () => {
    // Sink holds objects across the forced end-boundary GC. Retention is
    // real; stabilize doesn't erase it. bytesPerOp reflects the surviving
    // bytes divided by ops.
    const sink = [];
    // Retained array: heap-visible on every V8 build and far above the 20 B/op
    // threshold. A small plain object's retained size is build-dependent and
    // can land near the threshold under pointer compression.
    function leaks(i) { sink.push(new Array(64).fill(i)); }
    const r = measureOps(leaks, { ops: 500, warmup: 50, stabilize: true });
    assert.notEqual(r.bytesPerOp, null);
    assert.ok(r.bytesPerOp > 20,
        'retained leak must survive stabilize forced GC; bytesPerOp=' + r.bytesPerOp);
});

test('stabilize: transient allocation collapses to zero (survivor semantic)', () => {
    // Objects allocated inside the workload but not retained are collected
    // by the forced end-boundary GC. bytesPerOp reflects survivors -- which
    // for a truly transient workload is essentially zero. This is what makes
    // stabilize the right answer for cold-CI zero-alloc claims: the retention
    // question is the question people actually care about.
    function transient(i) {
        const tmp = { a: i, b: i * 2, c: i * 3, d: 'x', e: i + 1 };
        return tmp.a | 0;                                              // no retention
    }
    const r = measureOps(transient, { ops: 500, warmup: 50, stabilize: true });
    assert.notEqual(r.bytesPerOp, null);
    // A well-collected transient workload should land near zero. Not asserting
    // exactly zero -- V8's own bookkeeping still exists -- but well under the
    // 100+ bytes/op the same workload would show without stabilize.
    assert.ok(r.bytesPerOp < 50,
        'transient allocation must not survive forced GC; got bytesPerOp=' + r.bytesPerOp);
});

// -----------------------------------------------------------------------------
// Cold-CI determinism: the pin
// -----------------------------------------------------------------------------

test('stabilize: cold-run assertCompareOps produces the same verdict as warm-run', () => {
    // The one that motivated this feature. Without stabilize, a cold
    // assertCompareOps can collapse because a mid-steady major GC compacts
    // heapUsed below the start sample. With stabilize:true, the forced
    // boundary GCs make the measurement order-independent.
    //
    // The retained array is 1024 slots, not 64. This pin reported a false
    // 'pass' on an M4 that could not be reproduced on the reference box at
    // 64 slots, so the signal is sized to dominate rather than to be
    // marginally sufficient: ~8 KB per op against a 20 B/op rule, a margin of
    // several hundred x that no plausible live-set jitter can close.
    const sink = [];
    function control(i) { return i | 0; }
    function candidate(i) { sink.push(new Array(1024).fill(i)); return i; }

    // Measure explicitly BEFORE asserting the throw. `assert.throws` alone
    // reports only "Missing expected exception" when the gate passes, which
    // says nothing about why -- it hides whether the control read high, the
    // candidate read low, or the measurement was never stabilized at all.
    // These numbers make the next failure diagnosable from the report alone.
    const opts = { ops: 500, warmup: 50, stabilize: true };
    const ctl = measureOps(control, opts);
    const can = measureOps(candidate, opts);
    const delta = can.bytesPerOp - ctl.bytesPerOp;
    assert.ok(delta > 20,
        'retained leak must clear the 20 B/op rule -- control=' + ctl.bytesPerOp
        + ' candidate=' + can.bytesPerOp + ' delta=' + delta
        + ' stable=' + can.bytesPerOpStable + '/' + ctl.bytesPerOpStable);

    assert.throws(
        () => assertCompareOps(control, candidate, { maxExtraBytesPerOp: 20 }, opts),
        (e) => e && e.constructor && e.constructor.name === 'GcBudgetError'
    );
});

test('stabilize: propagates through compareOps convenience form', () => {
    // opts is passed into both internal measureOps calls; both get the same
    // stabilize semantics. Regression pin: if the option ever gets stripped
    // in the convenience path, cold CI collapses again silently.
    let gcCalls = 0;
    const savedGc = globalThis.gc;
    globalThis.gc = function () { gcCalls++; savedGc(); };
    try {
        compareOps(
            (i) => i | 0,
            (i) => i | 0,
            { maxExtraBytesPerOp: 1024 },
            { ops: 100, warmup: 10, stabilize: true }
        );
        // Two measureOps runs * 2 forced GCs each = 4 total.
        assert.equal(gcCalls, 4,
            'convenience compareOps must propagate stabilize to BOTH measurements; got ' + gcCalls + ' gc calls');
    } finally {
        globalThis.gc = savedGc;
    }
});
