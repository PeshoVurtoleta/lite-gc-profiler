// G28.6 -- Torture for the ratchet baseline (v1.12.0). A ratchet that tightens
// on bad evidence is worse than no ratchet: it would enshrine a phantom floor
// nobody can ever meet, or silently erase a real one. Axes:
//
//   A -- MUST NOT tighten on unusable input (never ratchet toward a hole).
//   B -- real improvement that MUST tighten, and MUST hold against give-back.
//   C -- clean tighten under hostile shapes that MUST still work.
//   D -- self-consistency: monotonic, idempotent, non-mutating, never loosens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    aggregateGc, createBaseline, checkAgainstBaseline, ratchetBaseline
} from '../../Gc.js';

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

// =============================================================================
// AXIS A -- MUST NOT tighten on unusable input
// =============================================================================

test('[A] an invalid-schema baseline is returned unchanged, not tightened', () => {
    const bad = { schema: 'not-a-baseline', gc: {} };
    const r = ratchetBaseline(bad, agg(1));
    assert.equal(r.ratcheted, false);
    assert.equal(r.reason, 'invalid_baseline');
    assert.equal(r.baseline, bad, 'the (bad) input is returned as-is');
});

test('[A] a null baseline does not throw and does not ratchet', () => {
    const r = ratchetBaseline(null, agg(1));
    assert.equal(r.ratcheted, false);
    assert.equal(r.reason, 'invalid_baseline');
});

test('[A] a non-aggregate current throws rather than silently no-op', () => {
    // A caller who passes the wrong thing must find out, not get a false "held".
    assert.throws(() => ratchetBaseline(base(8), {}), TypeError);
    assert.throws(() => ratchetBaseline(base(8), null), TypeError);
    assert.throws(() => ratchetBaseline(base(8), { reps: 'three' }), TypeError);
});

test('[A] a NaN current metric cannot tighten (never min against NaN)', () => {
    const original = base(8);
    const cur = agg(3);
    cur.gc.major = { min: NaN, median: NaN, max: NaN };
    const r = ratchetBaseline(original, cur);
    assert.equal(r.baseline.gc.major.max, 8);
    assert.ok(!r.changed.includes('gc.major'));
});

test('[A] an Infinity current metric cannot tighten', () => {
    const original = base(8);
    const cur = agg(3);
    cur.gc.major = { min: Infinity, median: Infinity, max: Infinity };
    const r = ratchetBaseline(original, cur);
    assert.equal(r.baseline.gc.major.max, 8);
});

test('[A] a partial current stat tightens only its finite fields', () => {
    // finite median (better), NaN max (unusable): median ratchets, max holds.
    const original = base(8);
    const cur = agg(3);
    cur.gc.major = { min: 3, median: 3, max: NaN };
    const r = ratchetBaseline(original, cur);
    assert.equal(r.baseline.gc.major.median, 3, 'finite better field tightens');
    assert.equal(r.baseline.gc.major.max, 8, 'NaN field holds the old value');
});

test('[A] a fingerprint mismatch refuses to ratchet by default', () => {
    const original = base(8);
    // Poison the fingerprint so it cannot match the current host.
    original.fingerprint = { node: 'v0.0.0', v8: 'x', platform: 'p', arch: 'a', cpu: 'c' };
    const r = ratchetBaseline(original, agg(3));
    assert.equal(r.ratcheted, false);
    assert.equal(r.reason, 'fingerprint_mismatch');
    assert.equal(r.baseline.gc.major.max, 8, 'floor untouched across a host boundary');
});

test('[A] fingerprint override ratchets but stamps the audit trail', () => {
    const original = base(8);
    original.fingerprint = { node: 'v0.0.0', v8: 'x', platform: 'p', arch: 'a', cpu: 'c' };
    const r = ratchetBaseline(original, agg(3), { acceptFingerprintMismatch: true });
    assert.equal(r.ratcheted, true);
    assert.equal(r.fingerprintMismatchAccepted, true, 'override is recorded, not silent');
});

// =============================================================================
// AXIS B -- real improvement that MUST tighten and hold
// =============================================================================

test('[B] the give-back scenario: improve then regress, ratchet catches it', () => {
    const original = base(8);
    const tight = ratchetBaseline(original, agg(3)).baseline;
    // A static baseline at 8 would pass a regression to 7; the ratchet fails it.
    assert.equal(checkAgainstBaseline(agg(7), original).verdict, 'pass');
    assert.equal(checkAgainstBaseline(agg(7), tight).verdict, 'fail');
});

test('[B] a long chain of improvements ratchets monotonically down', () => {
    let b = base(20);
    for (const m of [15, 15, 9, 12, 4, 4, 1]) {   // includes non-improvements
        b = ratchetBaseline(b, agg(m)).baseline;
    }
    assert.equal(b.gc.major.max, 1, 'the floor tracks the best ever seen, ignoring worse runs between');
});

test('[B] one metric improving while another regresses tightens only the winner', () => {
    const original = createBaseline(aggregateGc([
        mk('gc', { gc: { major: 8, minor: 20 } }),
        mk('gc', { gc: { major: 8, minor: 20 } }),
        mk('gc', { gc: { major: 8, minor: 20 } })
    ]));
    const mixed = aggregateGc([
        mk('gc', { gc: { major: 3, minor: 40 } }),   // major better, minor worse
        mk('gc', { gc: { major: 3, minor: 40 } }),
        mk('gc', { gc: { major: 3, minor: 40 } })
    ]);
    const r = ratchetBaseline(original, mixed);
    assert.equal(r.baseline.gc.major.max, 3, 'the improved metric tightens');
    assert.equal(r.baseline.gc.minor.max, 20, 'the regressed metric holds, never loosens to 40');
});

// =============================================================================
// AXIS C -- clean tighten under hostile shapes
// =============================================================================

test('[C] a baseline with empty metric maps ratchets nothing and does not throw', () => {
    const original = base(8);
    original.gc = {};
    original.heap = {};
    original.uasm = {};
    const r = ratchetBaseline(original, agg(3));
    assert.equal(r.ratcheted, false, 'nothing in the baseline to tighten');
    assert.deepEqual(r.changed, []);
});

test('[C] a baseline missing uasm entirely is handled', () => {
    const original = base(8);
    delete original.uasm;
    assert.doesNotThrow(() => ratchetBaseline(original, agg(3)));
});

test('[C] a current with extra metrics the baseline lacks does not add them', () => {
    // Ratchet only tightens metrics the baseline already tracks; it never
    // grows the baseline's surface from the current run.
    const original = base(8);
    const cur = agg(3);
    cur.gc.somethingNew = { min: 1, median: 1, max: 1 };
    const r = ratchetBaseline(original, cur);
    assert.ok(!('somethingNew' in r.baseline.gc), 'baseline surface is not grown by a ratchet');
});

// =============================================================================
// AXIS D -- self-consistency
// =============================================================================

test('[D] ratchet never loosens: for any pair, result <= old on every metric', () => {
    for (const [oldM, curM] of [[8, 3], [3, 8], [5, 5], [1, 100], [100, 1]]) {
        const r = ratchetBaseline(base(oldM), agg(curM));
        assert.ok(r.baseline.gc.major.max <= oldM,
            'old=' + oldM + ' cur=' + curM + ' -> max ' + r.baseline.gc.major.max + ' must be <= ' + oldM);
    }
});

test('[D] idempotent: ratchet(ratchet(b, c), c) == ratchet(b, c)', () => {
    const once = ratchetBaseline(base(8), agg(3));
    const twice = ratchetBaseline(once.baseline, agg(3));
    assert.equal(twice.ratcheted, false);
    assert.deepEqual(twice.baseline.gc.major, once.baseline.gc.major);
});

test('[D] a no-op ratchet returns the same object reference, unmutated', () => {
    const original = base(3);
    const snapshot = JSON.stringify(original);
    const r = ratchetBaseline(original, agg(8));   // worse
    assert.equal(r.baseline, original);
    assert.equal(JSON.stringify(original), snapshot, 'the input was not mutated');
});

test('[D] a real ratchet does NOT mutate the input baseline', () => {
    const original = base(8);
    const snapshot = JSON.stringify(original);
    const r = ratchetBaseline(original, agg(3));
    assert.notEqual(r.baseline, original, 'a new object is returned');
    assert.equal(JSON.stringify(original), snapshot, 'the original is untouched');
    assert.equal(original.gc.major.max, 8, 'original floor still 8');
});

test('[D] changed lists exactly the metrics whose values moved', () => {
    const original = createBaseline(aggregateGc([
        mk('gc', { gc: { major: 8, minor: 20, maxMs: 10 } }),
        mk('gc', { gc: { major: 8, minor: 20, maxMs: 10 } }),
        mk('gc', { gc: { major: 8, minor: 20, maxMs: 10 } })
    ]));
    const better = aggregateGc([
        mk('gc', { gc: { major: 3, minor: 20, maxMs: 4 } }),   // major & maxMs move, minor equal
        mk('gc', { gc: { major: 3, minor: 20, maxMs: 4 } }),
        mk('gc', { gc: { major: 3, minor: 20, maxMs: 4 } })
    ]);
    const r = ratchetBaseline(original, better);
    const moved = r.changed.sort();
    assert.ok(moved.includes('gc.major'));
    assert.ok(moved.includes('gc.maxMs'));
    assert.ok(!moved.includes('gc.minor'), 'an unmoved metric is not listed');
});
