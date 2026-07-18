// G99.10 -- Deep torture. Attack-first, same discipline as G99.9.
//
// New axes:
//   [axis T] observation-window integrity -- start()/reset() are hard cutoffs;
//            a profiler never inherits the GC backlog of code it did not watch
//   [axis U] capacity ceiling -- the pow2 hang and the ring resource bomb
//            (child-process probes: a regression here must not hang CI)
//   [axis V] retention floor -- the smallest allocation measureOps can convict,
//            and the zero-alloc workload it must not
//   [axis W] deep teardown -- accounting invariants while the deepest nested
//            structures V8 will build are dropped and collected
//
// Run under --expose-gc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    GcProfiler, checkNoGc, measureOps, checkOps, GC_MAJOR,
    formatConsole, formatJson, formatMarkdown, formatGithubAnnotations
} from '../../Gc.js';

const hasGc = typeof globalThis.gc === 'function';
const GC_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'Gc.js');

function churn(n) { const a = []; for (let i = 0; i < n; i++) a.push({ i, s: 'x' + i }); return a.length; }

// ---------------------------------------------------------------------------
// [axis T] observation-window integrity
// ---------------------------------------------------------------------------

test('[axis T] a profiler started after a GC storm counts nothing from it', async () => {
    if (!hasGc) return;
    // Sync GC-heavy code blocks the event loop; its 'gc' entries sit in the
    // dispatch queue and node delivers them to observers registered later in
    // the same turn. Before the observation-window floor, this profiler
    // inherited that backlog and a zero-GC gate over quiet code FALSELY failed.
    for (let r = 0; r < 5; r++) { churn(100000); globalThis.gc(); }
    globalThis.gc();                               // backlog signature: 6 forced majors
    const p = new GcProfiler(64).start();          // same tick: backlog undelivered
    let x = 0; for (let i = 0; i < 1000; i++) x += i;   // alloc-free window
    await p.settle({ maxWaitMs: 400 });
    p.stop();
    const s = p.summary();
    // The window is alloc-free but V8 may still schedule a step of its own
    // inside it (with a legitimately post-start timestamp), so the pin targets
    // the backlog's signature: inheriting it delivers 6 majors, not <=1 event.
    assert.ok(s.gc.count <= 1,
        'inherited ' + s.gc.count + ' pre-start GC event(s); start() must be a hard cutoff');
    assert.ok(s.gc.major <= 1,
        s.gc.major + ' of the 6 forced pre-start majors leaked into the window');
    assert.ok(x > 0);
});

test('[axis T] phase sums equal gc.count even when sync GC work precedes start()', async () => {
    if (!hasGc) return;
    // The accounting symptom of the same backlog: pre-start entries counted
    // globally but attributable to no phase, so sum(phases) < gc.count.
    { const sink = []; measureOps((i) => { sink.push({ a: i }); return sink.length; }, { ops: 30000, warmup: 100, capacity: 64 }); }
    const p = new GcProfiler(128).start();
    p.phase('build'); churn(200000); globalThis.gc();
    p.phase('drain'); globalThis.gc();
    await p.settle({ maxWaitMs: 600 });
    p.stop();
    const s = p.summary();
    let sum = 0;
    for (const k of Object.keys(s.phases)) sum += s.phases[k].gc.count;
    assert.equal(sum, s.gc.count,
        'phase attribution incomplete: sum=' + sum + ' count=' + s.gc.count
        + ' -- pre-start backlog leaked into the window');
});

test('[axis T] reset() advances the floor: queued pre-reset entries cannot repopulate', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(64).start();
    for (let r = 0; r < 4; r++) { churn(100000); globalThis.gc(); }   // recorded OR queued
    p.reset();                                     // same tick: queue may be undelivered
    let x = 0; for (let i = 0; i < 1000; i++) x += i;
    await p.settle({ maxWaitMs: 400 });
    p.stop();
    // Tolerate one spontaneous post-reset event; the pinned failure mode is the
    // 4-forced-major backlog repopulating the cleared counters.
    assert.ok(p.summary().gc.count <= 1,
        'reset() cleared counters but ' + p.summary().gc.count
        + ' queued pre-reset event(s) repopulated them');
    assert.ok(x > 0);
});

test('[axis T] restart after stop() does not admit events from the stopped gap', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(64).start();
    globalThis.gc();
    await p.settle({ maxWaitMs: 400 });
    p.stop();
    const before = p.summary().gc.count;
    churn(200000); globalThis.gc();                // stopped gap
    p.start();                                     // same tick as the gap's entries
    let x = 0; for (let i = 0; i < 100; i++) x += i;
    await p.settle({ maxWaitMs: 400 });
    p.stop();
    assert.ok(p.summary().gc.count - before <= 1,
        'restart admitted ' + (p.summary().gc.count - before) + ' stopped-gap event(s)');
    assert.ok(x >= 0);
});

test('[axis T] the synthetic record() API bypasses the floor (test surface stays usable)', () => {
    // record() exists so tests can inject events with arbitrary timestamps;
    // the observation floor applies to the observer path only.
    const p = new GcProfiler(16);                  // never started: floor is Infinity
    p.record(GC_MAJOR, 5, 1);                      // startTime long before any floor
    assert.equal(p.summary().gc.major, 1, 'record() must not be subject to the observer floor');
});

// ---------------------------------------------------------------------------
// [axis U] capacity ceiling -- probes run in child processes with a timeout,
// because the defect being pinned was an INFINITE LOOP: a regression must
// surface as a failed test, never as a hung CI job.
// ---------------------------------------------------------------------------

function probeCapacity(expr) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
        `const { GcProfiler, measureOps } = await import(${JSON.stringify('file://' + GC_PATH)});
         try { ${expr}; console.log('NO_THROW'); }
         catch (e) { console.log('THREW:' + e.constructor.name); }`
    ], { timeout: 5000, encoding: 'utf8' });
    if (r.error && r.error.code === 'ETIMEDOUT') return 'HUNG';
    return (r.stdout || '').trim();
}

test('[axis U] capacities past 2**30 throw RangeError instead of looping forever', () => {
    // pow2 used `p <<= 1`; the 32-bit shift wrapped negative at 2**31, then to
    // 0, and the loop spun forever. new GcProfiler(2**30 + 1) was an
    // infinite-loop DoS reachable from the constructor and every measure lane.
    for (const expr of [
        'new GcProfiler(2**30 + 1)',
        'new GcProfiler(2**31)',
        'new GcProfiler(Number.MAX_SAFE_INTEGER)',
        'measureOps(i => i, { ops: 1, capacity: 2**31 })'
    ]) {
        const out = probeCapacity(expr);
        assert.notEqual(out, 'HUNG', 'INFINITE LOOP: ' + expr + ' hung the child process');
        assert.equal(out, 'THREW:RangeError', expr + ' -> ' + out);
    }
});

test('[axis U] the ring resource bomb is closed: over-ceiling capacities are rejected', () => {
    // 2**26 silently allocated a 1 GB ring; 2**30 crashed the process on a
    // 16 GB allocation attempt. Both now reject at validation.
    assert.equal(probeCapacity('new GcProfiler(2**26)'), 'THREW:RangeError');
    assert.equal(probeCapacity('new GcProfiler(2**24 + 1)'), 'THREW:RangeError');
    assert.equal(probeCapacity('measureOps(i => i, { ops: 1, capacity: 2**25 })'), 'THREW:RangeError');
});

test('[axis U] the ceiling boundary itself is usable', () => {
    assert.equal(probeCapacity('new GcProfiler(16777216)'), 'NO_THROW',
        'MAX_RING_CAPACITY exactly must be accepted');
    assert.equal(probeCapacity('new GcProfiler(2**20)'), 'NO_THROW');
});

// ---------------------------------------------------------------------------
// [axis V] retention floor
// ---------------------------------------------------------------------------

test('[axis V] one tiny object retained per op is convicted by a tight budget', () => {
    // The smallest realistic leak: a single {a:i} pushed per op. V8's minimum
    // object footprint puts this in the tens of bytes; an 8 B/op budget must
    // catch it. If this ever reads ~0, per-op retention accounting is broken
    // at the floor and only megabyte-scale leaks would fail gates.
    const sink = [];
    const r = measureOps((i) => { sink.push({ a: i }); return sink.length; },
        { ops: 50000, warmup: 100, capacity: 64 });
    if (r.bytesPerOp === null) return;             // no memory channel here
    assert.ok(r.bytesPerOp > 16,
        'one-object-per-op retention read ' + r.bytesPerOp + ' B/op -- below detectability');
    assert.equal(checkOps(r, { maxBytesPerOp: 16 }).verdict, 'fail');
});

test('[axis V] a genuinely zero-alloc op is not convicted at scale', () => {
    // The mirror pin. At 50k fast ops, V8 self-noise amortizes to several
    // bytes/op and can trip a single-digit budget -- that is measurement
    // sizing, not a defect. At 500k ops the floor must be well under 1 B/op,
    // so tight budgets are legitimate on properly-sized runs.
    const buf = new Float64Array(4);
    const r = measureOps((i) => { buf[i & 3] = i; return buf[0]; },
        { ops: 500000, warmup: 1000, capacity: 64 });
    if (r.bytesPerOp === null) return;
    assert.ok(r.bytesPerOp < 16,
        'zero-alloc floor at 500k ops read ' + r.bytesPerOp + ' B/op');
    assert.notEqual(checkOps(r, { maxBytesPerOp: 16 }).verdict, 'fail',
        'zero-alloc workload falsely convicted');
});

// ---------------------------------------------------------------------------
// [axis W] deep teardown
// ---------------------------------------------------------------------------

test('[axis W] accounting invariants hold while the deepest structures are torn down', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(256).start();
    p.phase('list'); { let h = null; for (let i = 0; i < 1_000_000; i++) h = { v: i, next: h }; assert.equal(h.v, 999999); h = null; }
    globalThis.gc();
    p.phase('closures'); { let f = () => 0; for (let i = 0; i < 10_000; i++) { const g = f; f = () => g() + 1; } f = null; }
    globalThis.gc();
    p.phase('protos'); { let o = {}; for (let i = 0; i < 5_000; i++) o = Object.create(o); o = null; }
    globalThis.gc();
    p.phase('maps'); { let m = new Map(); for (let i = 0; i < 1_000; i++) { const n = new Map(); m.set('c', n); m.set('v', i); m = n; } m = null; }
    globalThis.gc();
    p.phase('arrays'); { let a = []; for (let i = 0; i < 100_000; i++) { const n = [i]; a.push(n); a = n; } a = null; }
    globalThis.gc();
    await p.settle({ maxWaitMs: 1000 });
    p.stop();
    const s = p.summary(); const g = s.gc;
    assert.ok(g.count >= 5, 'teardown storm registered only ' + g.count + ' events');
    assert.equal(g.minor + g.major + g.incremental + g.weakcb, g.count, 'kind buckets lost events');
    assert.ok(Number.isFinite(g.totalMs) && g.p99Ms <= g.maxMs + 1e-9 && g.maxMs <= g.totalMs + 1e-9);
    let sum = 0;
    for (const k of Object.keys(s.phases)) sum += s.phases[k].gc.count;
    assert.equal(sum, g.count, 'deep-teardown events escaped phase attribution');
    for (const k of ['list', 'closures', 'protos', 'maps', 'arrays']) assert.ok(k in s.phases);
    const rep = checkNoGc(s, { maxMajor: 0 });
    assert.equal(rep.verdict, 'fail');
    for (const fmt of [formatConsole, formatJson, formatMarkdown, formatGithubAnnotations]) {
        assert.ok(fmt(rep).length > 0, fmt.name + ' failed on the teardown report');
    }
});

test('[axis W] all 16 region depths see their events with GC forced at every level', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(256).start();
    for (let d = 0; d < 16; d++) { p.enter('d' + d); churn(30000); globalThis.gc(); }
    await p.settle({ maxWaitMs: 800 });
    for (let d = 15; d >= 0; d--) p.exit();
    p.stop();
    const s = p.summary();
    for (let d = 0; d < 16; d++) {
        assert.ok('d' + d in s.byRegion, 'depth ' + d + ' missing');
        assert.ok(s.byRegion['d' + d].gc.count >= 1, 'depth ' + d + ' lost its event');
    }
});

test('[axis W] a region interval spanning stop()/start() stays coherent', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(64).start();
    p.enter('spanning');
    globalThis.gc();
    await p.settle({ maxWaitMs: 400 });
    p.stop();
    const during = s0(p);
    churn(40000); globalThis.gc();                 // stopped gap: must not attribute
    p.start();
    globalThis.gc();
    await p.settle({ maxWaitMs: 400 });
    assert.doesNotThrow(() => p.exit(), 'region wedged across the stop/start gap');
    p.stop();
    const s = p.summary();
    assert.ok('spanning' in s.byRegion);
    assert.ok(s.byRegion.spanning.gc.count >= during, 'region lost pre-gap events');
    function s0(pp) { const t = pp.summary(); return t.byRegion.spanning ? t.byRegion.spanning.gc.count : 0; }
});

// ---------------------------------------------------------------------------
// [axis X] the synthetic record() surface
//
// record() exists so tests can inject events with arbitrary timestamps, which
// makes it the one place a caller hands the profiler a number the profiler did
// not measure. It used to accept anything: `+durationMs || 0` turned NaN into a
// silent 0, and let negatives and Infinity straight through into the running
// totals. Garbage-in would be a defensible policy for a test surface, except
// that the garbage becomes indistinguishable from a real reading downstream.
// ---------------------------------------------------------------------------

test('[axis X] a negative duration cannot drive the accounting negative', () => {
    // record(kind, -100) previously produced totalMs = -95 alongside maxMs = 5:
    // maxMs > totalMs, avgMs negative, and a maxTotalMs rule against a negative
    // total passes anything at all.
    const p = new GcProfiler(32, { source: 'gc' });
    assert.throws(() => p.record(GC_MAJOR, -100, 1), RangeError);
    p.record(GC_MAJOR, 5, 1);
    p.record(GC_MAJOR, 3, 2);
    const g = p.summary().gc;
    assert.ok(g.totalMs >= 0, 'totalMs went negative: ' + g.totalMs);
    assert.ok(g.maxMs <= g.totalMs + 1e-9, 'maxMs ' + g.maxMs + ' > totalMs ' + g.totalMs);
    assert.ok(g.avgMs >= 0 && Number.isFinite(g.avgMs), 'avgMs unusable: ' + g.avgMs);
});

test('[axis X] non-finite durations are rejected, not silently coerced', () => {
    const p = new GcProfiler(32, { source: 'gc' });
    for (const bad of [NaN, Infinity, -Infinity, '5', null, undefined, {}]) {
        assert.throws(() => p.record(GC_MAJOR, bad, 1), RangeError,
            'duration ' + String(bad) + ' must be rejected');
    }
    // Infinity previously poisoned totalMs and avgMs to non-finite for every
    // later read of the same profiler, not just the bad entry.
    p.record(GC_MAJOR, 5, 1);
    assert.ok(Number.isFinite(p.summary().gc.totalMs));
});

test('[axis X] a non-finite startTime is rejected', () => {
    const p = new GcProfiler(32, { source: 'gc' });
    assert.throws(() => p.record(GC_MAJOR, 5, NaN), RangeError);
    assert.throws(() => p.record(GC_MAJOR, 5, Infinity), RangeError);
});

test('[axis X] legitimate record() usage is unaffected', () => {
    // Zero duration, omitted startTime, and the arbitrary-timestamp injection
    // the rest of the suite depends on all keep working.
    const p = new GcProfiler(32, { source: 'gc' });
    assert.doesNotThrow(() => p.record(GC_MAJOR, 0, 1));
    assert.doesNotThrow(() => p.record(GC_MAJOR, 5));
    assert.doesNotThrow(() => p.record(GC_MAJOR, 2.5, 0));
    assert.equal(p.summary().gc.count, 3);
});
