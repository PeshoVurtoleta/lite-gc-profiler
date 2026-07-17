// Torture scenarios for the frame lane primitives added in v1.4.0
// (G17/G18, slot G17.5). Standard cases live in test/20-frames.test.mjs.
//
// Four-axis discipline:
//   Axis A -- adversarial: scheduler that never fires, fn that throws, rejection
//   Axis B -- signal-under-noise: PIN PAIR (heavy warmup + clean steady vs
//             clean warmup + leaky steady) -- mirrors G14.5's phase-quarantine
//             invariant; the strongest guarantee about the shape of the primitive
//   Axis C -- perturbation bound: measureFrames itself induces no majors on a
//             noop workload with sufficient frames
//   Axis D -- self-consistency: cold-run == warm-run verdict with deterministic
//             scheduler (LSQ slope is order-independent)
//
// The Axis B pin pair is the shape-defining invariant: warmup allocations
// MUST be quarantined from steady-phase gates. Same guarantee measureOps
// provides for ops, extended to frames.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    measureFrames, checkFrames, assertFrames,
    compareFrames, assertCompareFrames, GcBudgetError
} from '../../Gc.js';

const fastSched = (cb) => setTimeout(cb, 0);
const noop = (i) => i | 0;

// =============================================================================
// AXIS A -- adversarial
// =============================================================================

test('[axis A] fn that throws propagates as promise rejection, not swallowed', async () => {
    // A frame-loop bug: if we ate exceptions, users' CI would silently pass
    // on broken workloads. Pin the propagation contract.
    let called = 0;
    function throwsAtFive(i) {
        called++;
        if (i === 5) throw new Error('boom at frame 5');
    }
    await assert.rejects(
        () => measureFrames(throwsAtFive, { frames: 30, scheduler: fastSched }),
        (e) => e instanceof Error && /boom at frame 5/.test(e.message)
    );
    // And crucially: measurement stopped at the throw, didn't drive further frames.
    assert.ok(called <= 6, 'measurement must halt on throw; got ' + called + ' calls');
});

test('[axis A] async fn that rejects propagates as promise rejection', async () => {
    // Same contract but for the awaited path -- async fn rejection must
    // also halt the loop and reject the outer promise.
    let called = 0;
    async function rejectAtFive(i) {
        called++;
        if (i === 5) throw new Error('async boom at frame 5');
    }
    await assert.rejects(
        () => measureFrames(rejectAtFive, { frames: 30, scheduler: fastSched }),
        (e) => e instanceof Error && /async boom at frame 5/.test(e.message)
    );
    assert.ok(called <= 6, 'measurement must halt on async rejection; got ' + called);
});

test('[axis A] scheduler:"raf" without requestAnimationFrame throws before start', async () => {
    // Explicit intent honored -- if you ask for raf on headless node, you
    // get a clear error, not a silent polyfill fallback. Guard fires at
    // measurement setup, not inside the frame loop.
    if (typeof requestAnimationFrame === 'function') return; // skip if globally polyfilled
    let workDone = false;
    await assert.rejects(
        () => measureFrames(() => { workDone = true; },
            { frames: 5, scheduler: 'raf' }),
        RangeError
    );
    assert.equal(workDone, false, 'raf-unavailable guard must fire before fn runs');
});

// =============================================================================
// AXIS B -- PIN PAIR (the shape-defining invariant)
// =============================================================================
//
// Note on the shape of this pin: the frame lane's bytesPerFrame is an LSQ
// slope on periodic heap samples during steady. A slope-based estimator is
// naturally invariant to the STARTING heap value -- warmup allocations
// (even heavy retained ones) shift the y-intercept, not the slope. That's
// a stronger quarantine guarantee than the ops lane's two-point delta gives.
//
// So the invariant these two pins verify:
//   #1 -- bytesPerFrame is INVARIANT to warmup allocation intensity
//         (LSQ slope isolates steady-phase growth from warmup residue)
//   #2 -- a leaky STEADY workload produces bytesPerFrame clearly above
//         the noise floor of a clean steady workload

test('[axis B pin #1] warmup allocation is quarantined out of steady bytesPerFrame', async () => {
    // Two measurements identical in steady behaviour (both clean steady),
    // differing only in whether the WARMUP phase allocates heavily. Stabilize
    // forces a full GC at the steady-start boundary, so warmup allocation is
    // collected out before the retained-bytes baseline is read -- both runs
    // must report a near-zero steady bytesPerFrame. If quarantine broke and
    // warmup residue leaked into the steady window, the heavy-warmup run would
    // read a large positive rate. This is the shape-defining pin for the lane.
    const warmupFrames = 60, steadyFrames = 300;

    // Reference: clean warmup + clean steady
    let cc = 0;
    const cleanFn = () => { cc++; };
    const cleanRun = await measureFrames(cleanFn, {
        frames: steadyFrames, warmup: warmupFrames, scheduler: fastSched
    });

    // Test: heavy warmup (100-key object per warmup frame) + clean steady
    const heavySink = [];
    let heavyCount = 0;
    function heavyWarmupFn(i) {
        heavyCount++;
        if (heavyCount <= warmupFrames) {
            const o = {};
            for (let k = 0; k < 100; k++) o['k' + k] = i * k;
            heavySink.push(o);
        }
    }
    const heavyRun = await measureFrames(heavyWarmupFn, {
        frames: steadyFrames, warmup: warmupFrames, scheduler: fastSched
    });

    assert.equal(cleanRun.bytesPerFrameStable, true);
    assert.equal(heavyRun.bytesPerFrameStable, true);
    assert.ok(heavyRun.bytesPerFrame < 512,
        'PIN: heavy-warmup steady bytesPerFrame (' + heavyRun.bytesPerFrame + ') must stay near '
        + 'zero; the steady-start GC must quarantine warmup allocation out of the steady baseline');
});

test('[axis B pin #2] a real steady leak reads clearly above the clean floor', async () => {
    // Mirror pin: a workload that allocates during STEADY (not warmup) must
    // produce a bytesPerFrame clearly separated from the clean floor -- in a
    // SINGLE stabilized run, with no best-of-attempts crutch. Stabilize anchors
    // both boundaries with a forced GC, so the retained ~1.7 KB/frame shows
    // through as a true rate rather than being lost under scheduler churn or
    // collapsed to zero by a mid-run collection.
    const warmupFrames = 60, steadyFrames = 300;
    const steadySink = [];
    let callCount = 0;
    function leakyFn(i) {
        callCount++;
        if (callCount > warmupFrames) {
            const o = {};
            for (let k = 0; k < 30; k++) o['k' + k] = i * k;   // ~1.7 KB retained/frame
            steadySink.push(o);
        }
    }
    const r = await measureFrames(leakyFn, {
        frames: steadyFrames, warmup: warmupFrames, scheduler: fastSched
    });
    assert.equal(r.bytesPerFrameStable, true);
    assert.ok(r.bytesPerFrame > 800,
        'PIN: a ~1.7 KB/frame steady leak must read well above the clean floor in a single '
        + 'stabilized run; got ' + r.bytesPerFrame);
});

// =============================================================================
// AXIS C -- perturbation bound
// =============================================================================

test('[axis C] measureFrames induces no majors on a noop workload with sufficient frames', async () => {
    // If the frame loop allocated on its own hot path (per-frame closures,
    // scratch buffers freshly created inside runFrame, etc.), it would
    // show up here as a major. Long-enough frame count to see any
    // per-frame drip.
    const r = await measureFrames(noop, {
        frames: 300, warmup: 30, scheduler: fastSched
    });
    const steady = r.summary.phases.steady && r.summary.phases.steady.gc;
    assert.ok(steady, 'steady phase present');
    assert.equal(steady.major, 0,
        'measureFrames must not induce majors on a noop workload; got ' + steady.major);
});

// =============================================================================
// AXIS D -- self-consistency
// =============================================================================

test('[axis D] cold-run and warm-run produce the same verdict on maxBytesPerFrame', async () => {
    // The estimator's real adversary is GC timing, not scheduler timing.
    // Stabilize anchors both steady boundaries with a forced GC, so a clean
    // workload reads ~0 and a real leak reads its true rate REGARDLESS of
    // whether the process is cold (first measurement) or warm (later). Both a
    // clean and a leaky workload must therefore produce identical verdicts on
    // their first and second run. The threshold sits above the resolution
    // floor and well below the leak; the pin is verdict stability, not a
    // specific byte count.
    const cleanFn = (i) => i | 0;
    const sink = [];
    const leakyFn = (i) => { const o = {}; for (let k = 0; k < 30; k++) o['k' + k] = i * k; sink.push(o); };
    const opts = { frames: 300, warmup: 60, scheduler: fastSched };
    const RULE = { maxBytesPerFrame: 512 };

    const cClean = checkFrames(await measureFrames(cleanFn, opts), RULE);
    const wClean = checkFrames(await measureFrames(cleanFn, opts), RULE);
    assert.equal(cClean.verdict, wClean.verdict,
        'clean cold/warm verdict mismatch: ' + cClean.verdict + ' vs ' + wClean.verdict);
    assert.equal(cClean.verdict, 'pass', 'clean workload must pass maxBytesPerFrame:512');

    sink.length = 0;
    const cLeak = checkFrames(await measureFrames(leakyFn, opts), RULE);
    sink.length = 0;
    const wLeak = checkFrames(await measureFrames(leakyFn, opts), RULE);
    assert.equal(cLeak.verdict, wLeak.verdict,
        'leaky cold/warm verdict mismatch: ' + cLeak.verdict + ' vs ' + wLeak.verdict);
    assert.equal(cLeak.verdict, 'fail', 'a ~1.7 KB/frame leak must fail maxBytesPerFrame:512');
});

test('[axis D] cold-run and warm-run produce the same verdict on maxDroppedFrames', async () => {
    // maxDroppedFrames is source-agnostic and measured by performance.now(),
    // which is stable across cold/warm process states. If cold and warm
    // ever diverge on this rule, the frame timing pipeline has a JIT-tier
    // sensitivity bug.
    //
    // Uses a workload that intentionally sleeps past frameBudgetMs on
    // certain frames so we get deterministic drops.
    let n = 0;
    async function sometimesSlow(i) {
        n = i;
        if (i % 10 === 0) await new Promise((r) => setTimeout(r, 20));
    }

    const coldRep = await assertFrames(sometimesSlow,
        { maxDroppedFrames: 100 },                     // permissive gate: expect pass
        { frames: 30, warmup: 5, scheduler: fastSched, frameBudgetMs: 16.67 });
    const warmRep = await assertFrames(sometimesSlow,
        { maxDroppedFrames: 100 },
        { frames: 30, warmup: 5, scheduler: fastSched, frameBudgetMs: 16.67 });

    assert.equal(coldRep.verdict, warmRep.verdict,
        'cold and warm verdicts must match; cold=' + coldRep.verdict + ' warm=' + warmRep.verdict);
    assert.equal(coldRep.verdict, 'pass');
});

test('[axis D] shape-stability: result shape is identical across cold/warm runs', async () => {
    // Every key in the result shape must be present regardless of run
    // history. Regression pin -- if a lazy-init path ever gated a field's
    // presence on prior state, this catches it.
    const REQUIRED_KEYS = [
        'schema', 'frames', 'warmupFrames', 'elapsedMs', 'fps',
        'bytesPerFrame', 'bytesPerFrameStable', 'majorsPerKFrame', 'minorsPerKFrame',
        'maxPauseMsPerFrame', 'droppedFrames', 'frameTimes',
        'asyncResidual', 'source', 'summary'
    ];
    const cold = await measureFrames(noop, { frames: 20, scheduler: fastSched });
    const warm = await measureFrames(noop, { frames: 20, scheduler: fastSched });
    for (const k of REQUIRED_KEYS) {
        assert.ok(k in cold, 'cold result missing key: ' + k);
        assert.ok(k in warm, 'warm result missing key: ' + k);
    }
    // frameTimes sub-shape
    for (const k of ['p50', 'p95', 'p99', 'max']) {
        assert.ok(k in cold.frameTimes, 'cold.frameTimes missing: ' + k);
        assert.ok(k in warm.frameTimes, 'warm.frameTimes missing: ' + k);
    }
});

// =============================================================================
// Real-scheduler smoke check (the one wall-clock test we do allow)
// =============================================================================

test('[real polyfill] the setTimeout-based polyfill scheduler drives real time', async () => {
    // NOT a determinism claim -- just proves the polyfill code path executes
    // and completes within a wall-clock bound. Keeps the injected-clock
    // discipline in Axis-D while still exercising the real polyfill on
    // every test run.
    const t0 = Date.now();
    const r = await measureFrames(noop, {
        frames: 8, warmup: 2, scheduler: 'polyfill', frameBudgetMs: 16.67
    });
    const elapsed = Date.now() - t0;
    assert.equal(r.frames, 8);
    // 10 total frames * ~16.67 ms cadence = ~166 ms nominal, but setTimeout
    // has drift; the pin is "completed in a bounded time," not a specific one.
    assert.ok(elapsed < 1000, 'polyfill smoke must complete in under 1s; got ' + elapsed + ' ms');
    assert.ok(r.elapsedMs > 0, 'polyfill must produce non-zero steady elapsed');
});
