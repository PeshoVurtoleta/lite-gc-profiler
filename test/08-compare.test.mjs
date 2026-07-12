// Standard-case tests for compareGc introduced in v1.2.0 (G4).
// Adversarial cases (harness noise absorption, source mismatch, missing heap)
// live in test/torture/g5-5-reps.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    GcProfiler, compareGc, assertCompare,
    GcBudgetError, GcInconclusiveError,
    GC_MAJOR, GC_MINOR
} from '../Gc.js';

function makeSummary(source, over) {
    const s = {
        schema: 'lite-gc/1', source, supported: source !== 'none',
        gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, p99Ms: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 },
        heap: { supported: source !== 'none', used: 0, peak: 0, firstSample: 0, samples: 0, allocBytes: 0, allocRateBytesPerSec: 0, gcDrops: 0, freedBytes: 0 },
        frames: { count: 0, long: 0 }, phases: {}
    };
    if (over) {
        if (over.gc) Object.assign(s.gc, over.gc);
        if (over.heap) Object.assign(s.heap, over.heap);
    }
    return s;
}

// ---- pass path ----

test('identical control and candidate -> pass on all rules', () => {
    const c = makeSummary('gc', { gc: { major: 3, minor: 5 } });
    const rep = compareGc(c, c, { maxExtraMajor: 0, maxExtraMinor: 0 });
    assert.equal(rep.verdict, 'pass');
});

test('candidate with less GC than control -> pass on all delta rules', () => {
    // Candidate is BETTER than control; delta is negative, no violation.
    const control = makeSummary('gc', { gc: { major: 5, minor: 10 } });
    const candidate = makeSummary('gc', { gc: { major: 2, minor: 3 } });
    const rep = compareGc(control, candidate, { maxExtraMajor: 0, maxExtraMinor: 0 });
    assert.equal(rep.verdict, 'pass');
});

test('candidate within extra allowance -> pass', () => {
    const control = makeSummary('gc', { gc: { major: 0, minor: 5 } });
    const candidate = makeSummary('gc', { gc: { major: 1, minor: 7 } });
    const rep = compareGc(control, candidate, { maxExtraMajor: 1, maxExtraMinor: 2 });
    assert.equal(rep.verdict, 'pass');
});

// ---- fail path ----

test('candidate with extra major beyond allowance -> fail', () => {
    const control = makeSummary('gc', { gc: { major: 0 } });
    const candidate = makeSummary('gc', { gc: { major: 2 } });
    const rep = compareGc(control, candidate, { maxExtraMajor: 0 });
    assert.equal(rep.verdict, 'fail');
    assert.equal(rep.violations[0].metric, 'gc.major.delta');
    assert.equal(rep.violations[0].actual, 2);
});

test('pause delta fails', () => {
    const control = makeSummary('gc', { gc: { maxMs: 2.0 } });
    const candidate = makeSummary('gc', { gc: { maxMs: 5.5 } });
    const rep = compareGc(control, candidate, { maxExtraPauseMs: 1 });
    assert.equal(rep.verdict, 'fail');
    assert.equal(rep.violations[0].metric, 'gc.maxMs.delta');
    assert.ok(Math.abs(rep.violations[0].actual - 3.5) < 1e-9);
});

test('alloc rate delta fails (both need heap samples)', () => {
    const control = makeSummary('gc', {
        heap: { samples: 5, allocRateBytesPerSec: 1000 }
    });
    const candidate = makeSummary('gc', {
        heap: { samples: 5, allocRateBytesPerSec: 5000 }
    });
    const rep = compareGc(control, candidate, { maxExtraAllocRate: 1000 });
    assert.equal(rep.verdict, 'fail');
});

// ---- inconclusive: source mismatch ----

test('source mismatch -> inconclusive with reason', () => {
    const control = makeSummary('gc', { gc: { major: 0 } });
    const candidate = makeSummary('heap', { heap: { samples: 5 } });
    const rep = compareGc(control, candidate, { maxExtraMajor: 0 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.reason, 'source_mismatch');
    assert.equal(rep.source, 'mixed');
    assert.equal(rep.controlSource, 'gc');
    assert.equal(rep.candidateSource, 'heap');
});

test("source mismatch: both 'none' vs 'gc' also inconclusive", () => {
    const control = makeSummary('none');
    const candidate = makeSummary('gc');
    const rep = compareGc(control, candidate, { maxExtraMajor: 0 });
    assert.equal(rep.verdict, 'inconclusive');
});

// ---- inconclusive: rule verifiability ----

test("both 'heap' + maxExtraMajor -> inconclusive (kind rules)", () => {
    const control = makeSummary('heap', { heap: { samples: 5 } });
    const candidate = makeSummary('heap', { heap: { samples: 5 } });
    const rep = compareGc(control, candidate, { maxExtraMajor: 0 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checked.maxExtraMajor, false);
});

test('maxExtraAllocRate requires heap samples on BOTH sides', () => {
    const control = makeSummary('gc');                    // no samples
    const candidate = makeSummary('gc', {
        heap: { samples: 5, allocRateBytesPerSec: 1000 }
    });
    const rep = compareGc(control, candidate, { maxExtraAllocRate: 1000 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checked.maxExtraAllocRate, false);
});

// ---- fail precedence ----

test('fail beats inconclusive: verifiable violation + unverifiable rule = fail', () => {
    const control = makeSummary('gc', { gc: { major: 0 } });
    const candidate = makeSummary('gc', { gc: { major: 3 } });    // no heap samples
    const rep = compareGc(control, candidate, {
        maxExtraMajor: 0,
        maxExtraAllocRate: 1000        // unverifiable (no samples)
    });
    assert.equal(rep.verdict, 'fail');
    assert.equal(rep.checked.maxExtraMajor, true);
    assert.equal(rep.checked.maxExtraAllocRate, false);
});

// ---- assertCompare ----

test('assertCompare throws GcBudgetError on fail', () => {
    const control = makeSummary('gc', { gc: { major: 0 } });
    const candidate = makeSummary('gc', { gc: { major: 3 } });
    assert.throws(
        () => assertCompare(control, candidate, { maxExtraMajor: 0 }),
        GcBudgetError
    );
});

test('assertCompare throws GcInconclusiveError on source mismatch by default', () => {
    const control = makeSummary('gc');
    const candidate = makeSummary('heap', { heap: { samples: 5 } });
    assert.throws(
        () => assertCompare(control, candidate, { maxExtraMajor: 0 }),
        GcInconclusiveError
    );
});

test('assertCompare with allowInconclusive:true returns report on source mismatch', () => {
    const control = makeSummary('gc');
    const candidate = makeSummary('heap', { heap: { samples: 5 } });
    const rep = assertCompare(control, candidate, { maxExtraMajor: 0 }, { allowInconclusive: true });
    assert.equal(rep.verdict, 'inconclusive');
});

test('assertCompare returns report on pass', () => {
    const c = makeSummary('gc', { gc: { major: 0 } });
    const rep = assertCompare(c, c, { maxExtraMajor: 0 });
    assert.equal(rep.verdict, 'pass');
});

// ---- back-compat / defaults ----

test('default rules applied when rules omitted (maxExtraMajor: 0)', () => {
    const control = makeSummary('gc', { gc: { major: 0 } });
    const candidate = makeSummary('gc', { gc: { major: 1 } });
    const rep = compareGc(control, candidate);
    assert.equal(rep.verdict, 'fail');
    assert.equal(rep.violations[0].metric, 'gc.major.delta');
});

// ---- live: real profiler differential ----

test('live: two clean profilers -> pass differential', async () => {
    async function runClean() {
        const gc = new GcProfiler().start();
        const buf = new Float64Array(1024);
        for (let i = 0; i < 50000; i++) buf[i & 1023] = i * 0.5;
        await gc.settle();
        const s = gc.summary();
        gc.stop();
        return s;
    }
    const control = await runClean();
    const candidate = await runClean();
    const rep = compareGc(control, candidate, { maxExtraMajor: 0 });
    // Both are pooled loops; delta should be zero.
    assert.equal(rep.verdict, 'pass');
});
