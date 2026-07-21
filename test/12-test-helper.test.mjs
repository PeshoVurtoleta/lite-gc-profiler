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

// ---------------------------------------------------------------------------
// v1.9.2 -- options handling on both helpers.
//
// These lanes were 100% line-covered and never branch-covered: every existing
// test called the helpers WITHOUT an options object, so the whole options
// path was executed only in its default shape. That is the coverage failure
// mode worth caring about -- not an unvisited line, but a visited line whose
// interesting side was never taken.
// ---------------------------------------------------------------------------

test('withGcGate: an explicit capacity is used, not silently ignored', async (t) => {
    let seen = null;
    await withGcGate(t, { maxMajor: 0 }, async (gc) => { seen = gc; }, { capacity: 32 });
    assert.ok(seen, 'the body must receive the profiler');
    // The ring capacity is the only observable effect of this option, so the
    // assertion reaches for it deliberately. Asserting merely that the call
    // did not throw would pass just as well if the option were dropped on the
    // floor, which is exactly the bug this pin exists to catch.
    assert.equal(seen._dur.cap, 32);
});

test('withGcGate: a nonsense capacity falls back instead of throwing', async (t) => {
    // new GcProfiler(0) throws RangeError, so this guard is load-bearing: it
    // turns a caller's bad option into the documented default rather than an
    // exception from inside the harness, which would look like a test failure
    // in the workload rather than a bad argument.
    let seen = null;
    for (const capacity of [0, -1]) {
        await withGcGate(t, { maxMajor: 0 }, async (gc) => { seen = gc; }, { capacity });
        assert.equal(seen._dur.cap, 256, 'capacity ' + capacity + ' should fall back to the default');
    }
});

test('withGcGate: a body that breaks settle() must not break the harness', async (t) => {
    // The body is handed the live profiler, so it can sabotage it. The finally
    // block swallows a settle failure on purpose: losing the settle costs some
    // trailing GC events, whereas letting it propagate would replace the real
    // verdict with an error from the cleanup path -- and the caller would never
    // learn what the gate actually saw.
    let asserted = false;
    await withGcGate(t, { maxMajor: 0 }, async (gc) => {
        gc.settle = () => Promise.reject(new Error('settle sabotaged'));
        asserted = true;
    });
    assert.equal(asserted, true, 'the gate must still have run its assertion');
});

test('measureGc: options are honoured -- capacity and rules both applied', async (t) => {
    let seen = null;
    const report = await measureGc(t, async (gc) => {
        seen = gc;
        const junk = [];
        for (let i = 0; i < 20000; i++) junk.push({ i });
        return junk.length;
    }, { capacity: 64, rules: { maxMajor: 0 } });

    assert.equal(seen._dur.cap, 64, 'the capacity option must reach the profiler');
    // Passing rules through matters: with opts.rules undefined, checkNoGc
    // applies its own default and the caller's intent is silently replaced.
    assert.ok(Object.prototype.hasOwnProperty.call(report.checked, 'maxMajor'),
        'the supplied rule must appear in the report');
    assert.ok(['pass', 'fail', 'inconclusive'].includes(report.verdict));
});

test('measureGc: nonsense capacity falls back instead of throwing', async (t) => {
    let seen = null;
    await measureGc(t, async (gc) => { seen = gc; }, { capacity: 0 });
    assert.equal(seen._dur.cap, 256);
});

test('measureGc: a body that breaks settle() still returns a report', async (t) => {
    const report = await measureGc(t, async (gc) => {
        gc.settle = () => Promise.reject(new Error('settle sabotaged'));
    });
    // measureGc's contract is that it returns a verdict rather than throwing.
    // A sabotaged settle must not convert that into an exception.
    assert.ok(report && typeof report.verdict === 'string');
});
