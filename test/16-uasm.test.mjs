// Standard-case tests for the uasm source introduced in Batch 5 (G12).
// Adversarial cases (cross-origin isolation gaps, stale performance.memory,
// mixed sources across reps) live in test/torture/g13-5-browser.test.mjs.
//
// Node cannot exercise the real performance.measureUserAgentSpecificMemory
// API, so these tests focus on gate BEHAVIOR against synthetic summaries
// shaped like what the browser would produce. Real browser behavior is
// documented in demo/calibration.html.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    GcProfiler, checkNoGc, assertNoGc, compareGc,
    aggregateGc, gateReps,
    GcInconclusiveError,
    VERDICT_MATRIX
} from '../Gc.js';

function makeSummary(source, over) {
    const s = {
        schema: 'lite-gc/1',
        source,
        supported: source !== 'none',
        gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, p99Ms: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 },
        heap: { supported: source === 'heap', used: 0, peak: 0, firstSample: 0, samples: 0, allocBytes: 0, allocRateBytesPerSec: 0, gcDrops: 0, freedBytes: 0 },
        uasm: { supported: source === 'uasm', bytes: 0, peak: 0, firstSample: 0, samples: 0, growthRate: 0 },
        frames: { count: 0, long: 0 },
        phases: {},
        byRegion: {}
    };
    if (over) {
        if (over.gc) Object.assign(s.gc, over.gc);
        if (over.heap) Object.assign(s.heap, over.heap);
        if (over.uasm) Object.assign(s.uasm, over.uasm);
    }
    return s;
}

// ---- VERDICT_MATRIX has uasm column ----

test('VERDICT_MATRIX contains uasm column for every rule', () => {
    for (const rule in VERDICT_MATRIX) {
        assert.ok(VERDICT_MATRIX[rule].uasm !== undefined,
            'rule ' + rule + ' missing uasm column');
    }
});

test('VERDICT_MATRIX uasm: kind and pause rules are no; maxAllocRate is needsUasm', () => {
    assert.equal(VERDICT_MATRIX.maxMajor.uasm, 'no');
    assert.equal(VERDICT_MATRIX.maxMinor.uasm, 'no');
    assert.equal(VERDICT_MATRIX.maxPauseMs.uasm, 'no');
    assert.equal(VERDICT_MATRIX.maxTotalMs.uasm, 'no');
    assert.equal(VERDICT_MATRIX.maxAllocRate.uasm, 'needsUasm');
});

// ---- summary.uasm shape ----

test('summary.uasm is always present, even without opt-in', () => {
    const gc = new GcProfiler();
    const s = gc.summary();
    assert.ok(s.uasm, 'summary.uasm must be present');
    assert.equal(typeof s.uasm.supported, 'boolean');
    assert.equal(typeof s.uasm.bytes, 'number');
    assert.equal(typeof s.uasm.samples, 'number');
    assert.equal(typeof s.uasm.growthRate, 'number');
});

test('summary.uasm.supported is false on node (no browser API)', () => {
    const gc = new GcProfiler();
    assert.equal(gc.summary().uasm.supported, false);
});

// ---- sampleUasm() lifecycle ----

test('sampleUasm() no-ops gracefully when API absent', async () => {
    const gc = new GcProfiler();
    const result = await gc.sampleUasm();
    assert.equal(result.supported, false);
    // Should not have recorded anything.
    assert.equal(gc.summary().uasm.samples, 0);
});

test('sampleUasm() returns a Promise', () => {
    const gc = new GcProfiler();
    const result = gc.sampleUasm();
    assert.equal(typeof result.then, 'function');
});

// ---- constructor source option ----

test("constructor accepts source: 'auto' (default)", () => {
    const gc = new GcProfiler(256, { source: 'auto' });
    assert.equal(gc.source, 'gc');                          // node auto-detects to gc
});

test("constructor accepts source: 'gc' explicitly", () => {
    const gc = new GcProfiler(256, { source: 'gc' });
    assert.equal(gc.source, 'gc');
});

test("constructor accepts source: 'none' explicitly", () => {
    const gc = new GcProfiler(256, { source: 'none' });
    assert.equal(gc.source, 'none');
});

test("constructor throws on source: 'uasm' when API unavailable", () => {
    assert.throws(() => new GcProfiler(256, { source: 'uasm' }), RangeError);
});

test('constructor throws on unknown source', () => {
    assert.throws(() => new GcProfiler(256, { source: 'bogus' }), RangeError);
});

// ---- checkNoGc verdicts on uasm-sourced summaries ----

test("source='uasm' + maxMajor:0 -> inconclusive (no event kinds on uasm)", () => {
    const s = makeSummary('uasm', { uasm: { supported: true, samples: 5 } });
    const rep = checkNoGc(s, { maxMajor: 0 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checked.maxMajor, false);
});

test("source='uasm' + maxAllocRate with 2 samples -> verifiable pass", () => {
    const s = makeSummary('uasm', {
        uasm: { supported: true, samples: 2, growthRate: 500000 }
    });
    const rep = checkNoGc(s, { maxAllocRate: 1000000 });
    assert.equal(rep.verdict, 'pass');
    assert.equal(rep.checked.maxAllocRate, true);
});

test("source='uasm' + maxAllocRate with 2 samples exceeding limit -> fail", () => {
    const s = makeSummary('uasm', {
        uasm: { supported: true, samples: 2, growthRate: 2000000 }
    });
    const rep = checkNoGc(s, { maxAllocRate: 1000000 });
    assert.equal(rep.verdict, 'fail');
    assert.ok(rep.violations.some((v) => v.metric.includes('allocRate')));
});

test("source='uasm' + maxAllocRate with <2 samples -> inconclusive", () => {
    const s = makeSummary('uasm', {
        uasm: { supported: true, samples: 1, growthRate: 0 }
    });
    const rep = checkNoGc(s, { maxAllocRate: 1000000 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checked.maxAllocRate, false);
});

test("source='uasm': maxAllocRate uses uasm.growthRate NOT heap.allocRateBytesPerSec", () => {
    // Cross-channel data isolation: even if heap looks bad, uasm-sourced
    // gate reads uasm growth.
    const s = makeSummary('uasm', {
        uasm: { supported: true, samples: 2, growthRate: 100000 },        // clean uasm
        heap: { supported: false, samples: 100, allocRateBytesPerSec: 999999999 }  // "dirty" heap (but ignored)
    });
    const rep = checkNoGc(s, { maxAllocRate: 500000 });
    assert.equal(rep.verdict, 'pass', 'uasm-sourced gate must read uasm, not heap');
});

// ---- compareGc with uasm summaries ----

test('compareGc: uasm control vs uasm candidate, clean deltas -> pass', () => {
    const control = makeSummary('uasm', { uasm: { supported: true, samples: 2, growthRate: 100000 } });
    const candidate = makeSummary('uasm', { uasm: { supported: true, samples: 2, growthRate: 150000 } });
    const rep = compareGc(control, candidate, { maxExtraAllocRate: 100000 });
    assert.equal(rep.verdict, 'pass');
});

test('compareGc: uasm control vs uasm candidate, extra growth over limit -> fail', () => {
    const control = makeSummary('uasm', { uasm: { supported: true, samples: 2, growthRate: 100000 } });
    const candidate = makeSummary('uasm', { uasm: { supported: true, samples: 2, growthRate: 500000 } });
    const rep = compareGc(control, candidate, { maxExtraAllocRate: 100000 });
    assert.equal(rep.verdict, 'fail');
});

test('compareGc: uasm vs heap -> inconclusive (source mismatch)', () => {
    const control = makeSummary('uasm', { uasm: { supported: true, samples: 2, growthRate: 100000 } });
    const candidate = makeSummary('heap', { heap: { supported: true, samples: 5, allocRateBytesPerSec: 200000 } });
    const rep = compareGc(control, candidate);
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.reason, 'source_mismatch');
});

// ---- gateReps aggregation across uasm reps ----

test('gateReps with all uasm reps -> aggregates uasm', () => {
    const reps = [
        makeSummary('uasm', { uasm: { supported: true, samples: 3, growthRate: 100000 } }),
        makeSummary('uasm', { uasm: { supported: true, samples: 3, growthRate: 200000 } }),
        makeSummary('uasm', { uasm: { supported: true, samples: 3, growthRate: 150000 } })
    ];
    const rep = gateReps(reps, { maxAllocRate: 500000 });
    assert.equal(rep.verdict, 'pass');
    assert.equal(rep.source, 'uasm');
});

test('gateReps with mixed uasm and heap reps -> inconclusive (mixed_sources)', () => {
    const reps = [
        makeSummary('uasm', { uasm: { supported: true, samples: 2, growthRate: 100000 } }),
        makeSummary('heap', { heap: { supported: true, samples: 2, allocRateBytesPerSec: 200000 } })
    ];
    const rep = gateReps(reps, { maxAllocRate: 500000 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.reason, 'mixed_sources');
});

// ---- aggregateGc handles uasm summaries ----

test('aggregateGc preserves source across uasm-only reps', () => {
    const reps = [
        makeSummary('uasm', { uasm: { supported: true, samples: 2, growthRate: 100000 } }),
        makeSummary('uasm', { uasm: { supported: true, samples: 2, growthRate: 200000 } })
    ];
    const agg = aggregateGc(reps);
    assert.deepEqual(agg.sources, ['uasm']);
});

// ---- reset clears uasm state ----

test('reset clears uasm counters', () => {
    const gc = new GcProfiler();
    // Manually poke uasm state (can't call real sampleUasm() in node)
    gc._uasmSamples = 5;
    gc._uasmBytes = 10000;
    gc._uasmPeak = 20000;
    gc.reset();
    const s = gc.summary();
    assert.equal(s.uasm.samples, 0);
    assert.equal(s.uasm.bytes, 0);
    assert.equal(s.uasm.peak, 0);
});
