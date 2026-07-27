// Standard-case tests for the ratchet baseline (G28, v1.12.0).
// Adversarial cases live in test/torture/g28-6-ratchet.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    aggregateGc, createBaseline, checkAgainstBaseline, ratchetBaseline
} from '../Gc.js';

function mk(source, over) {
    const s = {
        schema: 'lite-gc/1', source, supported: source !== 'none',
        gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, p99Ms: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 },
        heap: { supported: source !== 'none', used: 0, peak: 0, firstSample: 0, samples: 0, allocBytes: 0, allocRateBytesPerSec: 0, gcDrops: 0, freedBytes: 0 },
        frames: { count: 0, long: 0 }, phases: {}
    };
    if (over && over.gc) Object.assign(s.gc, over.gc);
    if (over && over.heap) Object.assign(s.heap, over.heap);
    return s;
}
const dirty = (major) => mk('gc', { gc: { major, count: major, totalMs: major * 5, maxMs: 5 } });
const base = (major) => createBaseline(aggregateGc([dirty(major), dirty(major), dirty(major)]));
const agg = (major) => aggregateGc([dirty(major), dirty(major), dirty(major)]);

// ---------------------------------------------------------------------------
// the core promise: tighten, and only downward
// ---------------------------------------------------------------------------

test('a better run tightens the baseline to the better numbers', () => {
    const r = ratchetBaseline(base(8), agg(3));
    assert.equal(r.ratcheted, true);
    assert.equal(r.baseline.gc.major.max, 3, 'max ratchets down too, not just median');
    assert.equal(r.baseline.gc.major.median, 3);
    assert.equal(r.baseline.gc.major.min, 3);
    assert.ok(r.changed.includes('gc.major'));
});

test('the ratchet catches a give-back that a static baseline misses', () => {
    // The whole reason G28 exists.
    const original = base(8);
    const tightened = ratchetBaseline(original, agg(3)).baseline;
    const regressed = agg(7);
    assert.equal(checkAgainstBaseline(regressed, original).verdict, 'pass',
        'static baseline at 8 does not catch a regression to 7 -- the blind spot');
    assert.equal(checkAgainstBaseline(regressed, tightened).verdict, 'fail',
        'ratcheted baseline at 3 catches it');
});

test('a worse run never loosens the baseline', () => {
    const tight = ratchetBaseline(base(8), agg(3)).baseline;
    const r = ratchetBaseline(tight, agg(7));
    assert.equal(r.ratcheted, false);
    assert.equal(r.baseline.gc.major.max, 3, 'floor held at 3, not raised to 7');
    assert.deepEqual(r.changed, []);
});

test('ratcheting the same better run twice is idempotent', () => {
    const once = ratchetBaseline(base(8), agg(3));
    const twice = ratchetBaseline(once.baseline, agg(3));
    assert.equal(twice.ratcheted, false);
    assert.deepEqual(twice.changed, []);
    assert.deepEqual(twice.baseline.gc.major, once.baseline.gc.major);
});

test('an equal run does not ratchet (only strictly-better moves the floor)', () => {
    const r = ratchetBaseline(base(5), agg(5));
    assert.equal(r.ratcheted, false, 'current == baseline is not an improvement');
});

// ---------------------------------------------------------------------------
// provenance
// ---------------------------------------------------------------------------

test('a no-op ratchet leaves the baseline object unchanged (byte-identical)', () => {
    const original = base(3);
    const before = JSON.stringify(original);
    const r = ratchetBaseline(original, agg(8));   // worse -> no-op
    assert.equal(r.baseline, original, 'returns the SAME object reference on no-op');
    assert.equal(JSON.stringify(r.baseline), before);
});

test('a real ratchet refreshes capturedAt and keeps the schema', () => {
    const original = base(8);
    const r = ratchetBaseline(original, agg(3));
    assert.equal(r.baseline.schema, 'lite-gc-baseline/1');
    assert.equal(typeof r.baseline.capturedAt, 'string');
    // fingerprint refreshed to current capture (same host here, so equal, but present)
    assert.ok(r.baseline.fingerprint);
});

test('the tightened baseline round-trips through JSON and still gates', () => {
    const tight = ratchetBaseline(base(8), agg(3)).baseline;
    const wire = JSON.parse(JSON.stringify(tight));
    assert.equal(checkAgainstBaseline(agg(7), wire).verdict, 'fail');
    assert.equal(checkAgainstBaseline(agg(2), wire).verdict, 'pass');
});

// ---------------------------------------------------------------------------
// the "measured a metric it did not have" guard
// ---------------------------------------------------------------------------

test('a metric absent from the current run is carried forward unchanged', () => {
    // Old baseline has gc.major; a current aggregate whose gc block LACKS that
    // key entirely (a channel that stopped reporting it) must not drop the
    // floor. Note: a metric present but ZERO is a real improvement and SHOULD
    // ratchet -- absence is the key being gone, which we simulate by deleting.
    const original = base(8);
    const current = agg(3);
    delete current.gc.major;             // the metric is not present at all
    const r = ratchetBaseline(original, current);
    assert.equal(r.baseline.gc.major.max, 8,
        'floor preserved when the current aggregate does not carry the metric');
    assert.ok(!r.changed.includes('gc.major'), 'an absent metric cannot be in changed');
});

test('a non-finite current metric is carried forward, never min-d against NaN', () => {
    const original = base(8);
    const current = agg(3);
    current.gc.major = { min: NaN, median: NaN, max: NaN };   // broken-clock shape
    const r = ratchetBaseline(original, current);
    assert.equal(r.baseline.gc.major.max, 8, 'NaN cannot tighten a floor');
    assert.ok(!r.changed.includes('gc.major'));
});

test('multiple metrics tighten independently in one ratchet', () => {
    const original = createBaseline(aggregateGc([
        mk('gc', { gc: { major: 8, minor: 20, maxMs: 10 } }),
        mk('gc', { gc: { major: 8, minor: 20, maxMs: 10 } }),
        mk('gc', { gc: { major: 8, minor: 20, maxMs: 10 } })
    ]));
    const better = aggregateGc([
        mk('gc', { gc: { major: 3, minor: 5, maxMs: 10 } }),   // major & minor better, maxMs equal
        mk('gc', { gc: { major: 3, minor: 5, maxMs: 10 } }),
        mk('gc', { gc: { major: 3, minor: 5, maxMs: 10 } })
    ]);
    const r = ratchetBaseline(original, better);
    assert.ok(r.changed.includes('gc.major'));
    assert.ok(r.changed.includes('gc.minor'));
    assert.ok(!r.changed.includes('gc.maxMs'), 'an equal metric does not appear in changed');
    assert.equal(r.baseline.gc.maxMs.max, 10, 'the equal metric is untouched');
});
