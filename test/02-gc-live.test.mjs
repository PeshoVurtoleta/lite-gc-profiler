import test from 'node:test';
import assert from 'node:assert/strict';
import { GcProfiler, checkNoGc } from '../index.js';

// These exercise the real perf_hooks 'gc' observer. GC entries arrive asynchronously,
// so each phase settles a timer before reading. Run under `node --expose-gc`.
const settle = () => new Promise((r) => setTimeout(r, 80));
const hasGc = typeof PerformanceObserver !== 'undefined'
    && PerformanceObserver.supportedEntryTypes
    && PerformanceObserver.supportedEntryTypes.includes('gc');

const POOL = new Float64Array(60000);

async function capture(work) {
    if (globalThis.gc) globalThis.gc();
    const p = new GcProfiler(512).start();
    await new Promise((r) => setTimeout(r, 5));
    work();
    await settle();
    const s = p.summary();
    p.stop();
    return s;
}

function leaky() {
    let sink = null;
    for (let r = 0; r < 40; r++) {
        const a = new Array(60000);
        for (let i = 0; i < 60000; i++) a[i] = { x: i, y: i * 2, tag: 'p' + (i & 255) };
        sink = a;
    }
    if (sink) sink.length = 0;
}
function pooled() {
    for (let r = 0; r < 40; r++) for (let i = 0; i < 60000; i++) POOL[i] = POOL[i] * 1.0000001 + i;
}

test('the observer attaches on a gc-capable runtime', { skip: !hasGc }, () => {
    const p = new GcProfiler(16).start();
    assert.equal(p.running, true);
    assert.equal(p.source, 'gc');
    p.stop();
    assert.equal(p.running, false);
});

test('a leaky loop produces strictly more major GCs than a pooled one', { skip: !hasGc }, async () => {
    const L = await capture(leaky);
    const P = await capture(pooled);
    assert.ok(L.gc.count > 0, 'leaky triggered GC (count=' + L.gc.count + ')');
    assert.ok(L.gc.major > P.gc.major, `leaky majors (${L.gc.major}) > pooled majors (${P.gc.major})`);
    assert.ok(L.gc.totalMs > P.gc.totalMs, 'leaky spent more time paused');
});

test('the maxMajor:0 gate fails a leaky window and passes a pooled one', { skip: !hasGc }, async () => {
    const L = await capture(leaky);
    const P = await capture(pooled);
    assert.equal(checkNoGc(L).ok, false);
    assert.equal(checkNoGc(P).ok, true);
});
