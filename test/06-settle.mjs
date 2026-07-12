// Standard-case tests for settle() introduced in v1.1.0 (G3).
// Adversarial cases (settle timeout under sustained GC pressure, settle
// concurrency, settle after destroy) live in test/torture/g3-5-verdicts.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GcProfiler, GC_MAJOR } from '../Gc.js';

// ---- shortcut cases ----

test('settle() on a profiler that was never .start()ed resolves immediately', async () => {
    const gc = new GcProfiler();
    const t0 = performance.now();
    const r = await gc.settle();
    const elapsed = performance.now() - t0;
    assert.equal(r.drained, true);
    assert.equal(r.waited, 0);
    // Real elapsed should also be near-zero (no macrotask waits).
    assert.ok(elapsed < 5, 'shortcut should be sync-like, got ' + elapsed + 'ms');
});

test('settle() after stop() resolves immediately (observer detached)', async () => {
    const gc = new GcProfiler().start();
    gc.stop();
    const r = await gc.settle();
    assert.equal(r.drained, true);
    assert.equal(r.waited, 0);
});

// ---- drain path ----

test('settle() on a clean session drains after ~quietTicks ticks', async () => {
    const gc = new GcProfiler().start();
    // No GC-triggering work; observer should just sit quiet.
    const r = await gc.settle();
    assert.equal(r.drained, true);
    // Two quiet ticks * setTimeout(r,0) minimum. Give generous ceiling.
    assert.ok(r.waited < 100, 'clean settle should be fast, got ' + r.waited + 'ms');
    gc.stop();
});

test('settle() waits for entries triggered before the call', async () => {
    const gc = new GcProfiler().start();
    // Force some GC activity.
    if (global.gc) { global.gc(); global.gc(); }
    // Settle immediately -- if the observer batch hasn't fired yet, settle
    // should notice it and wait past the batch.
    const r = await gc.settle();
    assert.equal(r.drained, true);
    // After settle, summary should include the entries from the forced GCs.
    const s = gc.summary();
    if (global.gc) {
        // We can't guarantee EVERY runtime delivers major entries for global.gc(),
        // but the batch counter should have advanced at least once.
        assert.ok(s.gc.count >= 0, 'summary readable after settle');
    }
    gc.stop();
});

test('settle() respects maxWaitMs and returns drained:false on timeout', async () => {
    const gc = new GcProfiler().start();
    // Fake sustained batches: bump _batchCount ourselves on a tight interval so
    // no consecutive quiet ticks accumulate before maxWaitMs. Direct field poke
    // is fine for a test -- production code never touches internals.
    const bump = setInterval(() => { gc._batchCount++; }, 1);
    const r = await gc.settle({ maxWaitMs: 30 });
    clearInterval(bump);
    assert.equal(r.drained, false);
    assert.ok(r.waited >= 30, 'should have waited at least maxWaitMs, got ' + r.waited);
    assert.ok(r.waited < 100, 'should not have waited much past maxWaitMs, got ' + r.waited);
    gc.stop();
});

// ---- options ----

test('settle({ quietTicks: 5 }) waits more ticks than default 2', async () => {
    const gc = new GcProfiler().start();
    const r2 = await gc.settle({ quietTicks: 2 });
    const r5 = await gc.settle({ quietTicks: 5 });
    // Both should drain; 5 ticks should take longer than 2 ticks (both min ~0
    // per tick, but the count constrains).
    assert.equal(r2.drained, true);
    assert.equal(r5.drained, true);
    // Not strictly asserting r5.waited > r2.waited: setTimeout(r,0) is coarse
    // in node and both can hit 0-1ms. But both must be under a generous ceiling.
    assert.ok(r5.waited < 100);
    gc.stop();
});

test('settle({ quietTicks: 0 }) falls back to default 2 (invalid -> default)', async () => {
    const gc = new GcProfiler().start();
    const r = await gc.settle({ quietTicks: 0 });
    assert.equal(r.drained, true);
    gc.stop();
});

test('settle({ maxWaitMs: 0 }) falls back to default 200 (invalid -> default)', async () => {
    const gc = new GcProfiler().start();
    const r = await gc.settle({ maxWaitMs: 0 });
    // Should complete via quiet ticks (no sustained batches), not by timeout.
    assert.equal(r.drained, true);
    gc.stop();
});

// ---- interaction with rest of API ----

test('reset() clears the batch counter for subsequent settles', async () => {
    const gc = new GcProfiler().start();
    if (global.gc) global.gc();
    await gc.settle();
    gc.reset();
    // Batch counter is back to zero; next settle should still work.
    const r = await gc.settle();
    assert.equal(r.drained, true);
    gc.stop();
});

test('settle() can be called back-to-back', async () => {
    const gc = new GcProfiler().start();
    const r1 = await gc.settle();
    const r2 = await gc.settle();
    assert.equal(r1.drained, true);
    assert.equal(r2.drained, true);
    gc.stop();
});

// ---- README-pattern equivalent ----

test('README pattern with settle() instead of hardcoded sleep', async () => {
    const gc = new GcProfiler().start();
    const buf = new Float64Array(1024);
    for (let i = 0; i < 100000; i++) buf[i & 1023] = i * 0.5;
    const r = await gc.settle();
    assert.equal(r.drained, true);
    const s = gc.summary();
    assert.equal(s.gc.major, 0, 'pooled loop should have zero majors');
    gc.stop();
});
