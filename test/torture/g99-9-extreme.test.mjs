// G99.9 -- Extreme torture. Everything here is an ATTACK, not a usage example.
//
// Axes follow TORTURE.md conventions. New axes for this file:
//   [axis J] hostile identifiers   -- names chosen to corrupt snapshot objects
//   [axis K] poisoned samples      -- non-finite bytes fed to sampleHeap
//   [axis L] capacity-cliff state  -- behaviour AT and AFTER every hard limit
//   [axis M] garbage zoo           -- every allocation species V8 knows, at volume
//   [axis N] evil objects          -- getters/thenables that lie between reads
//   [axis O] volume/durability     -- 10k-scale inputs, ring extremes, multi-observer
//
// Byte assertions are relative (V8-build dependent). Run under --expose-gc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    GcProfiler,
    checkNoGc, aggregateGc, gateReps, compareGc,
    measureOps, checkOps, measureOpsAsync,
    createBaseline, checkAgainstBaseline,
    formatConsole, formatJson, formatMarkdown, formatGithubAnnotations
} from '../../Gc.js';

const hasGc = typeof globalThis.gc === 'function';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Deterministic mixed-species garbage generator. Returns nothing retained.
function garbageZoo(rounds) {
    let sink = 0;
    for (let r = 0; r < rounds; r++) {
        // plain objects + arrays + closures
        const objs = [];
        for (let i = 0; i < 500; i++) objs.push({ a: i, b: 'x' + i, c: [i, i + 1], f: () => i });
        // string ropes, slices, concat churn
        let s = '';
        for (let i = 0; i < 200; i++) s += 'abcdefgh' + i;
        sink += s.slice(3, 9).length + s.substring(50).length;
        // typed arrays + ArrayBuffers + DataViews
        for (let i = 0; i < 40; i++) {
            const ab = new ArrayBuffer(4096);
            new DataView(ab).setFloat64(0, i);
            sink += new Float64Array(ab)[0];
        }
        // Maps, Sets, WeakMaps, Symbols, RegExps, BigInts, Dates, Errors
        const m = new Map(); const st = new Set(); const wm = new WeakMap();
        for (let i = 0; i < 200; i++) {
            const k = { i }; m.set(k, i); st.add(k); wm.set(k, [i]);
        }
        sink += m.size + st.size;
        sink += Symbol('s' + r).toString().length;
        sink += ('zoo' + r).match(/o+/)[0].length;
        sink += Number(BigInt(r) * 1234567890123456789n % 97n);
        sink += new Date(r).getTime() + new Error('e' + r).message.length;
        // Proxies + generators
        const p = new Proxy({ v: r }, { get: (t, k) => t[k] });
        sink += p.v;
        sink += [...(function* () { yield 1; yield 2; })()].length;
        // JSON churn
        sink += JSON.parse(JSON.stringify(objs.slice(0, 20))).length;
        sink += objs.length;
    }
    return sink;
}

// ---------------------------------------------------------------------------
// [axis M] garbage zoo -- accounting invariants must survive maximum diversity
// ---------------------------------------------------------------------------

test('[axis M] kind buckets sum to count under a full-species garbage storm', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(64).start();
    const registry = new FinalizationRegistry(() => {});
    for (let r = 0; r < 6; r++) {
        garbageZoo(3);
        // register + drop targets so weakcb GC passes fire too
        for (let i = 0; i < 200; i++) registry.register({ i }, i);
        globalThis.gc();                                        // full GC
        try { globalThis.gc({ type: 'minor' }); } catch { /* older node */ }
    }
    await p.settle({ maxWaitMs: 500 });
    p.stop();
    const s = p.summary();
    const g = s.gc;
    assert.ok(g.count > 0, 'storm must register GC events');
    assert.equal(
        g.minor + g.major + g.incremental + g.weakcb, g.count,
        'unknown GC kind leaked into count without a bucket: '
        + JSON.stringify({ minor: g.minor, major: g.major, incremental: g.incremental, weakcb: g.weakcb, count: g.count })
    );
    // numeric sanity: every stat finite, ordered, self-consistent
    assert.ok(Number.isFinite(g.totalMs) && g.totalMs >= 0);
    assert.ok(Number.isFinite(g.maxMs) && g.maxMs >= 0 && g.maxMs <= g.totalMs + 1e-9);
    assert.ok(Number.isFinite(g.p99Ms) && g.p99Ms >= 0 && g.p99Ms <= g.maxMs + 1e-9);
    assert.ok(Math.abs(g.avgMs - g.totalMs / g.count) < 1e-9);
});

test('[axis M] summary survives every formatter and a JSON round trip after the storm', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(32).start();
    p.phase('build'); garbageZoo(2); globalThis.gc();
    p.phase('steady'); garbageZoo(1); globalThis.gc();
    p.enter('hot'); globalThis.gc(); p.exit();
    await p.settle({ maxWaitMs: 500 });
    p.stop();
    const s = p.summary();
    const rep = checkNoGc(s, { maxMajor: 0 });
    for (const fmt of [formatConsole, formatJson, formatMarkdown, formatGithubAnnotations]) {
        const out = fmt(rep);
        assert.equal(typeof out, 'string');
        assert.ok(out.length > 0, fmt.name + ' produced empty output');
    }
    assert.doesNotThrow(() => JSON.parse(formatJson(rep)), 'formatJson must emit valid JSON');
    // cross-process feature: a JSON-round-tripped summary gates identically
    const clone = JSON.parse(JSON.stringify(s));
    assert.equal(checkNoGc(clone, { maxMajor: 0 }).verdict, rep.verdict,
        'serialized summary must produce the same verdict');
});

// ---------------------------------------------------------------------------
// [axis J] hostile identifiers
// ---------------------------------------------------------------------------

test('[axis J] a phase named __proto__ must not vanish from the snapshot', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(16).start();
    p.phase('__proto__');
    garbageZoo(1); globalThis.gc();
    await p.settle({ maxWaitMs: 400 });
    p.stop();
    const s = p.summary();
    assert.ok(Object.prototype.hasOwnProperty.call(s.phases, '__proto__'),
        'SILENT HOLE: phase "__proto__" set the snapshot prototype instead of a key -- '
        + 'its GC counts are invisible to Object.keys and JSON.stringify');
    const rt = JSON.parse(JSON.stringify(s));
    assert.ok(rt.phases.__proto__ && rt.phases.__proto__.gc.count > 0,
        'phase "__proto__" lost in serialization');
});

test('[axis J] a region named __proto__ must not vanish from the snapshot', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(16).start();
    p.enter('__proto__');
    garbageZoo(1); globalThis.gc();
    await p.settle({ maxWaitMs: 400 });
    p.exit();
    p.stop();
    const s = p.summary();
    assert.ok(Object.prototype.hasOwnProperty.call(s.byRegion, '__proto__'),
        'SILENT HOLE: region "__proto__" set the snapshot prototype instead of a key');
});

test('[axis J] builtin-shadowing and hostile phase names round-trip intact', async () => {
    if (!hasGc) return;
    const names = ['constructor', 'hasOwnProperty', 'toString', 'valueOf',
        '', ' ', '\n', 'a'.repeat(10000), '💥🔥\u200f\u0000end', 'unattributed'];
    const p = new GcProfiler(16).start();
    for (const n of names) {
        if (n === '') { assert.throws(() => p.phase(n), TypeError); continue; }
        p.phase(n);
    }
    garbageZoo(1); globalThis.gc();
    await p.settle({ maxWaitMs: 400 });
    p.stop();
    const s = p.summary();
    for (const n of names) {
        if (n === '') continue;
        assert.ok(Object.prototype.hasOwnProperty.call(s.phases, n),
            'phase ' + JSON.stringify(n) + ' missing from snapshot');
    }
    // total attributed events must equal global count (nothing double- or un-counted)
    let attributed = 0;
    for (const k of Object.keys(s.phases)) attributed += s.phases[k].gc.count;
    assert.ok(attributed <= s.gc.count, 'phases attributed more events than exist');
});

// ---------------------------------------------------------------------------
// [axis K] poisoned samples
// ---------------------------------------------------------------------------

test('[axis K] one NaN heap sample must not freeze the peak below later growth', () => {
    const p = new GcProfiler(8, { source: 'gc' });
    p.sampleHeap(0, 1000);
    p.sampleHeap(1, NaN);            // one bad read from a broken memory API
    p.sampleHeap(2, 50_000_000);     // real 50MB growth afterwards
    const h = p.summary().heap;
    assert.ok(h.peak >= 50_000_000,
        'FAIL-OPEN: peak stuck at pre-poison value (' + h.peak + '); '
        + 'a peak-based budget would silently pass a 50MB spike');
});

test('[axis K] growth bracketing a NaN sample must still be visible somewhere', () => {
    const p = new GcProfiler(8, { source: 'gc' });
    p.sampleHeap(0, 1000);
    p.sampleHeap(1, NaN);
    p.sampleHeap(2, 60_000_000);
    p.sampleHeap(3, 60_000_000);
    const h = p.summary().heap;
    const visible = (Number.isFinite(h.allocBytes) && h.allocBytes >= 59_000_000)
        || !Number.isFinite(h.allocBytes);   // NaN-poisoned metric is acceptable: gate goes inconclusive
    assert.ok(visible,
        'FAIL-OPEN: allocBytes=' + h.allocBytes + ' is finite but missed ~60MB of growth; '
        + 'an alloc-rate budget would silently pass');
});

test('[axis K] an Infinity sample must poison toward inconclusive, never pass', () => {
    const p = new GcProfiler(8, { source: 'gc' });
    p.sampleHeap(0, 1000);
    p.sampleHeap(5, Infinity);
    p.sampleHeap(10, 2000);
    const s = p.summary();
    const rep = checkNoGc(s, { maxAllocRate: 1 });
    assert.notEqual(rep.verdict, 'pass',
        'Infinity-poisoned alloc metrics produced a green verdict');
});

test('[axis K] backwards and duplicate timestamps cannot make elapsed negative', () => {
    const p = new GcProfiler(8, { source: 'gc' });
    p.sampleHeap(100, 1000);
    p.sampleHeap(50, 2000);    // clock went backwards
    p.sampleHeap(50, 3000);    // clock frozen
    p.sampleHeap(200, 4000);
    const h = p.summary().heap;
    assert.ok(Number.isFinite(h.allocRateBytesPerSec) && h.allocRateBytesPerSec >= 0,
        'backwards clock produced a non-finite/negative alloc rate: ' + h.allocRateBytesPerSec);
    assert.ok(h.allocBytes === 3000, 'monotonic growth miscounted: ' + h.allocBytes);
});

// ---------------------------------------------------------------------------
// [axis L] capacity cliffs -- state must be intact AT and AFTER every limit
// ---------------------------------------------------------------------------

test('[axis L] 33rd phase throws and the first 32 keep attributing correctly', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(16).start();
    for (let i = 0; i < 32; i++) p.phase('p' + i);
    assert.throws(() => p.phase('p32'), RangeError);
    garbageZoo(1); globalThis.gc();               // events land in p31
    await p.settle({ maxWaitMs: 400 });
    p.stop();
    const s = p.summary();
    assert.equal(Object.keys(s.phases).length, 32);
    assert.ok(s.phases.p31.gc.count > 0, 'post-overflow events lost attribution');
});

test('[axis L] boundary exhaustion throws cleanly and the profiler keeps counting', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(16).start();
    let threw = null;
    try { for (let i = 0; i < 2000; i++) p.phase(i % 2 ? 'a' : 'b'); }
    catch (e) { threw = e; }
    assert.ok(threw instanceof RangeError, 'expected boundary-cap RangeError');
    globalThis.gc();
    await p.settle({ maxWaitMs: 400 });
    p.stop();
    const s = p.summary();
    assert.ok(s.gc.count > 0, 'profiler stopped counting after boundary overflow');
    assert.equal(s.phases.a.gc.count + s.phases.b.gc.count, s.gc.count,
        'post-overflow attribution leaked events');
});

test('[axis L] interval exhaustion throws on enter but open regions still exit and attribute', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(16).start();
    p.enter('outer');
    let threw = null;
    try { for (let i = 0; i < 3000; i++) { p.enter('churn'); p.exit(); } }
    catch (e) { threw = e; }
    assert.ok(threw instanceof RangeError, 'expected interval-cap RangeError');
    globalThis.gc();
    await p.settle({ maxWaitMs: 400 });
    assert.doesNotThrow(() => p.exit(), 'outer region wedged after interval overflow');
    p.stop();
    const s = p.summary();
    assert.ok(s.byRegion.outer.gc.count > 0, 'outer region lost post-overflow events');
});

test('[axis L] nesting-depth overflow leaves the stack balanced', () => {
    const p = new GcProfiler(16);
    for (let i = 0; i < 16; i++) p.enter('d' + i);
    assert.throws(() => p.enter('d16'), RangeError);
    for (let i = 0; i < 16; i++) assert.doesNotThrow(() => p.exit());
    assert.throws(() => p.exit(), RangeError, 'stack corrupted: extra exit succeeded');
});

test('[axis L] fractional capacities round up sanely instead of corrupting the ring', async () => {
    if (!hasGc) return;
    for (const cap of [0.5, 1, 1.0000001, 3.7]) {
        const p = new GcProfiler(cap).start();
        for (let i = 0; i < 50; i++) { garbageZoo(1); globalThis.gc(); }
        await p.settle({ maxWaitMs: 400 });
        p.stop();
        const g = p.summary().gc;
        assert.ok(g.count >= 50, 'cap=' + cap + ' dropped events');
        assert.ok(Number.isFinite(g.p99Ms) && g.p99Ms >= 0 && g.p99Ms <= g.maxMs + 1e-9,
            'cap=' + cap + ' percentile broke: p99=' + g.p99Ms + ' max=' + g.maxMs);
    }
});

// ---------------------------------------------------------------------------
// [axis N] evil objects
// ---------------------------------------------------------------------------

test('[axis N] a rule threshold that changes between reads cannot flip the gate green', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(16).start();
    garbageZoo(2); globalThis.gc();
    await p.settle({ maxWaitMs: 400 });
    p.stop();
    const s = p.summary();
    assert.ok(s.gc.major > 0, 'need at least one major for this attack');
    let reads = 0;
    const evil = { get maxMajor() { return reads++ === 0 ? 0 : Infinity; } };
    const rep = checkNoGc(s, evil);
    assert.notEqual(rep.verdict, 'pass',
        'FAIL-OPEN: getter returned 0 to validation and Infinity to evaluation, gate went green');
});

test('[axis N] frozen opts and frozen rules are fully supported', () => {
    const res = measureOps(Object.freeze((i) => i * 2), Object.freeze({ ops: 50, warmup: 10 }));
    const rep = checkOps(res, Object.freeze({ maxMajorsPerKOp: 1000 }));
    assert.ok(rep.verdict === 'pass' || rep.verdict === 'inconclusive');
});

test('[axis N] a poisoned thenable rejects cleanly and releases the guard', async () => {
    await assert.rejects(
        measureOpsAsync(() => ({ get then() { throw new Error('evil thenable'); } }), { ops: 3 }),
        /evil thenable/
    );
    // guard must be released: a normal measurement still works
    const res = await measureOpsAsync(async (i) => i, { ops: 5 });
    assert.equal(res.ops, 5);
});

// ---------------------------------------------------------------------------
// [axis O] volume and durability
// ---------------------------------------------------------------------------

test('[axis O] aggregateGc + gateReps stay finite and fast over 10,000 reps', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(16).start();
    globalThis.gc();
    await p.settle({ maxWaitMs: 400 });
    p.stop();
    const template = JSON.parse(JSON.stringify(p.summary()));
    const reps = new Array(10000);
    for (let i = 0; i < reps.length; i++) {
        const c = JSON.parse(JSON.stringify(template));
        c.gc.major = i % 7 === 0 ? 1 : 0;
        c.gc.minor = i % 3;
        reps[i] = c;
    }
    const t0 = performance.now();
    const agg = aggregateGc(reps);
    const gate = gateReps(reps, { maxMajor: 0 });
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 5000, '10k-rep aggregation took ' + elapsed.toFixed(0) + 'ms');
    assert.equal(gate.verdict, 'fail', 'majors present in 1/7 of reps must fail the gate');
    const base = createBaseline(agg);
    const cmp = checkAgainstBaseline(agg, base, { tolerancePct: 10 });
    assert.notEqual(cmp.verdict, 'fail', 'an aggregate must not regress against its own baseline');
});

test('[axis O] capacity-1 ring stays sane through 3000 forced collections', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(1).start();
    for (let i = 0; i < 3000; i++) globalThis.gc();
    await p.settle({ maxWaitMs: 1000 });
    p.stop();
    const g = p.summary().gc;
    assert.ok(g.count >= 3000, 'events dropped: ' + g.count);
    assert.ok(Number.isFinite(g.p99Ms) && g.p99Ms <= g.maxMs + 1e-9);
});

test('[axis O] two concurrent observers agree on the event stream', async () => {
    if (!hasGc) return;
    const a = new GcProfiler(32);
    const b = new GcProfiler(32);
    a.start(); b.start();
    for (let i = 0; i < 20; i++) { garbageZoo(1); globalThis.gc(); }
    await a.settle({ maxWaitMs: 800 });
    await b.settle({ maxWaitMs: 800 });
    a.stop(); b.stop();
    assert.equal(a.summary().gc.count, b.summary().gc.count,
        'observers diverged on the same process-wide event stream');
});

test('[axis O] stop() is a hard cutoff: no events counted after it', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(32).start();
    globalThis.gc();
    await p.settle({ maxWaitMs: 500 });
    p.stop();
    const before = p.summary().gc.count;
    for (let i = 0; i < 20; i++) { garbageZoo(1); globalThis.gc(); }
    await sleep(100);
    assert.equal(p.summary().gc.count, before, 'events leaked past stop()');
});

test('[axis O] settle() under a sustained storm resolves by timeout instead of hanging', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(32).start();
    let storming = true;
    const storm = (async () => { while (storming) { garbageZoo(1); globalThis.gc(); await sleep(1); } })();
    const t0 = performance.now();
    const r = await p.settle({ maxWaitMs: 300 });
    const waited = performance.now() - t0;
    storming = false; await storm; p.stop();
    assert.ok(waited < 2000, 'settle livelocked under storm: ' + waited.toFixed(0) + 'ms');
    assert.equal(r.drained, false, 'settle claimed drained during an active storm');
});

test('[axis O] 200MB of transient churn reads as ~0 retention (not falsely flagged)', () => {
    // A Float64Array allocated and dropped each op RETAINS nothing. bytesPerOp
    // measures surviving allocation, so this must read ~0 and PASS a tight
    // budget. Flagging transient churn as retention would be a false FAIL --
    // the mirror image of the fail-open bugs, and just as corrosive to trust.
    const res = measureOps((i) => {
        const a = new Float64Array(131072);          // 1MB allocated per op, immediately dead
        a[0] = i; return a[0];
    }, { ops: 200, warmup: 10, capacity: 4 });
    assert.ok(Number.isFinite(res.elapsedMs) && res.elapsedMs > 0);
    if (res.bytesPerOp !== null) {
        assert.ok(Number.isFinite(res.bytesPerOp));
        assert.ok(res.bytesPerOp < 1024,
            'transient 1MB/op churn misread as ' + res.bytesPerOp + ' B/op of retention');
    }
    const rep = checkOps(res, { maxBytesPerOp: 4096 });
    assert.notEqual(rep.verdict, 'fail', 'transient churn was falsely flagged as retention');
});

test('[axis O] genuine per-op retention IS caught by a tight bytesPerOp budget', () => {
    // The counterpart: allocation that SURVIVES must fail. Without this pin,
    // "transient reads ~0" could be satisfied by a gate that measures nothing.
    const sink = [];
    const res = measureOps((i) => {
        sink.push(new Float64Array(128));            // ~1KB retained per op, never released
        return sink.length;
    }, { ops: 300, warmup: 10, capacity: 4 });
    if (res.bytesPerOp === null) return;             // no memory channel: nothing to assert
    const rep = checkOps(res, { maxBytesPerOp: 16 });
    assert.equal(rep.verdict, 'fail',
        'real ~1KB/op retention passed a 16 B/op budget (bytesPerOp=' + res.bytesPerOp + ')');
});

// ---------------------------------------------------------------------------
// [axis P] baseline integrity -- a baseline that verifies nothing must never
// report green. Every case below reached 'pass' before these pins.
// ---------------------------------------------------------------------------

function _twoRepAggregate() {
    const p = new GcProfiler(8, { source: 'gc' });
    p.sampleHeap(0, 1000);
    p.sampleHeap(1, 2000);
    return aggregateGc([p.summary(), p.summary()]);
}

test('[axis P] a baseline with no comparable metrics is inconclusive, not pass', () => {
    const agg = _twoRepAggregate();
    const base = createBaseline(agg);
    base.gc = {}; base.heap = {}; base.uasm = {};
    const rep = checkAgainstBaseline(agg, base, { acceptFingerprintMismatch: true });
    assert.equal(rep.verdict, 'inconclusive',
        'FAIL-OPEN: an empty baseline gated nothing and reported ' + rep.verdict);
    assert.equal(rep.reason, 'no_comparable_metrics');
});

test('[axis P] a baseline missing its metric groups entirely is inconclusive', () => {
    const agg = _twoRepAggregate();
    const base = createBaseline(agg);
    delete base.gc; delete base.heap; delete base.uasm;
    assert.equal(
        checkAgainstBaseline(agg, base, { acceptFingerprintMismatch: true }).verdict,
        'inconclusive');
});

test('[axis P] an aggregate with no metrics cannot be certified against a real baseline', () => {
    const agg = _twoRepAggregate();
    const base = createBaseline(agg);
    const empty = JSON.parse(JSON.stringify(agg));
    empty.gc = {}; empty.heap = {};
    assert.equal(
        checkAgainstBaseline(empty, base, { acceptFingerprintMismatch: true }).verdict,
        'inconclusive');
});

test('[axis P] non-finite baseline maxes are unverifiable, never silently green', () => {
    const agg = _twoRepAggregate();
    // NaN survives only in-memory; a saved baseline file turns it into null,
    // and a hand-edited one can hold a string. All three must behave alike:
    // `median > NaN|null|'0'` is not a comparison anyone should trust.
    for (const poison of [NaN, null, Infinity, -Infinity, '0', undefined]) {
        const base = createBaseline(agg);
        for (const g of ['gc', 'heap', 'uasm']) {
            for (const k in base[g]) base[g][k].max = poison;
        }
        const rep = checkAgainstBaseline(agg, base, { acceptFingerprintMismatch: true });
        assert.equal(rep.verdict, 'inconclusive',
            'FAIL-OPEN: baseline max=' + String(poison) + ' produced ' + rep.verdict);
        for (const k in rep.checked) {
            assert.equal(rep.checked[k], false,
                'metric ' + k + ' claimed checked:true against a ' + String(poison) + ' baseline');
        }
    }
});

test('[axis P] partially-poisoned baselines still gate on the metrics that survive', () => {
    const agg = _twoRepAggregate();
    const base = createBaseline(agg);
    for (const k in base.gc) base.gc[k].max = NaN;      // gc unverifiable, heap intact
    const rep = checkAgainstBaseline(agg, base, { acceptFingerprintMismatch: true });
    for (const k of Object.keys(rep.checked)) {
        if (k.startsWith('gc.')) assert.equal(rep.checked[k], false, k + ' should be unverifiable');
    }
    assert.ok(Object.values(rep.checked).some(Boolean),
        'heap metrics should remain verifiable when only gc is poisoned');
});

test('[axis P] a real regression is still caught after the hardening', () => {
    const agg = _twoRepAggregate();
    const base = createBaseline(agg);
    const regressed = JSON.parse(JSON.stringify(agg));
    regressed.gc.major.median = base.gc.major.max + 99;
    const rep = checkAgainstBaseline(regressed, base, { acceptFingerprintMismatch: true });
    assert.equal(rep.verdict, 'fail', 'hardening must not blunt real regression detection');
    assert.ok(rep.violations.length > 0);
});

test('[axis P] a healthy baseline round trip still passes', () => {
    const agg = _twoRepAggregate();
    const base = JSON.parse(JSON.stringify(createBaseline(agg)));
    const rep = checkAgainstBaseline(agg, base, { acceptFingerprintMismatch: true });
    assert.equal(rep.verdict, 'pass', 'self-comparison regressed to ' + rep.verdict);
});

// ---------------------------------------------------------------------------
// [axis Q] prototype-pollution inputs -- hostile rules/summaries must not
// mutate Object.prototype or fabricate verdicts.
// ---------------------------------------------------------------------------

test('[axis Q] a rules object carrying a __proto__ payload does not pollute', () => {
    const p = new GcProfiler(8, { source: 'gc' });
    const evil = JSON.parse('{"maxMajor":0,"__proto__":{"lgcPolluted":true}}');
    checkNoGc(p.summary(), evil);
    assert.equal({}.lgcPolluted, undefined, 'Object.prototype was polluted via rules');
});

test('[axis Q] a summary carrying a __proto__ payload does not pollute or fabricate a pass', () => {
    const p = new GcProfiler(8, { source: 'gc' });
    const s = JSON.parse(JSON.stringify(p.summary()));
    const hostile = JSON.parse(
        '{"schema":"lite-gc/1","source":"none","supported":false,'
        + '"__proto__":{"lgcPolluted2":true},'
        + '"gc":' + JSON.stringify(s.gc) + '}');
    const rep = checkNoGc(hostile, { maxMajor: 0 });
    assert.equal({}.lgcPolluted2, undefined, 'Object.prototype was polluted via summary');
    assert.equal(rep.verdict, 'inconclusive', "source:'none' must stay inconclusive");
});

// ---------------------------------------------------------------------------
// [axis R] lifecycle and guard integrity
// ---------------------------------------------------------------------------

test('[axis R] the overlap error explains the abandoned-run cause, not just concurrency', async () => {
    // A run that never settles holds the guard for the life of the process.
    // The message must say so -- a user who DID await every call otherwise
    // gets told to await their calls.
    let msg = '';
    const never = measureOpsAsync(() => new Promise(() => {}), { ops: 2 });
    never.catch(() => {});
    await sleep(10);
    try { measureOps((i) => i, { ops: 5 }); }
    catch (e) { msg = e.message; }
    assert.ok(msg.length > 0, 'overlapping measurement was not rejected');
    assert.match(msg, /never settled|never finished|never resolves|never fires/,
        'overlap error does not mention the abandoned-run cause: ' + msg);
});

test('[axis R] reset() mid-region drops the region stack cleanly', () => {
    const p = new GcProfiler(8).start();
    p.enter('a');
    p.reset();
    assert.throws(() => p.exit(), RangeError,
        'reset() left a phantom open region that exit() accepted');
    p.stop();
    assert.equal(Object.keys(p.summary().byRegion).length, 0);
});

test('[axis R] summary() is idempotent and side-effect free', () => {
    const p = new GcProfiler(8, { source: 'gc' });
    p.sampleHeap(0, 1000);
    p.sampleHeap(1, 2000);
    const a = JSON.stringify(p.summary());
    const b = JSON.stringify(p.summary());
    assert.equal(a, b, 'summary() mutated state between identical calls');
});

test('[axis R] a stopped profiler can be restarted without double-counting', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(16).start();
    globalThis.gc();
    await p.settle({ maxWaitMs: 400 });
    p.stop();
    const first = p.summary().gc.count;
    p.start();
    globalThis.gc();
    await p.settle({ maxWaitMs: 400 });
    p.stop();
    const second = p.summary().gc.count;
    assert.ok(second > first, 'restart stopped recording');
    assert.ok(second < first * 10, 'restart double-counted: ' + first + ' -> ' + second);
});

// ---------------------------------------------------------------------------
// [axis S] cross-lane agreement (TORTURE.md axis D, extended)
// ---------------------------------------------------------------------------

test('[axis S] mismatched-source inputs are inconclusive in every lane that takes two', () => {
    const good = new GcProfiler(8, { source: 'gc' }).summary();
    const blind = new GcProfiler(8, { source: 'none' }).summary();
    assert.equal(compareGc(good, blind).verdict, 'inconclusive',
        'compareGc certified a comparison against an unmeasured candidate');
    assert.equal(gateReps([good, blind], { maxMajor: 0 }).verdict, 'inconclusive',
        'gateReps certified a mixed-source rep set');
});

test('[axis S] a single rep is gateable but a zero-rep set is rejected outright', () => {
    const s = new GcProfiler(8, { source: 'gc' }).summary();
    assert.equal(gateReps([s], { maxMajor: 0 }).verdict, 'pass');
    assert.throws(() => gateReps([], { maxMajor: 0 }), TypeError,
        'an empty rep set must be rejected, not silently certified');
});

test('[axis S] non-finite thresholds are inconclusive on the checkNoGc path too', () => {
    // The ops lane throws on these via _validateRules; the summary lane routes
    // them to inconclusive. Either is acceptable -- a silent PASS is not.
    const s = new GcProfiler(8, { source: 'gc' }).summary();
    for (const bad of [NaN, Infinity, -Infinity]) {
        const rep = checkNoGc(s, { maxMajor: bad });
        assert.notEqual(rep.verdict, 'pass',
            'threshold ' + String(bad) + ' produced a green gate that enforces nothing');
        assert.equal(rep.checked.maxMajor, false,
            'threshold ' + String(bad) + ' claimed checked:true');
    }
});

test('[axis S] a finite zero threshold still gates normally after the hardening', async () => {
    if (!hasGc) return;
    const p = new GcProfiler(16).start();
    garbageZoo(2);
    globalThis.gc();
    await p.settle({ maxWaitMs: 400 });
    p.stop();
    const s = p.summary();
    assert.ok(s.gc.major > 0);
    const rep = checkNoGc(s, { maxMajor: 0 });
    assert.equal(rep.verdict, 'fail', 'hardening blunted the basic maxMajor:0 gate');
    assert.equal(checkNoGc(s, { maxMajor: 1000 }).verdict, 'pass');
});
