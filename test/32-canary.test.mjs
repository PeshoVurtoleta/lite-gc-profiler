// watchPool -- the pool-escape canary (v1.14.0). A DETECTOR, not a gate:
// escapes are asserted, absence is advisory. Every test runs under
// `node --expose-gc` (the canary needs a forceable gc to drive its settle
// loop). Adversarial timing/honesty cases live in
// test/torture/g29-6-canary.test.mjs.
//
// These are async: finalizer callbacks fire only after a collection AND a
// macrotask, so every escape assertion awaits settle().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchPool, assertNoEscapes, GcPoolEscapeError } from '../Gc.js';

// Build N pooled objects, register each, return the array. Kept deliberately
// simple: a plain object with a buffer so the collector has something to free.
function makePool(watch, n) {
    const pool = [];
    for (let i = 0; i < n; i++) {
        const o = { i, buf: new Array(40).fill(0) };
        watch.register(o, i);
        pool.push(o);
    }
    return pool;
}

// ---------------------------------------------------------------------------
// availability
// ---------------------------------------------------------------------------

test('watchPool is available under --expose-gc with FinalizationRegistry', () => {
    const w = watchPool({ label: 'avail' });
    assert.equal(w.available, true);
    w.dispose();
});

// ---------------------------------------------------------------------------
// the clean case: no escapes
// ---------------------------------------------------------------------------

test('a pool with every slot released reports zero escapes', async () => {
    const w = watchPool({ label: 'clean' });
    let pool = makePool(w, 40);
    for (let i = 0; i < 40; i++) w.release(pool[i], i);
    pool = null;
    const r = await w.settle({ cycles: 6, gap: 2 });
    assert.equal(r.escapeCount, 0);
    assert.equal(r.watched, 40);
    assert.equal(r.released, 40);
    w.dispose();
});

test('assertNoEscapes does not throw on a clean report', async () => {
    const w = watchPool();
    let pool = makePool(w, 20);
    for (let i = 0; i < 20; i++) w.release(pool[i], i);
    pool = null;
    const r = await w.settle({ cycles: 6, gap: 2 });
    assert.doesNotThrow(() => assertNoEscapes(r));
    w.dispose();
});

test('a slot released and THEN collected is not an escape', async () => {
    // The pool checked it back in, then discarded it -- legitimate. Release
    // removes it from the checked-out set, so its later collection is silent.
    const w = watchPool({ label: 'release-then-drop' });
    let pool = makePool(w, 20);
    for (let i = 0; i < 20; i++) w.release(pool[i], i);
    pool = null;   // now collectable, but all were released first
    const r = await w.settle({ cycles: 8, gap: 3 });
    assert.equal(r.escapeCount, 0, 'release means not checked out; collection is fine');
    w.dispose();
});

// ---------------------------------------------------------------------------
// the escape case: a checked-out slot is collected
// ---------------------------------------------------------------------------

test('a checked-out slot that is dropped is reported as an escape', async () => {
    const w = watchPool({ label: 'leak' });
    let pool = makePool(w, 30);
    // Drop three WITHOUT releasing -- they escaped the pool's bookkeeping.
    pool[5] = pool[15] = pool[25] = null;
    const r = await w.settle({ cycles: 10, gap: 3 });
    const slots = r.escapes.map((e) => e.slot).sort((a, b) => a - b);
    assert.deepEqual(slots, [5, 15, 25]);
    assert.equal(r.escapeCount, 3);
    w.dispose();
});

test('assertNoEscapes throws GcPoolEscapeError on a report with escapes', async () => {
    const w = watchPool({ label: 'leak2' });
    let pool = makePool(w, 20);
    pool[7] = null;
    const r = await w.settle({ cycles: 10, gap: 3 });
    assert.throws(() => assertNoEscapes(r), (e) => e instanceof GcPoolEscapeError);
    w.dispose();
});

test('the escape error names the slots and the pool label', async () => {
    const w = watchPool({ label: 'named-pool' });
    let pool = makePool(w, 12);
    pool[3] = null;
    const r = await w.settle({ cycles: 10, gap: 3 });
    try {
        assertNoEscapes(r);
        assert.fail('should have thrown');
    } catch (e) {
        assert.match(e.message, /pool escape detected/);
        assert.match(e.message, /named-pool/);
        assert.equal(e.report.escapeCount, 1);
    }
    w.dispose();
});

// ---------------------------------------------------------------------------
// the no-pin invariant: watching must not keep slots alive
// ---------------------------------------------------------------------------

test('watching does not pin a slot -- a dropped checked-out slot IS collectable', async () => {
    // If the registry held a strong reference, the dropped slot could never be
    // collected and would never fire. That it fires proves no pin.
    const w = watchPool();
    let pool = makePool(w, 15);
    pool[0] = null;
    const r = await w.settle({ cycles: 10, gap: 3 });
    assert.ok(r.escapeCount >= 1, 'the watched-then-dropped slot was collectable and fired');
    w.dispose();
});

// ---------------------------------------------------------------------------
// the report shape / advisory note
// ---------------------------------------------------------------------------

test('every report carries the advisory note', async () => {
    const w = watchPool();
    const r = await w.settle({ cycles: 2, gap: 1 });
    assert.equal(typeof r.note, 'string');
    assert.match(r.note, /not proof/);
    w.dispose();
});

test('a report round-trips through JSON', async () => {
    const w = watchPool({ label: 'json' });
    let pool = makePool(w, 10);
    pool[1] = null;
    const r = await w.settle({ cycles: 8, gap: 3 });
    const wire = JSON.parse(JSON.stringify(r));
    assert.equal(wire.escapeCount, r.escapeCount);
    assert.equal(wire.available, true);
    assert.equal(wire.label, 'json');
    w.dispose();
});

// ---------------------------------------------------------------------------
// input validation
// ---------------------------------------------------------------------------

test('register and release reject a non-object slot', () => {
    const w = watchPool();
    assert.throws(() => w.register(42, 0), TypeError);
    assert.throws(() => w.register(null, 0), TypeError);
    assert.throws(() => w.release('x', 0), TypeError);
    w.dispose();
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

test('dispose is idempotent', () => {
    const w = watchPool();
    w.dispose();
    assert.doesNotThrow(() => w.dispose());
});

test('after dispose, register and settle are inert', async () => {
    const w = watchPool();
    w.dispose();
    assert.doesNotThrow(() => w.register({ a: 1 }, 0));
    const r = await w.settle();
    assert.equal(r.escapeCount, 0);
});

// ---------------------------------------------------------------------------
// degrade: no forceable gc  (stub globalThis.gc away, restore after)
// ---------------------------------------------------------------------------

test('without a forceable gc, watchPool is unavailable and never throws', async () => {
    const savedGc = globalThis.gc;
    globalThis.gc = undefined;
    try {
        const w = watchPool({ label: 'no-gc' });
        assert.equal(w.available, false);
        // register/release are inert no-ops, not throws.
        assert.doesNotThrow(() => w.register({ a: 1 }, 0));
        assert.doesNotThrow(() => w.release({ a: 1 }, 0));
        const r = await w.settle();
        assert.equal(r.available, false);
        assert.equal(r.reason, 'no_gc');
        assert.equal(r.settled, false);
        assert.equal(r.escapeCount, 0);
        // assertNoEscapes is a no-op on an unavailable report.
        assert.doesNotThrow(() => assertNoEscapes(r));
        w.dispose();
    } finally {
        if (savedGc) globalThis.gc = savedGc;
    }
});

test('an unavailable report still carries the advisory note and empty escapes', async () => {
    const savedGc = globalThis.gc;
    globalThis.gc = undefined;
    try {
        const w = watchPool();
        const r = await w.settle({ cycles: 4, gap: 1 });
        assert.equal(r.escapeCount, 0);
        assert.deepEqual(r.escapes, []);
        assert.equal(typeof r.note, 'string');
        w.dispose();
    } finally {
        if (savedGc) globalThis.gc = savedGc;
    }
});
