import test from 'node:test';
import assert from 'node:assert/strict';
import {
    GcProfiler, checkNoGc, assertNoGc, GcBudgetError,
    GC_MINOR, GC_MAJOR, GC_INCREMENTAL, GC_WEAKCB
} from '../index.js';

test('constructor rejects a bad capacity', () => {
    assert.throws(() => new GcProfiler(0), RangeError);
    assert.throws(() => new GcProfiler(NaN), RangeError);
    assert.throws(() => new GcProfiler(-4), RangeError);
});

test('injected events accumulate exact counts, sum, max, avg, and by-kind tallies', () => {
    const p = new GcProfiler(64);
    p.record(GC_MINOR, 2);
    p.record(GC_MINOR, 4);
    p.record(GC_MAJOR, 10);
    p.record(GC_INCREMENTAL, 1);
    p.record(GC_WEAKCB, 0.5);
    const g = p.summary().gc;
    assert.equal(g.count, 5);
    assert.equal(g.minor, 2);
    assert.equal(g.major, 1);
    assert.equal(g.incremental, 1);
    assert.equal(g.weakcb, 1);
    assert.equal(g.totalMs, 17.5);
    assert.equal(g.maxMs, 10);
    assert.equal(g.avgMs, 3.5);
    p.destroy();
});

test('p99 pause is the nearest-rank value over the window', () => {
    const p = new GcProfiler(128);
    for (let i = 1; i <= 100; i++) p.record(GC_MINOR, i);   // 1..100
    // nearest-rank p99 of 1..100 -> ceil(0.99*100)-1 = index 98 -> value 99
    assert.equal(p.summary().gc.p99Ms, 99);
    p.destroy();
});

test('checkNoGc default rule: any major GC is a violation', () => {
    const p = new GcProfiler(16);
    p.record(GC_MINOR, 3);                       // minors are fine by default
    assert.equal(checkNoGc(p.summary()).ok, true);
    p.record(GC_MAJOR, 12);
    const r = checkNoGc(p.summary());
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].metric, 'gc.major');
    assert.equal(r.violations[0].actual, 1);
    p.destroy();
});

test('checkNoGc honours pause, total, and minor budgets', () => {
    const p = new GcProfiler(16);
    p.record(GC_MINOR, 5); p.record(GC_MINOR, 9); p.record(GC_MINOR, 2);
    const s = p.summary();
    assert.equal(checkNoGc(s, { maxPauseMs: 8 }).ok, false);       // 9 > 8
    assert.equal(checkNoGc(s, { maxPauseMs: 10 }).ok, true);
    assert.equal(checkNoGc(s, { maxTotalMs: 10 }).ok, false);      // 16 > 10
    assert.equal(checkNoGc(s, { maxMinor: 2 }).ok, false);         // 3 > 2
    assert.equal(checkNoGc(s, { maxMinor: 3 }).ok, true);
    p.destroy();
});

test('assertNoGc throws a GcBudgetError that names the violation', () => {
    const p = new GcProfiler(16);
    p.record(GC_MAJOR, 20);
    assert.throws(
        () => assertNoGc(p.summary()),
        (e) => e instanceof GcBudgetError && /major GC/.test(e.message) && e.report.ok === false
    );
    assert.doesNotThrow(() => assertNoGc(new GcProfiler(4).summary()));
    p.destroy();
});

test('reset clears every tally; destroy releases buffers', () => {
    const p = new GcProfiler(16);
    p.record(GC_MAJOR, 10); p.record(GC_MINOR, 2);
    p.reset();
    const g = p.summary().gc;
    assert.equal(g.count, 0);
    assert.equal(g.major, 0);
    assert.equal(g.totalMs, 0);
    assert.equal(g.p99Ms, 0);
    p.destroy();
    assert.equal(p._dur, null);
});

test('a fresh profiler reports a supported source and a zeroed summary', () => {
    const p = new GcProfiler(16);
    const s = p.summary();
    assert.equal(s.schema, 'lite-gc/1');
    assert.ok(['gc', 'heap', 'none'].includes(s.source));
    assert.equal(s.gc.count, 0);
    p.destroy();
});

test('reset() clears every windowed accumulator: heap, timing, and the frame heuristic', () => {
    const gc = new GcProfiler(64);
    gc.sampleHeap(0, 0);
    gc.sampleHeap(1000, 10 * 1048576);                 // 10MB over 1s
    gc.sampleHeap(1100, 2 * 1048576);                  // a drop: freed 8MB
    gc.markFrame(16); gc.markFrame(16); gc.markFrame(60);
    gc.record(4, 2.5);                                  // one major
    gc.reset();

    // an asymmetric second window: 1MB over 0.5s -> 2 MB/s. Any leak skews it.
    gc.sampleHeap(2000, 0);
    gc.sampleHeap(2500, 1048576);
    const s = gc.summary();
    assert.equal(s.heap.allocBytes, 1048576, 'allocBytes reflects only this window');
    assert.equal(Math.round(s.heap.allocRateBytesPerSec / 1048576 * 100) / 100, 2, 'rate is 2 MB/s, not a blend');
    assert.equal(s.heap.gcDrops, 0, 'drops cleared');
    assert.equal(s.heap.freedBytes, 0, 'freedBytes cleared');
    assert.equal(s.frames.count, 0, 'frame count cleared');
    assert.equal(s.frames.long, 0, 'long-frame count cleared');
    assert.equal(s.gc.major, 0, 'gc buckets cleared');
});
