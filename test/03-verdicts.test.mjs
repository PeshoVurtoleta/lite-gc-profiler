// Standard-case tests for the three-state verdict introduced in v1.1.0.
// Adversarial and edge cases (silent-pass holes, truncated summaries, missing
// phases) live in test/torture/g3-5-verdicts.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    GcProfiler, checkNoGc, assertNoGc,
    GcBudgetError, GcInconclusiveError,
    VERDICT_MATRIX, GC_MAJOR, GC_MINOR
} from '../Gc.js';

// Hand-built summaries let us drive checkNoGc against any source without
// needing to fake the runtime's PerformanceObserver support.
function makeSummary(source, over) {
    const s = {
        schema: 'lite-gc/1',
        source,
        supported: source !== 'none',
        gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, p99Ms: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 },
        heap: { supported: source !== 'none', used: 0, peak: 0, firstSample: 0, samples: 0, allocBytes: 0, allocRateBytesPerSec: 0, gcDrops: 0, freedBytes: 0 },
        frames: { count: 0, long: 0 }
    };
    if (over) {
        if (over.gc) Object.assign(s.gc, over.gc);
        if (over.heap) Object.assign(s.heap, over.heap);
        if (over.frames) Object.assign(s.frames, over.frames);
    }
    return s;
}

// ---- pass path ----

test('empty summary + no rules -> pass with default maxMajor:0', () => {
    const s = makeSummary('gc');
    const r = checkNoGc(s);
    assert.equal(r.verdict, 'pass');
    assert.equal(r.ok, true);
    assert.equal(r.violations.length, 0);
    assert.deepEqual(r.checked, { maxMajor: true });
});

test('explicit empty rules object -> pass, nothing checked', () => {
    const s = makeSummary('gc');
    const r = checkNoGc(s, {});
    assert.equal(r.verdict, 'pass');
    assert.equal(r.ok, true);
    assert.deepEqual(r.checked, {});
});

test('gc source + clean summary + all rules -> pass, all checked', () => {
    const s = makeSummary('gc', { heap: { samples: 5 } });
    const r = checkNoGc(s, { maxMajor: 0, maxMinor: 0, maxPauseMs: 4, maxTotalMs: 10, maxAllocRate: 2 * 1024 * 1024 });
    assert.equal(r.verdict, 'pass');
    assert.deepEqual(r.checked, { maxMajor: true, maxMinor: true, maxPauseMs: true, maxTotalMs: true, maxAllocRate: true });
});

// ---- fail path ----

test('one major GC -> fail on maxMajor:0', () => {
    const s = makeSummary('gc', { gc: { major: 1, count: 1, totalMs: 12, maxMs: 12 } });
    const r = checkNoGc(s, { maxMajor: 0 });
    assert.equal(r.verdict, 'fail');
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].metric, 'gc.major');
    assert.equal(r.violations[0].actual, 1);
});

test('multiple violations aggregate', () => {
    const s = makeSummary('gc', { gc: { major: 2, minor: 5, count: 7, totalMs: 20, maxMs: 12 } });
    const r = checkNoGc(s, { maxMajor: 0, maxMinor: 0, maxPauseMs: 4 });
    assert.equal(r.verdict, 'fail');
    assert.equal(r.violations.length, 3);
});

test('fail takes precedence over inconclusive (violation is hard evidence)', () => {
    // maxMajor is violated (verifiable); maxAllocRate is inconclusive (no heap samples).
    // Verdict must be 'fail', not 'inconclusive' -- the gate has real evidence.
    const s = makeSummary('gc', { gc: { major: 1, count: 1 } });
    const r = checkNoGc(s, { maxMajor: 0, maxAllocRate: 1000 });
    assert.equal(r.verdict, 'fail');
    assert.equal(r.checked.maxMajor, true);
    assert.equal(r.checked.maxAllocRate, false);
});

// ---- inconclusive path (the silent-hole closures) ----

test("source='none' + maxMajor:0 -> inconclusive, NOT pass", () => {
    // The v1.0.0 silent hole. Green here would be a G1 regression.
    const s = makeSummary('none');
    const r = checkNoGc(s, { maxMajor: 0 });
    assert.equal(r.verdict, 'inconclusive');
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 0);
    assert.deepEqual(r.checked, { maxMajor: false });
});

test("source='heap' + kind rules -> inconclusive (Chrome cannot distinguish kinds)", () => {
    const s = makeSummary('heap', { heap: { samples: 10 } });
    const r = checkNoGc(s, { maxMajor: 0, maxMinor: 0 });
    assert.equal(r.verdict, 'inconclusive');
    assert.deepEqual(r.checked, { maxMajor: false, maxMinor: false });
});

test("source='heap' + maxAllocRate with samples -> verifiable", () => {
    const s = makeSummary('heap', { heap: { samples: 5, allocRateBytesPerSec: 500 } });
    const r = checkNoGc(s, { maxAllocRate: 1000 });
    assert.equal(r.verdict, 'pass');
    assert.equal(r.checked.maxAllocRate, true);
});

test('maxAllocRate without heap samples -> inconclusive (needsHeap)', () => {
    const s = makeSummary('gc'); // heap.samples = 0
    const r = checkNoGc(s, { maxAllocRate: 1000 });
    assert.equal(r.verdict, 'inconclusive');
    assert.equal(r.checked.maxAllocRate, false);
});

test('maxAllocRate with only 1 heap sample -> inconclusive (delta needs 2)', () => {
    const s = makeSummary('gc', { heap: { samples: 1 } });
    const r = checkNoGc(s, { maxAllocRate: 1000 });
    assert.equal(r.verdict, 'inconclusive');
    assert.equal(r.checked.maxAllocRate, false);
});

// ---- assertNoGc semantics ----

test('assertNoGc throws GcBudgetError on fail', () => {
    const s = makeSummary('gc', { gc: { major: 1, count: 1 } });
    assert.throws(() => assertNoGc(s, { maxMajor: 0 }), GcBudgetError);
});

test('assertNoGc throws GcInconclusiveError on inconclusive by default', () => {
    const s = makeSummary('none');
    assert.throws(() => assertNoGc(s, { maxMajor: 0 }), GcInconclusiveError);
});

test('assertNoGc with allowInconclusive:true returns report on inconclusive', () => {
    const s = makeSummary('none');
    const r = assertNoGc(s, { maxMajor: 0 }, { allowInconclusive: true });
    assert.equal(r.verdict, 'inconclusive');
});

test('assertNoGc with allowInconclusive:true still throws on fail', () => {
    const s = makeSummary('gc', { gc: { major: 1, count: 1 } });
    assert.throws(() => assertNoGc(s, { maxMajor: 0 }, { allowInconclusive: true }), GcBudgetError);
});

test('assertNoGc returns report on pass', () => {
    const s = makeSummary('gc');
    const r = assertNoGc(s, { maxMajor: 0 });
    assert.equal(r.verdict, 'pass');
});

test('GcInconclusiveError names the unverifiable rules', () => {
    const s = makeSummary('none');
    try {
        assertNoGc(s, { maxMajor: 0, maxMinor: 0 });
        assert.fail('should have thrown');
    } catch (e) {
        assert.ok(e instanceof GcInconclusiveError);
        assert.match(e.message, /maxMajor/);
        assert.match(e.message, /maxMinor/);
        assert.match(e.message, /source=none/);
    }
});

// ---- verdict matrix as data ----

test('VERDICT_MATRIX covers every rule name in GcRules', () => {
    const rules = ['maxMajor', 'maxMinor', 'maxPauseMs', 'maxTotalMs', 'maxAllocRate'];
    for (const r of rules) {
        assert.ok(VERDICT_MATRIX[r], 'missing row: ' + r);
        assert.ok(VERDICT_MATRIX[r].gc, 'missing gc col for ' + r);
        assert.ok(VERDICT_MATRIX[r].heap, 'missing heap col for ' + r);
        assert.ok(VERDICT_MATRIX[r].none, 'missing none col for ' + r);
    }
});

test('VERDICT_MATRIX: none source verifies nothing', () => {
    for (const rule in VERDICT_MATRIX) {
        assert.equal(VERDICT_MATRIX[rule].none, 'no', rule + ' should be no on none');
    }
});

// ---- backward compat ----

test('report.ok mirrors verdict==="pass" for all three verdicts', () => {
    const pass = checkNoGc(makeSummary('gc'), { maxMajor: 0 });
    assert.equal(pass.ok, true);

    const fail = checkNoGc(makeSummary('gc', { gc: { major: 1, count: 1 } }), { maxMajor: 0 });
    assert.equal(fail.ok, false);

    const inc = checkNoGc(makeSummary('none'), { maxMajor: 0 });
    assert.equal(inc.ok, false);
});

test('violations shape unchanged from v1.0.0', () => {
    const s = makeSummary('gc', { gc: { major: 3, count: 3 } });
    const r = checkNoGc(s, { maxMajor: 0 });
    const v = r.violations[0];
    assert.equal(typeof v.metric, 'string');
    assert.equal(typeof v.limit, 'number');
    assert.equal(typeof v.actual, 'number');
    assert.equal(typeof v.reason, 'string');
});

// ---- live check: real profiler produces a summary the gate accepts ----

test('live: real profiler, clean loop, gate passes', async () => {
    const gc = new GcProfiler().start();
    // A pooled loop -- should not trigger any collections in the measurement window.
    const buf = new Float64Array(1024);
    for (let i = 0; i < 100000; i++) buf[i & 1023] = i * 0.5;
    await new Promise((r) => setTimeout(r, 50));
    const rep = assertNoGc(gc.summary(), { maxMajor: 0 });
    assert.equal(rep.verdict, 'pass');
    gc.stop();
});
