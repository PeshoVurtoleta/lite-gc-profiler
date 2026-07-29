// G29.6 -- Torture for the pool-escape canary (v1.14.0). This is the one lane
// whose signal is NON-DETERMINISTIC by nature: finalizer timing is up to V8, so
// the torture asserts INVARIANTS and STATISTICAL properties across repeated
// runs, not single deterministic outcomes. The danger is symmetric with any
// detector: a false escape (reporting a slot that did not escape) is a lie, and
// a missed escape hides the bug -- but the deeper danger unique to this lane is
// treating ABSENCE as proof. Axes:
//
//   A -- absence is advisory: an empty escapes list never throws, never claims
//        proof, across many settle budgets.
//   B -- a real escape is caught within a generous budget across repeated runs.
//   C -- the no-pin invariant under load: only truly-dropped slots ever fire.
//   D -- lifecycle and degrade: dispose, availability, honest settled:false.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchPool, assertNoEscapes } from '../../Gc.js';

function makePool(watch, n) {
    const pool = [];
    for (let i = 0; i < n; i++) {
        const o = { i, buf: new Array(40).fill(0) };
        watch.register(o, i);
        pool.push(o);
    }
    return pool;
}

// =============================================================================
// AXIS A -- absence is advisory, never proof
// =============================================================================

test('[A] a clean pool never throws, across many settle budgets', async () => {
    for (const cycles of [1, 2, 4, 8]) {
        const w = watchPool();
        let pool = makePool(w, 20);
        for (let i = 0; i < 20; i++) w.release(pool[i], i);
        pool = null;
        const r = await w.settle({ cycles, gap: 2 });
        assert.equal(r.escapeCount, 0);
        assert.doesNotThrow(() => assertNoEscapes(r), 'budget ' + cycles + ' must not throw');
        w.dispose();
    }
});

test('[A] an empty escapes list always carries the not-proof note', async () => {
    const w = watchPool();
    const r = await w.settle({ cycles: 2, gap: 1 });
    assert.equal(r.escapeCount, 0);
    assert.match(r.note, /not proof/, 'absence must be labelled advisory, always');
    w.dispose();
});

test('[A] a tiny budget on a clean pool reports settled honestly', async () => {
    // With no pending finalizers, even cycles:1 quiesces (nothing changes), so
    // settled can be true -- but it must never be a false escape.
    const w = watchPool();
    const r = await w.settle({ cycles: 1, gap: 0 });
    assert.equal(r.escapeCount, 0);
    w.dispose();
});

// =============================================================================
// AXIS B -- a real escape is caught (statistical, not single-shot)
// =============================================================================

test('[B] a dropped checked-out slot is caught within a generous budget', async () => {
    // Finalization timing varies; a generous budget makes catching reliable.
    const w = watchPool({ label: 'catch' });
    let pool = makePool(w, 25);
    pool[10] = null;
    const r = await w.settle({ cycles: 20, gap: 4 });
    assert.ok(r.escapeCount >= 1, 'the escape must be caught with a generous budget');
    assert.ok(r.escapes.some((e) => e.slot === 10), 'and it is the slot we dropped');
    w.dispose();
});

test('[B] many escapes are all eventually caught', async () => {
    const w = watchPool({ label: 'many' });
    let pool = makePool(w, 40);
    const dropped = [3, 8, 16, 24, 33];
    for (const d of dropped) pool[d] = null;
    const r = await w.settle({ cycles: 25, gap: 4 });
    const caught = r.escapes.map((e) => e.slot).sort((a, b) => a - b);
    assert.deepEqual(caught, dropped, 'every dropped slot is reported, none extra');
    w.dispose();
});

test('[B] repeated runs each catch their own escape independently', async () => {
    for (let run = 0; run < 3; run++) {
        const w = watchPool({ label: 'run' + run });
        let pool = makePool(w, 15);
        pool[run * 3] = null;
        const r = await w.settle({ cycles: 20, gap: 4 });
        assert.ok(r.escapes.some((e) => e.slot === run * 3),
            'run ' + run + ' caught its escape');
        w.dispose();
    }
});

// =============================================================================
// AXIS C -- the no-pin invariant under load
// =============================================================================

test('[C] only truly-dropped slots fire, not released ones, under churn', async () => {
    const w = watchPool({ label: 'churn' });
    let pool = makePool(w, 60);
    // Release EVERY slot except the three we deliberately drop while checked out.
    const dropped = new Set([11, 27, 41]);
    for (let i = 0; i < 60; i++) {
        if (!dropped.has(i)) w.release(pool[i], i);
    }
    // Now drop everything: the released slots must stay silent, the three
    // still-checked-out ones must escape.
    pool = null;
    const r = await w.settle({ cycles: 25, gap: 4 });
    const caught = r.escapes.map((e) => e.slot).sort((a, b) => a - b);
    assert.deepEqual(caught, [11, 27, 41],
        'only the checked-out drops escape; released-then-collected are silent');
    w.dispose();
});

test('[C] the watch does not pin -- a large watched set is fully collectable', async () => {
    // If watching pinned, none of these could be collected and none would fire.
    const w = watchPool();
    let pool = makePool(w, 100);
    pool = null;   // drop ALL while checked out -> all are escapes
    const r = await w.settle({ cycles: 30, gap: 4 });
    // We do not assert exactly 100 (finalization may lag), but a pin would give
    // exactly 0. A healthy count proves no pin.
    assert.ok(r.escapeCount > 0, 'a pinning bug would report zero; we report escapes');
    w.dispose();
});

test('[C] a slot escapes at most once even under repeated settle', async () => {
    const w = watchPool({ label: 'once' });
    let pool = makePool(w, 10);
    pool[2] = null;
    const r1 = await w.settle({ cycles: 15, gap: 4 });
    const first = r1.escapeCount;
    // Settle again -- the already-fired slot must not re-count.
    const r2 = await w.settle({ cycles: 6, gap: 3 });
    assert.equal(r2.escapeCount, first, 'a fired escape is not double-counted on a second settle');
    w.dispose();
});

// =============================================================================
// AXIS D -- lifecycle and degrade
// =============================================================================

test('[D] dispose stops further escape recording', async () => {
    const w = watchPool();
    let pool = makePool(w, 10);
    w.dispose();
    pool[0] = null;   // dropped after dispose
    pool = null;
    const r = await w.settle({ cycles: 8, gap: 3 });
    assert.equal(r.escapeCount, 0, 'a disposed watch records nothing');
});

test('[D] settle on a disposed watch resolves, not hangs', async () => {
    const w = watchPool();
    w.dispose();
    const r = await w.settle({ cycles: 8, gap: 3 });
    assert.equal(r.settled, false, 'a disposed watch cannot run the loop');
    assert.equal(r.escapeCount, 0);
});

test('[D] released count tracks clean check-ins', async () => {
    const w = watchPool();
    let pool = makePool(w, 12);
    for (let i = 0; i < 5; i++) w.release(pool[i], i);
    const r = await w.settle({ cycles: 2, gap: 1 });
    assert.equal(r.watched, 12);
    assert.equal(r.released, 5);
    w.dispose();
    pool = null;
});

test('[D] releasing an unknown slot is a no-op, not a crash', () => {
    const w = watchPool();
    const o = { a: 1 };
    // Never registered -- release must not throw or corrupt counts.
    assert.doesNotThrow(() => w.release(o, 999));
    w.dispose();
});
