// Torture scenarios for the async ops primitives added in v1.5.0
// (G19, slot G18.5). Standard cases live in test/18-measure-ops-async.test.mjs.
//
// Four-axis discipline (mirrors G17.5's frame-lane pattern):
//   Axis A -- adversarial: sync throw, async reject, stabilize:true without --expose-gc
//   Axis B -- signal-under-noise: PIN PAIR with the portability lessons
//             from Zahary's M4 Pro corrections (Array(1024).fill(i) as the
//             portable typed-slot payload, thresholds RELATIVE to measured
//             clean floor)
//   Axis C -- perturbation bound: measureOpsAsync induces no majors on a
//             noop async workload
//   Axis D -- self-consistency: cold-run == warm-run verdict on maxBytesPerOp
//             for both clean and leaky workloads
//
// Portability discipline: NO absolute byte thresholds. Retained-object
// sizes vary by V8 build (pointer compression on/off, header layout).
// Fixed-size Array(1024) is heap-visible on every build; measured floor
// is the baseline; leak >> floor is the assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    measureOpsAsync, checkOpsAsync, assertOpsAsync,
    GcBudgetError
} from '../../Gc.js';

const noopAsync = async (i) => i | 0;

// =============================================================================
// AXIS A -- adversarial
// =============================================================================

test('[axis A] fn that throws synchronously propagates as promise rejection', async () => {
    // If we ate exceptions, users' CI would silently pass on broken workloads.
    // Pin the propagation contract.
    let called = 0;
    async function throwsAtFive(i) {
        called++;
        if (i === 5) throw new Error('sync boom at op 5');
    }
    await assert.rejects(
        () => measureOpsAsync(throwsAtFive, { ops: 30, warmup: 0 }),
        (e) => e instanceof Error && /sync boom at op 5/.test(e.message)
    );
    assert.ok(called <= 6, 'measurement must halt on throw; got ' + called + ' calls');
});

test('[axis A] async fn that rejects propagates as promise rejection', async () => {
    // Same contract for the awaited path.
    let called = 0;
    async function rejectAtFive(i) {
        called++;
        if (i === 5) throw new Error('async boom at op 5');
    }
    await assert.rejects(
        () => measureOpsAsync(rejectAtFive, { ops: 30, warmup: 0 }),
        (e) => e instanceof Error && /async boom at op 5/.test(e.message)
    );
    assert.ok(called <= 6, 'measurement must halt on async rejection; got ' + called);
});

test('[axis A] stabilize:true without --expose-gc throws before start', async () => {
    // Explicit intent honored: if you ask for stabilize but --expose-gc isn't
    // available, you get a clear RangeError at setup, not a silent fallback
    // that pretends to be stabilized. Guard fires before fn runs.
    if (typeof globalThis.gc === 'function') return; // skip if gc is available
    let workDone = false;
    await assert.rejects(
        () => measureOpsAsync(async () => { workDone = true; },
            { ops: 5, stabilize: true }),
        RangeError
    );
    assert.equal(workDone, false, 'stabilize-unavailable guard must fire before fn runs');
});

// =============================================================================
// AXIS B -- PIN PAIR (shape-defining invariants)
// =============================================================================

test('[axis B pin #1] warmup allocation is quarantined out of steady bytesPerOp', async () => {
    // Same shape as the frame-lane pin #1: heavy warmup + clean steady must
    // read a near-floor bytesPerOp. Stabilize forces a GC at the steady-start
    // boundary, so warmup allocation is collected out before the retained-
    // bytes baseline is read. If quarantine broke and warmup residue leaked
    // into the steady window, the heavy-warmup run would read a large
    // positive rate.
    //
    // Portable pattern: measure the clean floor on THIS machine and assert
    // heavy-warmup case stays within a small multiple of it. No absolute
    // byte thresholds -- they don't survive M4 Pro vs Intel differences.
    const warmupOps = 100, steadyOps = 300;

    const cleanRun = await measureOpsAsync(noopAsync, {
        ops: steadyOps, warmup: warmupOps
    });

    const heavySink = [];
    let hc = 0;
    async function heavyWarmupFn(i) {
        hc++;
        if (hc <= warmupOps) heavySink.push(new Array(1024).fill(i));
    }
    hc = 0;
    const heavyRun = await measureOpsAsync(heavyWarmupFn, {
        ops: steadyOps, warmup: warmupOps
    });

    assert.equal(cleanRun.bytesPerOpStable, true);
    assert.equal(heavyRun.bytesPerOpStable, true);
    // Guard against a zero clean floor -- ops-lane baselines can read
    // essentially zero on stabilize (post-GC live-set delta is a compacted
    // integer difference, not a slope with residual noise).
    const floor = Math.max(cleanRun.bytesPerOp, 64);
    assert.ok(heavyRun.bytesPerOp < 4 * floor,
        'PIN: heavy-warmup bytesPerOp (' + heavyRun.bytesPerOp + ') must stay within 4x '
        + 'of clean floor (' + cleanRun.bytesPerOp + '); the steady-start forced GC must '
        + 'quarantine warmup allocation out of the retained-bytes baseline');
});

test('[axis B pin #2] a real steady leak reads clearly above the clean floor', async () => {
    // Mirror pin: workload that retains a 1024-slot array per steady op
    // reads a bytesPerOp far above the clean floor -- in a SINGLE stabilized
    // run, no best-of-attempts crutch. Stabilize anchors both boundaries
    // with forced GC; the retained arrays show through as a true rate rather
    // than being lost under transient churn.
    //
    // Portable: relative-to-measured-floor threshold with a fixed-slot
    // Array(1024) payload that's heap-visible on every V8 build.
    const warmupOps = 100, steadyOps = 300;

    const clean = await measureOpsAsync(noopAsync, {
        ops: steadyOps, warmup: warmupOps
    });

    const steadySink = [];
    let cc = 0;
    async function leakyFn(i) {
        cc++;
        if (cc > warmupOps) steadySink.push(new Array(1024).fill(i));
    }
    cc = 0;
    const leak = await measureOpsAsync(leakyFn, {
        ops: steadyOps, warmup: warmupOps
    });

    assert.equal(clean.bytesPerOpStable, true);
    assert.equal(leak.bytesPerOpStable, true);
    const floor = Math.max(clean.bytesPerOp, 64);
    assert.ok(leak.bytesPerOp > 4 * floor,
        'PIN: a per-op array leak must read many times the clean floor ('
        + clean.bytesPerOp + '); got ' + leak.bytesPerOp);
});

// =============================================================================
// AXIS C -- perturbation bound
// =============================================================================

test('[axis C] measureOpsAsync induces no majors on a noop async workload', async () => {
    // If the async ops loop allocated on its own hot path (per-op closures,
    // stray promise chains internal to the primitive), it would show as
    // steady-phase majors here. Long-enough count to see any per-op drip.
    const r = await measureOpsAsync(noopAsync, { ops: 1000, warmup: 100 });
    const steady = r.summary.phases.steady && r.summary.phases.steady.gc;
    assert.ok(steady, 'steady phase present');
    assert.equal(steady.major, 0,
        'measureOpsAsync must not induce majors on noop; got ' + steady.major);
});

// =============================================================================
// AXIS D -- self-consistency
// =============================================================================

test('[axis D] cold-run and warm-run produce the same verdict on maxBytesPerOp', async () => {
    // The estimator's real adversary is GC timing, not scheduler timing.
    // Stabilize anchors both boundaries with a forced GC, so a clean
    // workload reads ~0 and a real leak reads its true rate regardless of
    // whether the process is cold or warm. Both a clean and a leaky
    // workload must produce identical verdicts on their first and second
    // run. Threshold sits well above the resolution floor and well below
    // the leak; the pin is verdict stability.
    const sink = [];
    const leakyFn = async (i) => { sink.push(new Array(1024).fill(i)); };
    const opts = { ops: 300, warmup: 100 };
    const RULE = { maxBytesPerOp: 512 };

    const cClean = checkOpsAsync(await measureOpsAsync(noopAsync, opts), RULE);
    const wClean = checkOpsAsync(await measureOpsAsync(noopAsync, opts), RULE);
    assert.equal(cClean.verdict, wClean.verdict,
        'clean cold/warm verdict mismatch: ' + cClean.verdict + ' vs ' + wClean.verdict);
    assert.equal(cClean.verdict, 'pass', 'clean async workload must pass maxBytesPerOp:512');

    sink.length = 0;
    const cLeak = checkOpsAsync(await measureOpsAsync(leakyFn, opts), RULE);
    sink.length = 0;
    const wLeak = checkOpsAsync(await measureOpsAsync(leakyFn, opts), RULE);
    assert.equal(cLeak.verdict, wLeak.verdict,
        'leaky cold/warm verdict mismatch: ' + cLeak.verdict + ' vs ' + wLeak.verdict);
    assert.equal(cLeak.verdict, 'fail',
        'a per-op array leak must fail maxBytesPerOp:512');
});

test('[axis D] shape-stability: result shape is identical across cold/warm runs', async () => {
    // Every key in the result shape must be present regardless of run history.
    const REQUIRED_KEYS = [
        'schema', 'ops', 'warmupOps', 'elapsedMs', 'opsPerSec',
        'bytesPerOp', 'bytesPerOpStable', 'majorsPerKOp', 'minorsPerKOp',
        'maxPauseMsPerOp', 'asyncResidual', 'source', 'summary'
    ];
    const cold = await measureOpsAsync(noopAsync, { ops: 100, warmup: 20 });
    const warm = await measureOpsAsync(noopAsync, { ops: 100, warmup: 20 });
    for (const k of REQUIRED_KEYS) {
        assert.ok(k in cold, 'cold result missing key: ' + k);
        assert.ok(k in warm, 'warm result missing key: ' + k);
    }
});
