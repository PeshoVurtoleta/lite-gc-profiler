// Standard-case tests for baseline lock introduced in v1.2.0 (G6).
// Adversarial cases (fingerprint field poisoning, invalid schema, half-empty
// aggregates) live in test/torture/g5-5-reps.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    aggregateGc,
    captureFingerprint, createBaseline, checkAgainstBaseline, assertAgainstBaseline,
    GcBudgetError, GcInconclusiveError
} from '../Gc.js';

function makeSummary(source, over) {
    const s = {
        schema: 'lite-gc/1', source, supported: source !== 'none',
        gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, p99Ms: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 },
        heap: { supported: source !== 'none', used: 0, peak: 0, firstSample: 0, samples: 0, allocBytes: 0, allocRateBytesPerSec: 0, gcDrops: 0, freedBytes: 0 },
        frames: { count: 0, long: 0 }, phases: {}
    };
    if (over) { if (over.gc) Object.assign(s.gc, over.gc); if (over.heap) Object.assign(s.heap, over.heap); }
    return s;
}
const dirty = (major) => makeSummary('gc', { gc: { major, count: major, totalMs: major * 5, maxMs: 5 } });
const pause = (maxMs) => makeSummary('gc', { gc: { maxMs, count: 1, totalMs: maxMs } });

// ---- captureFingerprint ----

test('captureFingerprint returns object with the five documented fields', () => {
    const fp = captureFingerprint();
    assert.equal(typeof fp.node, 'string');
    assert.equal(typeof fp.v8, 'string');
    assert.equal(typeof fp.platform, 'string');
    assert.equal(typeof fp.arch, 'string');
    assert.equal(typeof fp.cpu, 'string');
});

test('captureFingerprint reflects the current node process', () => {
    const fp = captureFingerprint();
    // Node returns e.g. 'v22.7.0'; simply assert it looks like a node version.
    assert.match(fp.node, /^v\d/);
});

// ---- createBaseline ----

test('createBaseline: JSON-able with schema and captured aggregate', () => {
    const agg = aggregateGc([dirty(0), dirty(0), dirty(0)]);
    const baseline = createBaseline(agg);
    assert.equal(baseline.schema, 'lite-gc-baseline/1');
    assert.equal(baseline.reps, 3);
    assert.equal(baseline.gc.major.max, 0);
    assert.equal(typeof baseline.capturedAt, 'string');
    assert.ok(baseline.fingerprint);
    // Round-trip through JSON to confirm it's serializable.
    const roundTrip = JSON.parse(JSON.stringify(baseline));
    assert.deepEqual(roundTrip.gc.major, baseline.gc.major);
});

test('createBaseline: drops the raw `all` arrays', () => {
    const agg = aggregateGc([dirty(1), dirty(2), dirty(3)]);
    const baseline = createBaseline(agg);
    // The aggregate has .all; the baseline should not (a baseline is a published
    // summary, not a raw log).
    assert.ok(agg.gc.major.all);
    assert.equal(baseline.gc.major.all, undefined);
});

test('createBaseline: rejects non-aggregate input', () => {
    assert.throws(() => createBaseline({}), TypeError);
    assert.throws(() => createBaseline(null), TypeError);
});

// ---- checkAgainstBaseline: pass path ----

test('current matches baseline exactly -> pass', () => {
    const reps = [dirty(0), dirty(0), dirty(0)];
    const baseline = createBaseline(aggregateGc(reps));
    const currentAgg = aggregateGc(reps);   // identical
    const rep = checkAgainstBaseline(currentAgg, baseline);
    assert.equal(rep.verdict, 'pass');
    assert.equal(rep.violations.length, 0);
});

test('current better than baseline -> pass', () => {
    const baselineReps = [dirty(3), dirty(3), dirty(3)];
    const baseline = createBaseline(aggregateGc(baselineReps));
    const currentReps = [dirty(0), dirty(0), dirty(0)];
    const rep = checkAgainstBaseline(aggregateGc(currentReps), baseline);
    assert.equal(rep.verdict, 'pass');
});

// ---- checkAgainstBaseline: fail path ----

test('current worse than baseline -> fail with metric-specific violations', () => {
    const baselineReps = [dirty(0), dirty(0), dirty(0)];
    const baseline = createBaseline(aggregateGc(baselineReps));
    const currentReps = [dirty(2), dirty(2), dirty(2)];
    const rep = checkAgainstBaseline(aggregateGc(currentReps), baseline);
    assert.equal(rep.verdict, 'fail');
    const majorViolation = rep.violations.find((v) => v.metric === 'gc.major');
    assert.ok(majorViolation);
    assert.equal(majorViolation.baselineMax, 0);
    assert.equal(majorViolation.currentMedian, 2);
});

test('regression semantics: current.median > baseline.max', () => {
    // Baseline reps had a noisy run: max=5, others=0. So baseline.gc.major.max=5.
    // Current: 3,3,3 -> median=3, which is <= baseline.max=5. Pass.
    const baselineReps = [dirty(0), dirty(0), dirty(5)];
    const baseline = createBaseline(aggregateGc(baselineReps));
    const currentReps = [dirty(3), dirty(3), dirty(3)];
    const rep = checkAgainstBaseline(aggregateGc(currentReps), baseline);
    assert.equal(rep.verdict, 'pass');
});

// ---- checkAgainstBaseline: fingerprint mismatch ----

test('fingerprint mismatch -> inconclusive by default', () => {
    const agg = aggregateGc([dirty(0)]);
    const baseline = createBaseline(agg);
    // Poison the baseline's fingerprint so the current process cannot match.
    baseline.fingerprint = { node: 'v14.0.0', v8: '0.0.0', platform: 'other', arch: 'other', cpu: 'other' };
    const rep = checkAgainstBaseline(agg, baseline);
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.reason, 'fingerprint_mismatch');
});

test('fingerprint mismatch with acceptFingerprintMismatch:true -> proceeds and carries audit field', () => {
    const agg = aggregateGc([dirty(0)]);
    const baseline = createBaseline(agg);
    baseline.fingerprint = { node: 'v14.0.0', v8: '0.0.0', platform: 'other', arch: 'other', cpu: 'other' };
    const rep = checkAgainstBaseline(agg, baseline, { acceptFingerprintMismatch: true });
    assert.equal(rep.verdict, 'pass');
    assert.equal(rep.fingerprintMismatchAccepted, true);
});

// ---- checkAgainstBaseline: invalid input ----

test('invalid baseline schema -> inconclusive', () => {
    const rep = checkAgainstBaseline(aggregateGc([dirty(0)]), { schema: 'wrong' });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.reason, 'invalid_baseline');
});

test('missing baseline -> inconclusive', () => {
    const rep = checkAgainstBaseline(aggregateGc([dirty(0)]), null);
    assert.equal(rep.verdict, 'inconclusive');
});

// ---- assertAgainstBaseline ----

test('assertAgainstBaseline throws GcBudgetError on fail', () => {
    const baseline = createBaseline(aggregateGc([dirty(0)]));
    const currentAgg = aggregateGc([dirty(5)]);
    assert.throws(() => assertAgainstBaseline(currentAgg, baseline), GcBudgetError);
});

test('assertAgainstBaseline throws GcInconclusiveError on fingerprint mismatch by default', () => {
    const agg = aggregateGc([dirty(0)]);
    const baseline = createBaseline(agg);
    baseline.fingerprint = { node: 'v14.0.0', v8: '0.0.0', platform: 'other', arch: 'other', cpu: 'other' };
    assert.throws(() => assertAgainstBaseline(agg, baseline), GcInconclusiveError);
});

test('assertAgainstBaseline with allowInconclusive:true returns report', () => {
    const agg = aggregateGc([dirty(0)]);
    const baseline = createBaseline(agg);
    baseline.fingerprint = { node: 'v14.0.0', v8: '0.0.0', platform: 'other', arch: 'other', cpu: 'other' };
    const rep = assertAgainstBaseline(agg, baseline, { allowInconclusive: true });
    assert.equal(rep.verdict, 'inconclusive');
});

test('assertAgainstBaseline returns report on pass', () => {
    const agg = aggregateGc([dirty(0)]);
    const baseline = createBaseline(agg);
    const rep = assertAgainstBaseline(agg, baseline);
    assert.equal(rep.verdict, 'pass');
});

// ---- round-trip through JSON ----

test('baseline survives JSON round-trip and still gates correctly', () => {
    const baselineReps = [dirty(0), dirty(0), dirty(0)];
    const baseline = createBaseline(aggregateGc(baselineReps));
    const serialized = JSON.stringify(baseline);
    const parsed = JSON.parse(serialized);

    // Pass path
    const rep1 = checkAgainstBaseline(aggregateGc([dirty(0)]), parsed);
    assert.equal(rep1.verdict, 'pass');

    // Fail path
    const rep2 = checkAgainstBaseline(aggregateGc([dirty(2)]), parsed);
    assert.equal(rep2.verdict, 'fail');
});
