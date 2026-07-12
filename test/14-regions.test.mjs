// Standard-case tests for region attribution introduced in Batch 4 (G10).
// Adversarial cases (unclosed regions, boundary races, nested attribution
// correctness) live in test/torture/g10-5-attribution.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    GcProfiler, checkNoGc, assertNoGc,
    GcBudgetError, GcInconclusiveError,
    GC_MAJOR, GC_MINOR
} from '../Gc.js';

// ---- enter/exit basics ----

test('enter() creates a region in summary.byRegion', () => {
    const gc = new GcProfiler();
    gc.enter('drain');
    gc.exit();
    const s = gc.summary();
    assert.ok(s.byRegion.drain, 'drain region should exist');
    assert.equal(s.byRegion.drain.gc.count, 0);
});

test('no enter() -> summary.byRegion is empty object', () => {
    const gc = new GcProfiler();
    assert.deepEqual(gc.summary().byRegion, {});
});

test('enter() with invalid name throws', () => {
    const gc = new GcProfiler();
    assert.throws(() => gc.enter(''), TypeError);
    assert.throws(() => gc.enter(null), TypeError);
    assert.throws(() => gc.enter(undefined), TypeError);
    assert.throws(() => gc.enter(123), TypeError);
});

test('exit() with no open region throws', () => {
    const gc = new GcProfiler();
    assert.throws(() => gc.exit(), RangeError);
});

test('enter/exit LIFO pairing works', () => {
    const gc = new GcProfiler();
    gc.enter('a');
    gc.enter('b');
    gc.exit();                                              // exits b
    gc.exit();                                              // exits a
    // No throw = success
    assert.equal(gc.summary().byRegion.a.gc.count, 0);
    assert.equal(gc.summary().byRegion.b.gc.count, 0);
});

test('capacity limits: MAX_REGIONS = 32', () => {
    const gc = new GcProfiler();
    for (let i = 0; i < 32; i++) { gc.enter('r' + i); gc.exit(); }
    assert.throws(() => gc.enter('r32'), RangeError);
});

test('capacity limits: MAX_REGION_STACK_DEPTH = 16', () => {
    const gc = new GcProfiler();
    for (let i = 0; i < 16; i++) gc.enter('r' + i);
    assert.throws(() => gc.enter('r16'), RangeError);
    // Clean up so the test doesn't leak an open profiler
    for (let i = 0; i < 16; i++) gc.exit();
});

// ---- attribution by startTime ----

test('event during a single region attributes to that region', () => {
    const gc = new GcProfiler();
    gc.enter('drain');
    const t = performance.now();
    gc.record(GC_MAJOR, 5, t + 0.5);
    gc.exit();
    const s = gc.summary();
    assert.equal(s.byRegion.drain.gc.major, 1);
    assert.equal(s.gc.major, 1);                            // global also counts
});

test('event outside all regions goes to unattributed bucket', async () => {
    // Semantic: unattributed tracks events that fell OUTSIDE any open interval
    // while region tracking was in play. Once enter() has been called, gaps
    // between regions (or after all regions closed) accumulate in unattributed.
    const gc = new GcProfiler();
    gc.enter('drain');
    gc.exit();
    await new Promise((r) => setTimeout(r, 5));
    // Now record an event AFTER drain closed -- it falls outside any interval.
    gc.record(GC_MAJOR, 5, performance.now());
    const s = gc.summary();
    assert.ok(s.byRegion.unattributed, 'should have unattributed bucket');
    assert.equal(s.byRegion.unattributed.gc.major, 1);
    assert.equal(s.byRegion.drain.gc.major, 0);
});

test('unattributed bucket omitted when no unattributed events', () => {
    const gc = new GcProfiler();
    gc.enter('drain');
    gc.record(GC_MAJOR, 5, performance.now() + 0.5);
    gc.exit();
    const s = gc.summary();
    assert.equal(s.byRegion.unattributed, undefined);
});

// ---- nested regions ----

test('nested regions: event during inner charges innermost', async () => {
    const gc = new GcProfiler();
    gc.enter('outer');
    await new Promise((r) => setTimeout(r, 5));             // gap so timestamps differ
    gc.enter('inner');
    gc.record(GC_MAJOR, 5, performance.now() + 0.1);
    gc.exit();
    gc.exit();
    const s = gc.summary();
    assert.equal(s.byRegion.inner.gc.major, 1, 'inner should get the event');
    assert.equal(s.byRegion.outer.gc.major, 0, 'outer should NOT get the event');
});

test('nested regions: event in outer-only phase charges outer', async () => {
    const gc = new GcProfiler();
    gc.enter('outer');
    const inOuterTime = performance.now() + 0.5;
    await new Promise((r) => setTimeout(r, 10));
    gc.enter('inner');
    // Inject an event whose startTime was during outer-only (before inner entered)
    gc.record(GC_MAJOR, 5, inOuterTime);
    gc.exit();
    gc.exit();
    const s = gc.summary();
    assert.equal(s.byRegion.outer.gc.major, 1);
    assert.equal(s.byRegion.inner.gc.major, 0);
});

// ---- per-region rules ----

test('per-region rule: clean region passes', () => {
    const gc = new GcProfiler();
    gc.enter('drain');
    gc.exit();
    const rep = checkNoGc(gc.summary(), { perRegion: { drain: { maxMajor: 0 } } });
    assert.equal(rep.verdict, 'pass');
    assert.equal(rep.checkedByRegion.drain.maxMajor, true);
});

test('per-region rule: dirty region fails', () => {
    const gc = new GcProfiler();
    gc.enter('drain');
    gc.record(GC_MAJOR, 5, performance.now() + 0.5);
    gc.exit();
    const rep = checkNoGc(gc.summary(), { perRegion: { drain: { maxMajor: 0 } } });
    assert.equal(rep.verdict, 'fail');
    assert.ok(rep.violations.some((v) => v.metric.startsWith('phases.byRegion.drain.gc')));
});

test('per-region rule for undeclared region -> inconclusive', () => {
    const gc = new GcProfiler();
    // Only 'drain' is declared
    gc.enter('drain');
    gc.exit();
    const rep = checkNoGc(gc.summary(), { perRegion: { render: { maxMajor: 0 } } });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checkedByRegion.render.maxMajor, false);
});

test('per-region maxAllocRate is inconclusive (heap is global-only)', () => {
    const gc = new GcProfiler();
    gc.enter('drain');
    gc.exit();
    const rep = checkNoGc(gc.summary(), { perRegion: { drain: { maxAllocRate: 1000 } } });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checkedByRegion.drain.maxAllocRate, false);
});

test('global + phase + region rules combined -- all evaluate', () => {
    const gc = new GcProfiler();
    gc.phase('steady');
    gc.enter('render');
    gc.record(GC_MAJOR, 5, performance.now() + 0.5);
    gc.exit();
    const rep = checkNoGc(gc.summary(), {
        maxMajor: 0,                                         // global
        phases: { steady: { maxMajor: 0 } },                 // phase
        perRegion: { render: { maxMajor: 0 } }               // region
    });
    assert.equal(rep.verdict, 'fail');
    // Three violations expected: global, phase, region
    assert.equal(rep.violations.length, 3);
});

// ---- assertNoGc integration ----

test('assertNoGc throws GcBudgetError on region violation', () => {
    const gc = new GcProfiler();
    gc.enter('render');
    gc.record(GC_MAJOR, 5, performance.now() + 0.5);
    gc.exit();
    assert.throws(
        () => assertNoGc(gc.summary(), { perRegion: { render: { maxMajor: 0 } } }),
        GcBudgetError
    );
});

test('GcInconclusiveError names undeclared-region rules as byRegion.name.rule', () => {
    const gc = new GcProfiler();
    try {
        assertNoGc(gc.summary(), { perRegion: { render: { maxMajor: 0 } } });
        assert.fail('should have thrown');
    } catch (e) {
        assert.ok(e instanceof GcInconclusiveError);
        assert.match(e.message, /byRegion\.render\.maxMajor/);
    }
});

// ---- reset ----

test('reset clears region intern table and counters', () => {
    const gc = new GcProfiler();
    gc.enter('drain');
    gc.record(GC_MAJOR, 5, performance.now() + 0.5);
    gc.exit();
    gc.reset();
    const s = gc.summary();
    assert.deepEqual(s.byRegion, {});
});

// ---- back-compat ----

test('back-compat: profiler without enter/exit still works', () => {
    const gc = new GcProfiler();
    gc.record(GC_MAJOR, 5);
    const rep = checkNoGc(gc.summary(), { maxMajor: 0 });
    assert.equal(rep.verdict, 'fail');
    assert.deepEqual(rep.checkedByRegion, {});
});
