import test from 'node:test';
import assert from 'node:assert/strict';
import { GcProfiler, checkNoGc } from '../index.js';

// The heap path is driven by explicit usedBytes samples so it is deterministic in
// node (where performance.memory is absent). Chrome feeds it automatically.

test('explicit heap samples accrue allocation and detect drops (collections)', () => {
    const p = new GcProfiler(64);
    let t = 0;
    p.sampleHeap(t, 1_000_000);          // first sample: baseline only
    p.sampleHeap(t += 100, 1_400_000);   // +400k alloc
    p.sampleHeap(t += 100, 1_900_000);   // +500k alloc
    p.sampleHeap(t += 100, 300_000);     // drop of 1.6M -> a collection
    p.sampleHeap(t += 100, 700_000);     // +400k alloc
    const h = p.summary().heap;
    assert.equal(h.supported, true);
    assert.equal(h.samples, 5);
    assert.equal(h.allocBytes, 400_000 + 500_000 + 400_000);   // 1.3M cumulative
    assert.equal(h.gcDrops, 1);
    assert.equal(h.freedBytes, 1_600_000);
    assert.equal(h.peak, 1_900_000);
    p.destroy();
});

test('allocation rate is bytes-per-second over sampled elapsed time', () => {
    const p = new GcProfiler(64);
    p.sampleHeap(0, 0);
    p.sampleHeap(1000, 2_000_000);        // +2MB over 1s -> 2MB/s
    const h = p.summary().heap;
    assert.equal(h.allocRateBytesPerSec, 2_000_000);
    // and it feeds the alloc-rate gate
    assert.equal(checkNoGc(p.summary(), { maxAllocRate: 1_000_000 }).ok, false);
    assert.equal(checkNoGc(p.summary(), { maxAllocRate: 3_000_000 }).ok, true);
    p.destroy();
});

test('markFrame flags frames well above the smoothed baseline', () => {
    const p = new GcProfiler(64);
    for (let i = 0; i < 200; i++) p.markFrame(16);   // steady baseline
    p.markFrame(60);                                  // a hitch
    p.markFrame(64);                                  // another
    const f = p.summary().frames;
    assert.equal(f.count, 202);
    assert.ok(f.long >= 2, 'the two hitches were flagged (long=' + f.long + ')');
    p.destroy();
});

test('short frames near the baseline are not flagged as long', () => {
    const p = new GcProfiler(64);
    for (let i = 0; i < 100; i++) p.markFrame(16 + (i % 3));   // 16..18, jittery but not long
    assert.equal(p.summary().frames.long, 0);
    p.destroy();
});

test('heap block reports unsupported until a sample is fed (in node)', () => {
    const p = new GcProfiler(16);
    // node has no performance.memory; with no explicit sample, heap stays inert
    const before = p.summary().heap;
    assert.equal(before.samples, 0);
    p.sampleHeap(0, 500_000);
    assert.equal(p.summary().heap.supported, true);
    p.destroy();
});
