// Standard-case tests for the per-frame primitives introduced in Batch 7
// (v1.4.0, G17/G18). Adversarial cases live in
// test/torture/g17-5-frames.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    measureFrames, checkFrames, assertFrames,
    compareFrames, assertCompareFrames,
    GcBudgetError, GcInconclusiveError,
    VERDICT_MATRIX
} from '../Gc.js';

// Deterministic + fast injected scheduler for tests. Fires the callback
// on the next macrotask so it orders correctly with gc.settle() (which
// also uses setTimeout under the hood). This is the D14 escape hatch:
// tests use it universally so CI wall-clock stays low; one dedicated
// smoke test exercises the real polyfill path.
function fastSched(cb) { return setTimeout(cb, 0); }

const noopWorkload = (i) => i | 0;
const leakyWorkload = (sink) => (i) => { sink.push({ a: i, b: i * 2, c: 'x' }); };

// -----------------------------------------------------------------------------
// measureFrames -- shape and basic semantics
// -----------------------------------------------------------------------------

test('measureFrames returns the documented shape', async () => {
    const r = await measureFrames(noopWorkload, {
        frames: 60, warmup: 10, scheduler: fastSched
    });
    assert.equal(r.schema, 'lite-gc-frames/1');
    assert.equal(r.frames, 60);
    assert.equal(r.warmupFrames, 10);
    assert.ok(r.elapsedMs >= 0);
    assert.ok(r.fps >= 0);
    assert.ok(r.bytesPerFrame === null || typeof r.bytesPerFrame === 'number');
    assert.equal(typeof r.majorsPerKFrame, 'number');
    assert.equal(typeof r.minorsPerKFrame, 'number');
    assert.equal(typeof r.maxPauseMsPerFrame, 'number');
    assert.equal(typeof r.droppedFrames, 'number');
    assert.equal(typeof r.asyncResidual, 'number');
    assert.ok(r.frameTimes && typeof r.frameTimes.p50 === 'number');
    assert.ok(r.frameTimes.p95 >= r.frameTimes.p50, 'p95 >= p50');
    assert.ok(r.frameTimes.p99 >= r.frameTimes.p95, 'p99 >= p95');
    assert.ok(r.frameTimes.max >= r.frameTimes.p99, 'max >= p99');
    assert.ok(r.summary && r.summary.schema === 'lite-gc/1');
});

test('measureFrames: summary has both warmup and steady phases even when warmup=0', async () => {
    const r = await measureFrames(noopWorkload, {
        frames: 20, warmup: 0, scheduler: fastSched
    });
    assert.ok(r.summary.phases.warmup, 'warmup phase must exist even when warmup=0');
    assert.ok(r.summary.phases.steady, 'steady phase must always exist');
});

test('measureFrames: bytesPerFrame is derivable on node (source=gc)', async () => {
    const r = await measureFrames(noopWorkload, {
        frames: 100, warmup: 10, scheduler: fastSched
    });
    assert.equal(r.source, 'gc');
    assert.notEqual(r.bytesPerFrame, null,
        'bytesPerFrame must be derivable on node with default source');
});

test('measureFrames: stabilizes by default under --expose-gc and a clean workload reads ~0', async () => {
    // With globalThis.gc available, measureFrames auto-stabilizes: it forces a
    // full GC at each steady boundary and reports the retained live-set delta.
    // A workload that retains nothing must read near zero -- well under the
    // ~1000+ B/frame phantom floor the raw-heap slope estimate produced.
    const r = await measureFrames(noopWorkload, {
        frames: 300, warmup: 60, scheduler: fastSched
    });
    assert.equal(r.bytesPerFrameStable, true, 'must be stabilized under --expose-gc');
    assert.ok(r.bytesPerFrame < 512,
        'clean workload bytesPerFrame must be near zero when stabilized; got ' + r.bytesPerFrame);
});

test('measureFrames: a real steady leak reads clearly above the clean floor', async () => {
    // Relative to the floor measured on THIS machine -- retained object sizes
    // are V8-build dependent, so absolute byte thresholds are not portable.
    const clean = await measureFrames(noopWorkload, {
        frames: 300, warmup: 60, scheduler: fastSched
    });
    const sink = [];
    const leaky = (i) => { sink.push(new Array(1024).fill(i)); };   // heap-visible
    const leak = await measureFrames(leaky, {
        frames: 300, warmup: 60, scheduler: fastSched
    });
    assert.equal(leak.bytesPerFrameStable, true);
    const floor = Math.max(clean.bytesPerFrame, 128);
    assert.ok(leak.bytesPerFrame > 4 * floor,
        'a per-frame array leak must read many times the clean floor ('
        + clean.bytesPerFrame + '); got ' + leak.bytesPerFrame);
});

test('measureFrames: stabilize:false uses the slope estimate and flags bytesPerFrameStable:false', async () => {
    const r = await measureFrames(noopWorkload, {
        frames: 120, warmup: 30, scheduler: fastSched, stabilize: false
    });
    assert.equal(r.bytesPerFrameStable, false,
        'explicit stabilize:false must not GC-anchor');
    assert.notEqual(r.bytesPerFrame, null);
});

test('measureFrames: stabilize:true rejects when globalThis.gc is unavailable', async () => {
    const saved = globalThis.gc;
    // Simulate a runtime without --expose-gc.
    try { delete globalThis.gc; } catch { globalThis.gc = undefined; }
    try {
        await assert.rejects(
            () => measureFrames(noopWorkload, {
                frames: 60, warmup: 10, scheduler: fastSched, stabilize: true
            }),
            (e) => e instanceof RangeError && /--expose-gc/.test(e.message)
        );
    } finally {
        globalThis.gc = saved;
    }
});

test('measureFrames: bytesPerFrame is null on source=none', async () => {
    const r = await measureFrames(noopWorkload, {
        frames: 60, source: 'none', scheduler: fastSched
    });
    assert.equal(r.source, 'none');
    assert.equal(r.bytesPerFrame, null,
        'bytesPerFrame must be null when no memory channel is available');
});

test('measureFrames: awaits Promise returned by fn before advancing', async () => {
    // If we don't await, per-frame work time collapses and multi-frame
    // ordering breaks. Prove the await path fires by using an async fn.
    let calls = 0;
    async function asyncFn(i) {
        calls++;
        await Promise.resolve();
        calls++;                                       // must increment before next frame
    }
    const r = await measureFrames(asyncFn, {
        frames: 30, warmup: 5, scheduler: fastSched
    });
    // Each frame does 2 increments; total = (warmup + frames) * 2 = 70.
    assert.equal(calls, (5 + 30) * 2,
        'async fn body must complete before next frame; got ' + calls + ' calls');
    assert.equal(r.frames, 30);
});

// -----------------------------------------------------------------------------
// measureFrames -- input validation
// -----------------------------------------------------------------------------

test('measureFrames: rejects when fn is not a function', async () => {
    await assert.rejects(() => measureFrames(null, { frames: 10 }), TypeError);
    await assert.rejects(() => measureFrames(42, { frames: 10 }), TypeError);
});

test('measureFrames: rejects when frames is missing/invalid', async () => {
    await assert.rejects(() => measureFrames(noopWorkload, {}), RangeError);
    await assert.rejects(() => measureFrames(noopWorkload, { frames: 0 }), RangeError);
    await assert.rejects(() => measureFrames(noopWorkload, { frames: -1 }), RangeError);
    await assert.rejects(() => measureFrames(noopWorkload, { frames: 1.5 }), RangeError);
    await assert.rejects(() => measureFrames(noopWorkload, { frames: Infinity }), RangeError);
});

test('measureFrames: rejects when warmup is negative or non-integer', async () => {
    await assert.rejects(
        () => measureFrames(noopWorkload, { frames: 10, warmup: -1 }), RangeError);
    await assert.rejects(
        () => measureFrames(noopWorkload, { frames: 10, warmup: 1.5 }), RangeError);
});

test('measureFrames: rejects when frameBudgetMs is not a positive finite', async () => {
    await assert.rejects(
        () => measureFrames(noopWorkload, { frames: 10, frameBudgetMs: 0 }), RangeError);
    await assert.rejects(
        () => measureFrames(noopWorkload, { frames: 10, frameBudgetMs: -1 }), RangeError);
    await assert.rejects(
        () => measureFrames(noopWorkload, { frames: 10, frameBudgetMs: Infinity }), RangeError);
});

test('measureFrames: rejects when scheduler is an invalid string', async () => {
    await assert.rejects(
        () => measureFrames(noopWorkload, { frames: 10, scheduler: 'bogus' }), TypeError);
});

// -----------------------------------------------------------------------------
// Scheduler resolution
// -----------------------------------------------------------------------------

test('measureFrames: scheduler:"polyfill" runs on node without rAF', async () => {
    // The polyfill scheduler is what makes headless measurement possible.
    // Small frame count so wall-clock stays bounded (< 300 ms).
    const r = await measureFrames(noopWorkload, {
        frames: 10, warmup: 2, scheduler: 'polyfill'
    });
    assert.equal(r.frames, 10);
    assert.ok(r.elapsedMs > 0, 'polyfill must advance real time');
});

test('measureFrames: scheduler:"raf" rejects on node without requestAnimationFrame', async () => {
    // Explicit intent honored: if you ask for raf, you get raf or an error --
    // not a silent polyfill fallback that pretends to be raf.
    if (typeof requestAnimationFrame === 'function') return; // skip if rAF is polyfilled globally
    await assert.rejects(
        () => measureFrames(noopWorkload, { frames: 5, scheduler: 'raf' }),
        RangeError
    );
});

test('measureFrames: scheduler as function is used directly (D14 escape hatch)', async () => {
    let ticks = 0;
    function customSched(cb) { ticks++; return setTimeout(cb, 0); }
    const r = await measureFrames(noopWorkload, {
        frames: 10, warmup: 3, scheduler: customSched
    });
    assert.equal(r.frames, 10);
    assert.equal(ticks, 13, 'custom scheduler must be called for every frame; got ' + ticks);
});

// -----------------------------------------------------------------------------
// VERDICT_MATRIX -- per-frame rules present with all four source columns
// -----------------------------------------------------------------------------

test('VERDICT_MATRIX contains the five per-frame rules with all source columns', () => {
    const expected = ['gc', 'heap', 'uasm', 'none'];
    const perFrameRules = [
        'maxBytesPerFrame', 'maxMajorsPerKFrame', 'maxMinorsPerKFrame',
        'maxPauseMsPerFrame', 'maxDroppedFrames'
    ];
    for (const rule of perFrameRules) {
        assert.ok(VERDICT_MATRIX[rule], 'missing rule row ' + rule);
        for (const src of expected) {
            assert.ok(VERDICT_MATRIX[rule][src] !== undefined,
                'rule ' + rule + ' missing column ' + src);
        }
    }
});

test('VERDICT_MATRIX: maxDroppedFrames is source-agnostic (yes on every source)', () => {
    // The one rule that gates on 'none'. This validates the matrix
    // design generalizes -- adding a source-agnostic rule didn't require
    // any special case, just the right column values.
    assert.equal(VERDICT_MATRIX.maxDroppedFrames.gc, 'yes');
    assert.equal(VERDICT_MATRIX.maxDroppedFrames.heap, 'yes');
    assert.equal(VERDICT_MATRIX.maxDroppedFrames.uasm, 'yes');
    assert.equal(VERDICT_MATRIX.maxDroppedFrames.none, 'yes');
});

test('VERDICT_MATRIX: kind-per-frame rules mirror kind-per-op verifiability', () => {
    for (const rule of ['maxMajorsPerKFrame', 'maxMinorsPerKFrame', 'maxPauseMsPerFrame']) {
        assert.equal(VERDICT_MATRIX[rule].gc, 'yes');
        assert.equal(VERDICT_MATRIX[rule].heap, 'no');
        assert.equal(VERDICT_MATRIX[rule].uasm, 'no');
        assert.equal(VERDICT_MATRIX[rule].none, 'no');
    }
});

// -----------------------------------------------------------------------------
// checkFrames / assertFrames
// -----------------------------------------------------------------------------

test('checkFrames: pass on clean workload with reasonable maxDroppedFrames', async () => {
    const r = await measureFrames(noopWorkload, {
        frames: 30, warmup: 5, scheduler: fastSched
    });
    const rep = checkFrames(r, { maxDroppedFrames: 30 });
    assert.equal(rep.verdict, 'pass');
    assert.equal(rep.kind, 'frames');
});

test('checkFrames: inconclusive when a rule can\'t be verified on source=none', async () => {
    const r = await measureFrames(noopWorkload, {
        frames: 30, source: 'none', scheduler: fastSched
    });
    const rep = checkFrames(r, { maxBytesPerFrame: 0 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checked.maxBytesPerFrame, false);
});

test('checkFrames: maxDroppedFrames works even on source=none', async () => {
    // The source-agnostic rule. Users with a memory-unaware runtime can
    // still gate on dropped frames.
    const r = await measureFrames(noopWorkload, {
        frames: 30, source: 'none', scheduler: fastSched
    });
    const rep = checkFrames(r, { maxDroppedFrames: 30 });
    assert.equal(rep.verdict, 'pass');
    assert.equal(rep.checked.maxDroppedFrames, true);
});

test('checkFrames: throws when result is not a measureFrames result', () => {
    assert.throws(() => checkFrames({}, {}), TypeError);
    assert.throws(() => checkFrames(null, {}), TypeError);
    assert.throws(() => checkFrames({ schema: 'lite-gc-ops/1' }, {}), TypeError);
});

test('assertFrames: returns the report on pass', async () => {
    const rep = await assertFrames(noopWorkload,
        { maxDroppedFrames: 30 },
        { frames: 20, warmup: 3, scheduler: fastSched });
    assert.equal(rep.verdict, 'pass');
});

test('assertFrames: throws GcBudgetError when a rule is exceeded', async () => {
    // Force a violation with a very tight budget on a workload that will
    // naturally have some measurable work time. maxDroppedFrames: -1 makes
    // any frame count fail the rule (-1 is unreachable ceiling).
    await assert.rejects(
        () => assertFrames(noopWorkload,
            { maxDroppedFrames: -1 },
            { frames: 20, warmup: 3, scheduler: fastSched }),
        GcBudgetError
    );
});

test('assertFrames: throws GcInconclusiveError when rule is unverifiable', async () => {
    await assert.rejects(
        () => assertFrames(noopWorkload,
            { maxBytesPerFrame: 0 },
            { frames: 20, source: 'none', scheduler: fastSched }),
        GcInconclusiveError
    );
});

test('assertFrames: passes through inconclusive when allowInconclusive is set', async () => {
    const rep = await assertFrames(noopWorkload,
        { maxBytesPerFrame: 0 },
        { frames: 20, source: 'none', scheduler: fastSched, allowInconclusive: true });
    assert.equal(rep.verdict, 'inconclusive');
});

// -----------------------------------------------------------------------------
// compareFrames / assertCompareFrames
// -----------------------------------------------------------------------------

test('compareFrames: two results, clean deltas -> pass', async () => {
    const ctl = await measureFrames(noopWorkload, {
        frames: 30, warmup: 5, scheduler: fastSched
    });
    const can = await measureFrames(noopWorkload, {
        frames: 30, warmup: 5, scheduler: fastSched
    });
    const rep = await compareFrames(ctl, can, { maxExtraDroppedFrames: 30 });
    assert.equal(rep.verdict, 'pass');
});

test('compareFrames: convenience form (two functions)', async () => {
    const rep = await compareFrames(noopWorkload, noopWorkload,
        { maxExtraDroppedFrames: 30 },
        { frames: 20, warmup: 3, scheduler: fastSched });
    assert.equal(rep.verdict, 'pass');
});

test('compareFrames: source mismatch -> inconclusive', async () => {
    const ctl = await measureFrames(noopWorkload, {
        frames: 20, source: 'gc', scheduler: fastSched
    });
    const can = await measureFrames(noopWorkload, {
        frames: 20, source: 'none', scheduler: fastSched
    });
    const rep = await compareFrames(ctl, can, { maxExtraDroppedFrames: 0 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.reason, 'source_mismatch');
});

test('assertCompareFrames: returns report on pass', async () => {
    const rep = await assertCompareFrames(noopWorkload, noopWorkload,
        { maxExtraDroppedFrames: 30 },
        { frames: 20, warmup: 3, scheduler: fastSched });
    assert.equal(rep.verdict, 'pass');
});

// -----------------------------------------------------------------------------
// asyncResidual smoke detector
// -----------------------------------------------------------------------------

test('measureFrames: asyncResidual is reported (non-negative number)', async () => {
    // asyncResidual measures heap growth AFTER settle. Positive value
    // signals fire-and-forget work outliving the measurement window.
    // Not a gate rule, just a smoke detector -- but must always be present
    // in the result shape.
    const r = await measureFrames(noopWorkload, {
        frames: 30, warmup: 5, scheduler: fastSched
    });
    assert.equal(typeof r.asyncResidual, 'number');
    assert.ok(r.asyncResidual >= 0, 'asyncResidual is a non-negative byte count');
});
