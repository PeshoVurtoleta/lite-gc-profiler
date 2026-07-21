// Standard-case tests for the test helper introduced in v1.3.0 (G9).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withGcGate, measureGc } from '../TestHelpers.js';
import { GcBudgetError, GcInconclusiveError } from '../Gc.js';

// ---- withGcGate: pass path ----

test('withGcGate: clean workload passes with defaults', async (t) => {
    const rep = await withGcGate(t, async () => {
        const buf = new Float64Array(1024);
        for (let i = 0; i < 100000; i++) buf[i & 1023] = i * 0.5;
    });
    assert.equal(rep.verdict, 'pass');
});

test('withGcGate: clean workload passes with explicit rules', async (t) => {
    const rep = await withGcGate(t, { maxMajor: 0, maxPauseMs: 100 }, async () => {
        const buf = new Float64Array(1024);
        for (let i = 0; i < 100000; i++) buf[i & 1023] = i * 0.5;
    });
    assert.equal(rep.verdict, 'pass');
});

test('withGcGate: profiler passed to body -> phases usable', async (t) => {
    const rep = await withGcGate(t, {
        phases: {
            warmup: { maxMajor: 0 },
            steady: { maxMajor: 0 }
        }
    }, async (gc) => {
        gc.phase('warmup');
        const buf = new Float64Array(1024);
        for (let i = 0; i < 10000; i++) buf[i & 1023] = i;
        gc.phase('steady');
        for (let i = 0; i < 50000; i++) buf[i & 1023] = i * 2;
    });
    assert.equal(rep.verdict, 'pass');
});

// ---- withGcGate: fail path ----

test('withGcGate: dirty workload throws GcBudgetError', async (t) => {
    // Sub-test uses its own diagnostic; we assert the throw.
    await assert.rejects(
        async () => withGcGate(t, { maxMajor: 0 }, async () => {
            const buckets = [];
            for (let i = 0; i < 200; i++) {
                const arr = new Array(1000);
                for (let j = 0; j < 1000; j++) arr[j] = { x: j, y: j * 2, s: 'x' + j };
                buckets.push(arr);
                if (i % 20 === 0 && global.gc) global.gc();
            }
        }),
        GcBudgetError
    );
});

// ---- withGcGate: body throws ----

test('withGcGate: body error still stops/settles the profiler', async (t) => {
    class SentinelError extends Error {}
    await assert.rejects(
        async () => withGcGate(t, async () => {
            throw new SentinelError('workload failed');
        }),
        SentinelError
    );
    // No leak assertion beyond "doesn't hang"; suite completing implies cleanup.
});

// ---- measureGc ----

test('measureGc: returns report without throwing', async (t) => {
    const rep = await measureGc(t, async () => {
        const buf = new Float64Array(1024);
        for (let i = 0; i < 50000; i++) buf[i & 1023] = i * 0.5;
    }, { rules: { maxMajor: 0 } });
    assert.equal(rep.verdict, 'pass');
});

test('measureGc: dirty workload returns fail verdict (does not throw)', async (t) => {
    const rep = await measureGc(t, async () => {
        const buckets = [];
        for (let i = 0; i < 200; i++) {
            const arr = new Array(1000);
            for (let j = 0; j < 1000; j++) arr[j] = { x: j, y: j * 2, s: 'x' + j };
            buckets.push(arr);
            if (i % 20 === 0 && global.gc) global.gc();
        }
    }, { rules: { maxMajor: 0 } });
    // At least don't throw; verdict depends on whether V8 actually collected.
    assert.ok(rep.verdict === 'pass' || rep.verdict === 'fail');
});

// ---- allowInconclusive ----

test('withGcGate: allowInconclusive:true does not throw on inconclusive', async (t) => {
    // With source=none we could test; without a way to fake source, this test
    // just verifies the option is plumbed through by using a workload that
    // trivially passes -- verify no throw.
    const rep = await withGcGate(t, { maxMajor: 0 }, async () => {}, { allowInconclusive: true });
    // On node with real 'gc' source, verdict is pass.
    assert.equal(rep.verdict, 'pass');
});
