// Allocation audit for G2 hot paths.
// The claim: after the phase intern table has settled (all names seen once),
// phase() and record() do not allocate. We measure via process.memoryUsage()
// deltas under --expose-gc with forced collections between windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GcProfiler, GC_MAJOR } from '../Gc.js';

function heap() {
    if (global.gc) global.gc(); global.gc && global.gc();
    return process.memoryUsage().heapUsed;
}

test('alloc audit: repeated idempotent phase() calls do not allocate', () => {
    const gc = new GcProfiler();
    gc.phase('steady');                             // warm intern
    const before = heap();
    for (let i = 0; i < 100000; i++) gc.phase('steady');
    const after = heap();
    const delta = after - before;
    // 100k calls * 8 bytes/call worst-case tolerance = 800KB. Real should be 0.
    assert.ok(delta < 200 * 1024, 'idempotent phase() must not allocate; delta=' + delta);
});

test('alloc audit: _record() with active phase does not allocate', () => {
    const gc = new GcProfiler();
    gc.phase('steady');
    const t0 = performance.now();
    // Prime: run once to warm all code paths.
    for (let i = 0; i < 100; i++) gc.record(GC_MAJOR, 5, t0 + i * 0.01);
    const before = heap();
    for (let i = 0; i < 100000; i++) gc.record(GC_MAJOR, 5, t0 + i * 0.01);
    const after = heap();
    const delta = after - before;
    assert.ok(delta < 200 * 1024, 'record() into a phase must not allocate; delta=' + delta);
});

test('alloc audit: alternating between two known phases (under boundary cap)', () => {
    const gc = new GcProfiler();
    gc.phase('a'); gc.phase('b'); gc.phase('a');    // prime both intern entries + 3 boundaries
    const before = heap();
    // Cap is 1024 boundaries; we've used 3. Room for ~500 more toggle pairs.
    for (let i = 0; i < 500; i++) {
        gc.phase('a');
        gc.phase('b');
    }
    const after = heap();
    const delta = after - before;
    assert.ok(delta < 100 * 1024, 'phase toggling must not allocate; delta=' + delta);
});
