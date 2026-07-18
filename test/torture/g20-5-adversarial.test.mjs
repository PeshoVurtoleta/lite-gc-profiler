// Adversarial torture suite (Batch 8, G20).
//
// Everything here started as a successful attack on the library. Each test is
// a regression pin for a defect that was found by trying to break the gate
// rather than by trying to use it. The unifying theme of the serious findings
// was FAIL-OPEN behaviour: a budget gate that silently reports 'pass' is worse
// than no gate at all, because CI stays green while the invariant rots.
//
// Three independent routes reached a false 'pass', all now closed:
//   1. an unknown rule key (a typo) matched no rule and gated nothing;
//   2. a NaN threshold compared false and gated nothing, while the report
//      claimed checked:{rule:true};
//   3. a NaN metric (broken clock / mocked timer) compared false the same way.
//
// The rest cover resource safety under aborted runs, overlapping measurements
// (which silently cross-contaminate because every lane shares one heap),
// option validation, and survival under extreme garbage pressure.
//
// Byte assertions here are RELATIVE to a measured floor wherever a magnitude
// is involved: retained object sizes are V8-build dependent, so absolute
// thresholds are not portable across machines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    measureOps, measureFrames, measureOpsAsync,
    checkOps, checkFrames, checkOpsAsync,
    compareOps, compareFrames, compareOpsAsync
} from '../../Gc.js';

const fastSched = (cb) => setTimeout(cb, 0);
const noop = (i) => i | 0;

// =============================================================================
// AXIS A -- fail-closed rule validation (unknown keys)
// =============================================================================

test('[axis A] unknown rule key is rejected, not silently ignored', () => {
    const r = measureOps(noop, { ops: 200, warmup: 20, stabilize: true });
    // Before: verdict 'pass' with checked:{} -- the gate enforced nothing and
    // reported green. A typo in CI would never be noticed.
    assert.throws(() => checkOps(r, { maxBytesPerOP: 20 }), TypeError);
    assert.throws(() => checkOps(r, { maxBytesPerOps: 20 }), TypeError);
    assert.throws(() => checkOps(r, { max_bytes_per_op: 20 }), TypeError);
});

test('[axis A] unknown-rule error names the offending key and suggests the real one', () => {
    const r = measureOps(noop, { ops: 200, warmup: 20, stabilize: true });
    try {
        checkOps(r, { maxBytesPerOP: 20 });
        assert.fail('must throw');
    } catch (e) {
        assert.ok(/maxBytesPerOP/.test(e.message), 'must name the bad key: ' + e.message);
        assert.ok(/Did you mean maxBytesPerOp\?/.test(e.message), 'must suggest the fix: ' + e.message);
    }
});

test('[axis A] unknown rule keys rejected across EVERY gate entry point', async () => {
    const ops = measureOps(noop, { ops: 200, warmup: 20, stabilize: true });
    const frames = await measureFrames(noop, { frames: 60, warmup: 10, scheduler: fastSched });
    const asyncR = await measureOpsAsync(async (i) => i | 0, { ops: 100, warmup: 10 });
    const ops2 = measureOps(noop, { ops: 200, warmup: 20, stabilize: true });
    const frames2 = await measureFrames(noop, { frames: 60, warmup: 10, scheduler: fastSched });
    const asyncR2 = await measureOpsAsync(async (i) => i | 0, { ops: 100, warmup: 10 });

    assert.throws(() => checkOps(ops, { bogusRule: 1 }), TypeError, 'checkOps');
    assert.throws(() => checkFrames(frames, { bogusRule: 1 }), TypeError, 'checkFrames');
    assert.throws(() => checkOpsAsync(asyncR, { bogusRule: 1 }), TypeError, 'checkOpsAsync');
    assert.throws(() => compareOps(ops, ops2, { bogusRule: 1 }), TypeError, 'compareOps');
    await assert.rejects(() => compareFrames(frames, frames2, { bogusRule: 1 }), TypeError, 'compareFrames');
    await assert.rejects(() => compareOpsAsync(asyncR, asyncR2, { bogusRule: 1 }), TypeError, 'compareOpsAsync');
});

test('[axis A] a rule the lane does not implement is rejected rather than ignored', async () => {
    // compareFrames implements only bytes + dropped deltas. Accepting a
    // plausible-looking maxExtraMajorsPerKFrame would silently gate nothing --
    // exactly the hole this axis exists to close.
    const a = await measureFrames(noop, { frames: 60, warmup: 10, scheduler: fastSched });
    const b = await measureFrames(noop, { frames: 60, warmup: 10, scheduler: fastSched });
    await assert.rejects(
        () => compareFrames(a, b, { maxExtraMajorsPerKFrame: 0 }),
        TypeError
    );
});

test('[axis A] explicit undefined is treated as "rule omitted", not as unknown', () => {
    const r = measureOps(noop, { ops: 200, warmup: 20, stabilize: true });
    const rep = checkOps(r, { maxBytesPerOp: undefined });
    assert.equal(rep.verdict, 'pass');
    assert.deepEqual(rep.checked, {});
});

// =============================================================================
// AXIS B -- fail-closed thresholds (non-finite / non-numeric limits)
// =============================================================================

test('[axis B] NaN threshold is rejected instead of passing everything', () => {
    const sink = [];
    const leaky = (i) => { sink.push(new Array(64).fill(i)); return i; };
    const r = measureOps(leaky, { ops: 400, warmup: 40, stabilize: true });
    // Before: verdict 'pass' AND checked:{maxBytesPerOp:true} -- the report
    // asserted it had enforced a rule that could never fire.
    assert.throws(() => checkOps(r, { maxBytesPerOp: NaN }), RangeError);
});

test('[axis B] non-numeric threshold throws a clear error, not a formatter crash', () => {
    const sink = [];
    const leaky = (i) => { sink.push(new Array(64).fill(i)); return i; };
    const r = measureOps(leaky, { ops: 400, warmup: 40, stabilize: true });
    // Before: a string limit passed the comparison via coercion and then hit
    // `limit.toFixed(3)` in the violation formatter -- so the library crashed
    // with an internal TypeError on exactly the runs where the gate should
    // have produced a failure report.
    for (const bad of ['20', 'x', [20], true, {}]) {
        assert.throws(() => checkOps(r, { maxBytesPerOp: bad }), RangeError,
            'threshold ' + JSON.stringify(bad) + ' must be rejected');
    }
});

test('[axis B] Infinity threshold is rejected (an unbounded gate is not a gate)', () => {
    const r = measureOps(noop, { ops: 200, warmup: 20, stabilize: true });
    assert.throws(() => checkOps(r, { maxBytesPerOp: Infinity }), RangeError);
    assert.throws(() => checkOps(r, { maxBytesPerOp: -Infinity }), RangeError);
});

test('[axis B] valid thresholds still work in both directions', () => {
    const sink = [];
    const leaky = (i) => { sink.push(new Array(64).fill(i)); return i; };
    const clean = measureOps(noop, { ops: 400, warmup: 40, stabilize: true });
    const leak = measureOps(leaky, { ops: 400, warmup: 40, stabilize: true });
    const floor = Math.max(clean.bytesPerOp, 32);
    assert.equal(checkOps(clean, { maxBytesPerOp: 4 * floor }).verdict, 'pass');
    assert.equal(checkOps(leak, { maxBytesPerOp: 4 * floor }).verdict, 'fail');
    assert.equal(checkOps(leak, { maxBytesPerOp: 0 }).verdict, 'fail', 'zero is a legal threshold');
});

// =============================================================================
// AXIS C -- fail-closed metrics (a broken measurement must not gate green)
// =============================================================================

test('[axis C] NaN metric yields inconclusive, never pass', async () => {
    const r = await measureFrames(noop, { frames: 60, warmup: 10, scheduler: fastSched });
    // A mocked/non-monotonic performance.now drives metrics to NaN. Before,
    // `NaN > limit` was false so the gate reported a clean pass.
    const broken = { ...r, bytesPerFrame: NaN, droppedFrames: NaN };
    const rep = checkFrames(broken, { maxBytesPerFrame: 10 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checked.maxBytesPerFrame, false, 'must not claim it checked');
});

test('[axis C] Infinity metric yields inconclusive', async () => {
    const r = await measureFrames(noop, { frames: 60, warmup: 10, scheduler: fastSched });
    const rep = checkFrames({ ...r, bytesPerFrame: Infinity }, { maxBytesPerFrame: 10 });
    assert.equal(rep.verdict, 'inconclusive');
});

test('[axis C] NaN metric in the ops lane also yields inconclusive', () => {
    const r = measureOps(noop, { ops: 200, warmup: 20 });
    const rep = checkOps({ ...r, bytesPerOp: NaN }, { maxBytesPerOp: 10 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.ok, false);
});

test('[axis C] unmeasured metric (source=none) stays inconclusive', () => {
    const r = measureOps(noop, { ops: 200, source: 'none' });
    const rep = checkOps(r, { maxBytesPerOp: 20 });
    assert.equal(r.bytesPerOp, null);
    assert.equal(rep.verdict, 'inconclusive');
});

// =============================================================================
// AXIS D -- resource safety when the workload throws
// =============================================================================

test('[axis D] a throwing workload does not leak the profiler observer', () => {
    // Before: the measurement loop was not wrapped in try/finally, so an
    // aborted run never reached gc.stop() and left a live PerformanceObserver
    // registered for the life of the process. Growth was linear and measured
    // at ~6 KB per aborted run (1600 runs retained ~9.4 MB).
    const boom = () => { throw new Error('workload boom'); };
    const settle = () => { globalThis.gc(); globalThis.gc(); };

    settle();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 400; i++) {
        assert.throws(() => measureOps(boom, { ops: 10 }), /workload boom/);
    }
    settle();
    const retainedKb = (process.memoryUsage().heapUsed - before) / 1024;
    // The leak was ~2.4 MB at this count; anything in the low hundreds of KB
    // is ordinary churn. Generous bound -- this pins the ORDER, not the value.
    assert.ok(retainedKb < 800,
        '400 aborted runs must not retain megabytes; retained ' + retainedKb.toFixed(1) + ' KB');
});

test('[axis D] measurements stay accurate after many aborted runs', () => {
    const boom = () => { throw new Error('x'); };
    for (let i = 0; i < 200; i++) {
        try { measureOps(boom, { ops: 10 }); } catch { /* expected */ }
    }
    // Orphaned observers used to keep attributing GC events, inflating later
    // readings in the same process.
    const clean = measureOps(noop, { ops: 400, warmup: 40, stabilize: true });
    const sink = [];
    const leak = measureOps((i) => { sink.push(new Array(64).fill(i)); return i; },
        { ops: 400, warmup: 40, stabilize: true });
    const floor = Math.max(clean.bytesPerOp, 32);
    assert.ok(leak.bytesPerOp > 4 * floor,
        'leak detection must survive prior aborted runs (clean=' + clean.bytesPerOp
        + ', leak=' + leak.bytesPerOp + ')');
});

test('[axis D] async lanes also survive aborted runs', async () => {
    for (let i = 0; i < 40; i++) {
        await assert.rejects(
            () => measureFrames(() => { throw new Error('y'); },
                { frames: 20, warmup: 5, scheduler: fastSched }));
    }
    const r = await measureFrames(noop, { frames: 200, warmup: 40, scheduler: fastSched });
    assert.equal(r.bytesPerFrameStable, true);
    assert.ok(r.bytesPerFrame < 512, 'clean run after aborts must still read ~0; got ' + r.bytesPerFrame);
});

// =============================================================================
// AXIS E -- overlapping measurements are refused, not silently corrupted
// =============================================================================

test('[axis E] concurrent measurements are rejected', async () => {
    // Measured before the guard existed: a clean workload and a leaking one
    // run under Promise.all reported 2224 and 2332 B/frame -- the clean run
    // absorbed the leak and the two became indistinguishable. There is no
    // correct concurrent reading of a single shared heap, so overlap is an error.
    const first = measureFrames(noop, { frames: 120, warmup: 20, scheduler: fastSched });
    await assert.rejects(
        () => measureFrames(noop, { frames: 120, warmup: 20, scheduler: fastSched }),
        /already in flight/
    );
    await first;
});

test('[axis E] a nested measurement inside a running workload is rejected', () => {
    let n = 0;
    assert.throws(() => {
        measureOps(() => { if (++n === 10) measureOps(noop, { ops: 10 }); }, { ops: 100 });
    }, /already in flight/);
});

test('[axis E] the guard is released after a run throws (no wedging)', () => {
    // A guard that leaks its counter would wedge every later measurement in
    // the process -- turning a safety feature into a denial of service.
    assert.throws(() => measureOps(() => { throw new Error('boom'); }, { ops: 10 }), /boom/);
    const r = measureOps(noop, { ops: 100, warmup: 10 });
    assert.equal(r.ops, 100, 'measurement must work after an aborted run');
});

test('[axis E] the guard is released after a rejected async run', async () => {
    await assert.rejects(() => measureFrames(() => { throw new Error('boom'); },
        { frames: 20, warmup: 5, scheduler: fastSched }));
    const r = await measureFrames(noop, { frames: 40, warmup: 10, scheduler: fastSched });
    assert.equal(r.frames, 40);
});

test('[axis E] sequential measurements are unaffected', async () => {
    for (let i = 0; i < 3; i++) {
        const a = measureOps(noop, { ops: 100 });
        const b = await measureFrames(noop, { frames: 40, warmup: 10, scheduler: fastSched });
        const c = await measureOpsAsync(async (j) => j | 0, { ops: 50, warmup: 10 });
        assert.equal(a.ops, 100); assert.equal(b.frames, 40); assert.equal(c.ops, 50);
    }
});

// =============================================================================
// AXIS F -- option validation consistency
// =============================================================================

test('[axis F] capacity is validated identically across all three lanes', async () => {
    // Before, the same option had three behaviours: measureOps used
    // `capacity || 256` (0 and NaN silently became 256, 1.5 made a fractional
    // ring), the async lanes used `capacity | 0` (NaN and Infinity silently
    // became a capacity of ZERO), and -1 threw. Now all reject alike.
    for (const bad of [NaN, 0, -1, 1.5, Infinity, '256', null]) {
        assert.throws(() => measureOps(noop, { ops: 20, capacity: bad }), RangeError,
            'measureOps capacity=' + String(bad));
        await assert.rejects(
            () => measureFrames(noop, { frames: 20, capacity: bad, scheduler: fastSched }),
            RangeError, 'measureFrames capacity=' + String(bad));
        await assert.rejects(
            () => measureOpsAsync(async (i) => i, { ops: 20, capacity: bad }),
            RangeError, 'measureOpsAsync capacity=' + String(bad));
    }
});

test('[axis F] a valid capacity is still honoured', () => {
    const r = measureOps(noop, { ops: 50, capacity: 1 });
    assert.equal(r.ops, 50);
});

// =============================================================================
// AXIS G -- survival under extreme garbage pressure
// =============================================================================

test('[axis G] transient garbage storm does not register as retention', () => {
    // ~200 MB of churn through the steady window, none of it retained.
    // Stabilize's survivor semantics must report ~0, not the churn volume.
    const clean = measureOps(noop, { ops: 400, warmup: 40, stabilize: true });
    const storm = measureOps(() => {
        const a = new Array(2000);
        for (let k = 0; k < 2000; k++) a[k] = { v: k, s: 'pad' + k };
        return a.length;
    }, { ops: 400, warmup: 40, stabilize: true });
    const floor = Math.max(clean.bytesPerOp, 64);
    assert.ok(storm.bytesPerOp < 8 * floor,
        'transient churn must not read as retention; clean=' + clean.bytesPerOp
        + ' storm=' + storm.bytesPerOp);
});

test('[axis G] retained vs transient stays separable under storm conditions', () => {
    const storm = measureOps(() => {
        const a = new Array(500);
        for (let k = 0; k < 500; k++) a[k] = { v: k };
        return a.length;
    }, { ops: 300, warmup: 30, stabilize: true });
    const sink = [];
    const stormPlusLeak = measureOps((i) => {
        const a = new Array(500);
        for (let k = 0; k < 500; k++) a[k] = { v: k };
        sink.push(new Array(64).fill(i));           // the only retained part
        return a.length;
    }, { ops: 300, warmup: 30, stabilize: true });
    const floor = Math.max(storm.bytesPerOp, 32);
    assert.ok(stormPlusLeak.bytesPerOp > 4 * floor,
        'a real leak must remain visible through heavy transient noise; '
        + 'storm=' + storm.bytesPerOp + ' storm+leak=' + stormPlusLeak.bytesPerOp);
});

test('[axis G] a workload that forces its own GC does not corrupt the measurement', () => {
    let n = 0;
    const r = measureOps((i) => { if ((++n % 50) === 0) globalThis.gc(); return i | 0; },
        { ops: 400, warmup: 40, stabilize: true });
    assert.notEqual(r.bytesPerOp, null);
    assert.ok(Number.isFinite(r.bytesPerOp), 'must stay finite when the workload fights the profiler');
    assert.ok(r.bytesPerOp < 4096, 'self-GC must not inflate retention; got ' + r.bytesPerOp);
});

// =============================================================================
// AXIS H -- scheduler abuse (frames lane)
// =============================================================================

test('[axis H] a scheduler firing twice per tick does not double-advance', async () => {
    const r = await measureFrames(noop, {
        frames: 40, warmup: 10, scheduler: (cb) => { setTimeout(cb, 0); setTimeout(cb, 0); }
    });
    assert.equal(r.frames, 40, 'extra callbacks must not inflate the frame count');
});

test('[axis H] a synchronous scheduler completes without blowing the stack', async () => {
    const r = await measureFrames(noop, { frames: 60, warmup: 10, scheduler: (cb) => { cb(); } });
    assert.equal(r.frames, 60);
});

test('[axis H] a throwing scheduler rejects rather than hanging', async () => {
    await assert.rejects(
        () => measureFrames(noop, { frames: 40, warmup: 10, scheduler: () => { throw new Error('sched boom'); } }),
        /sched boom/
    );
});

test('[axis H] callbacks fired after the run completes are absorbed', async () => {
    let saved = null;
    const r = await measureFrames(noop, {
        frames: 40, warmup: 10, scheduler: (cb) => { saved = cb; setTimeout(cb, 0); }
    });
    assert.equal(r.frames, 40);
    for (let i = 0; i < 20; i++) saved();       // must not throw or corrupt
    assert.equal(r.frames, 40);
});

// =============================================================================
// AXIS I -- degenerate but legal inputs
// =============================================================================

test('[axis I] minimum viable runs produce finite, gateable results', async () => {
    const o = measureOps(noop, { ops: 1, stabilize: true });
    assert.ok(Number.isFinite(o.bytesPerOp), 'ops=1 bytesPerOp must be finite');
    const f = await measureFrames(noop, { frames: 1, scheduler: fastSched });
    assert.equal(f.frames, 1);
    assert.ok(Number.isFinite(f.frameTimes.p50));
});

test('[axis I] warmup larger than the steady window is handled', async () => {
    const r = await measureFrames(noop, { frames: 10, warmup: 100, scheduler: fastSched });
    assert.equal(r.frames, 10);
    assert.equal(r.warmupFrames, 100);
    assert.ok(Number.isFinite(r.bytesPerFrame));
});

test('[axis I] a mutated result object is rejected by the gate', () => {
    const r = measureOps(noop, { ops: 100 });
    const forged = { ...r, schema: 'not-a-real-schema' };
    assert.throws(() => checkOps(forged, { maxBytesPerOp: 20 }), TypeError);
});

test('[axis I] a very large op count stays numerically sane', () => {
    const r = measureOps(noop, { ops: 2000000 });
    assert.ok(Number.isFinite(r.opsPerSec) && r.opsPerSec > 0);
    assert.ok(r.bytesPerOp === null || Number.isFinite(r.bytesPerOp));
});
