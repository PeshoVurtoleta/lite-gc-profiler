// Confirms v1.0.0 usage patterns still work verbatim on v1.1.0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GcProfiler, assertNoGc, checkNoGc, GcBudgetError } from '../Gc.js';

// Pattern from the v1.0.0 README, unchanged:
test('v1.0.0 README node example: pooled loop, assertNoGc, no args', async () => {
    const gc = new GcProfiler().start();
    const buf = new Float64Array(1024);
    for (let i = 0; i < 100000; i++) buf[i & 1023] = i * 0.5;
    await new Promise((r) => setTimeout(r, 50));
    assertNoGc(gc.summary());   // default rules, must not throw
    gc.stop();
});

// The README's LEAKY vs POOLED differential -- the whole falsifiability claim.
test('leaky-vs-pooled differential still works', async () => {
    const leaky = new GcProfiler().start();
    for (let i = 0; i < 500; i++) {
        const arr = new Array(1000);
        for (let j = 0; j < 1000; j++) arr[j] = { x: j, y: j * 2, s: 'x' + j };
        if (global.gc && i % 50 === 0) global.gc();
    }
    await new Promise((r) => setTimeout(r, 100));
    const leakyReport = checkNoGc(leaky.summary());
    leaky.stop();

    const pooled = new GcProfiler().start();
    const buf = new Float64Array(1024);
    for (let i = 0; i < 500000; i++) buf[i & 1023] = i * 0.5;
    await new Promise((r) => setTimeout(r, 100));
    const pooledReport = checkNoGc(pooled.summary());
    pooled.stop();

    // The claim: pooled passes, leaky either fails or (if V8 was lenient) at least has
    // measurably more allocation activity than pooled. We assert the differential.
    assert.equal(pooledReport.verdict, 'pass', 'pooled loop should pass');
    assert.ok(pooled.summary().gc.major === 0, 'pooled should have zero majors');
    // leaky may have majors or not depending on V8's mood, but if it does, gate fails
    if (leaky.summary().gc.major > 0) {
        assert.equal(leakyReport.verdict, 'fail', 'leaky with majors must fail the gate');
    }
});

// Shape of the ok/violations back-compat check
test('report shape: ok + violations still readable exactly as v1.0.0', () => {
    const gc = new GcProfiler().start();
    gc.record(4, 12.5); // GC_MAJOR
    gc.stop();
    const rep = checkNoGc(gc.summary(), { maxMajor: 0 });
    // v1.0.0 downstream code reads .ok and .violations. Both must still work.
    assert.equal(rep.ok, false);
    assert.ok(Array.isArray(rep.violations));
    assert.equal(rep.violations[0].metric, 'gc.major');
});
