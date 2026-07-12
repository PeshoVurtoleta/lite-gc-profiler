// Standard-case tests for the phase subsystem introduced in v1.1.0 (G2).
// Adversarial cases (unclosed phases, boundary races, capacity exhaustion in
// adversarial patterns) live in test/torture/g3-5-verdicts.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    GcProfiler, checkNoGc, assertNoGc,
    GcBudgetError, GcInconclusiveError,
    GC_MAJOR, GC_MINOR
} from '../Gc.js';

// ---- phase() basics ----

test('phase() records a boundary and appears in summary.phases', () => {
    const gc = new GcProfiler();
    gc.phase('warmup');
    const s = gc.summary();
    assert.ok(s.phases.warmup, 'warmup phase should exist in summary');
    assert.equal(s.phases.warmup.gc.count, 0);
});

test('phase() with same name twice is a no-op (idempotent)', () => {
    const gc = new GcProfiler();
    gc.phase('warmup');
    gc.phase('warmup');
    gc.phase('warmup');
    // Only one boundary was recorded; state consistent.
    const s = gc.summary();
    assert.ok(s.phases.warmup);
    assert.equal(Object.keys(s.phases).length, 1);
});

test('sequential phases both appear in summary', () => {
    const gc = new GcProfiler();
    gc.phase('warmup');
    gc.phase('steady');
    const s = gc.summary();
    assert.ok(s.phases.warmup);
    assert.ok(s.phases.steady);
});

test('no phase() calls -> summary.phases is empty object', () => {
    const gc = new GcProfiler();
    const s = gc.summary();
    assert.deepEqual(s.phases, {});
});

test('phase() rejects empty and non-string names', () => {
    const gc = new GcProfiler();
    assert.throws(() => gc.phase(''), TypeError);
    assert.throws(() => gc.phase(null), TypeError);
    assert.throws(() => gc.phase(undefined), TypeError);
    assert.throws(() => gc.phase(123), TypeError);
});

test('phase() throws RangeError past max phases (32)', () => {
    const gc = new GcProfiler();
    for (let i = 0; i < 32; i++) gc.phase('phase' + i);
    assert.throws(() => gc.phase('phase32'), RangeError);
});

// ---- bucketing by startTime ----

test('injected events bucket into the phase active at their startTime', () => {
    const gc = new GcProfiler();
    // Simulate: phase warmup starts at t=0, phase steady starts at t=100.
    // We fake the boundaries by calling phase() at wall time, then injecting
    // events with explicit startTimes that fall on either side.
    gc.phase('warmup');
    const warmupStart = performance.now();
    // event at warmupStart + 10 -- squarely in warmup
    gc.record(GC_MAJOR, 5, warmupStart + 10);
    gc.phase('steady');
    const steadyStart = performance.now();
    // event at steadyStart + 10 -- squarely in steady
    gc.record(GC_MAJOR, 5, steadyStart + 10);

    const s = gc.summary();
    assert.equal(s.phases.warmup.gc.major, 1, 'warmup should have 1 major');
    assert.equal(s.phases.steady.gc.major, 1, 'steady should have 1 major');
    assert.equal(s.gc.major, 2, 'global should still count both');
});

test("event with startTime before first boundary is global-only (no phase)", () => {
    const gc = new GcProfiler();
    // Record an event now, then declare a phase. The event's startTime is
    // before the phase boundary and should NOT be attributed to the phase.
    gc.record(GC_MAJOR, 5, performance.now());
    gc.phase('steady');
    const s = gc.summary();
    assert.equal(s.gc.major, 1);
    assert.equal(s.phases.steady.gc.major, 0);
});

test('late-arriving event (startTime before phase change) buckets correctly', async () => {
    // This is the correctness case the async PerformanceObserver forces us into:
    // an event's startTime may be BEFORE the current wall clock, so bucketing
    // by "current phase at record time" would be wrong. We use startTime.
    // We need a real gap between the two boundaries to have room for a startTime
    // that falls strictly between them, hence the sleep.
    const gc = new GcProfiler();
    gc.phase('warmup');
    const midWarmup = performance.now() + 5;                   // 5ms into warmup
    await new Promise((r) => setTimeout(r, 20));               // ensure boundary gap > 5ms
    gc.phase('steady');
    // Inject event whose startTime is back in the warmup window (5ms after warmup start).
    gc.record(GC_MAJOR, 5, midWarmup);
    const s = gc.summary();
    assert.equal(s.phases.warmup.gc.major, 1, 'late-arriving event attributes by startTime, not wall clock');
    assert.equal(s.phases.steady.gc.major, 0);
});

// ---- phase rules in the gate ----

test('phase rule: steady must be clean while warmup can be dirty', () => {
    const gc = new GcProfiler();
    gc.phase('warmup');
    const warmupStart = performance.now();
    gc.record(GC_MAJOR, 5, warmupStart + 1);          // warmup allowed 1 major
    gc.record(GC_MAJOR, 5, warmupStart + 2);          // and a second
    gc.phase('steady');
    // steady is clean (no injections)
    const rep = checkNoGc(gc.summary(), {
        phases: {
            warmup: { maxMajor: 2 },
            steady: { maxMajor: 0 }
        }
    });
    assert.equal(rep.verdict, 'pass');
    assert.deepEqual(rep.checkedByPhase, {
        warmup: { maxMajor: true },
        steady: { maxMajor: true }
    });
});

test('phase rule: steady violation fails the gate', () => {
    const gc = new GcProfiler();
    gc.phase('warmup');
    gc.phase('steady');
    gc.record(GC_MAJOR, 5, performance.now() + 1);    // in steady
    const rep = checkNoGc(gc.summary(), {
        phases: { steady: { maxMajor: 0 } }
    });
    assert.equal(rep.verdict, 'fail');
    assert.ok(rep.violations.some((v) => v.metric === 'phases.steady.gc.major'));
});

test('phase rule for undeclared phase -> inconclusive', () => {
    const gc = new GcProfiler();
    gc.phase('warmup');
    // Note: 'steady' was never declared.
    const rep = checkNoGc(gc.summary(), {
        phases: { steady: { maxMajor: 0 } }
    });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checkedByPhase.steady.maxMajor, false);
});

test('phase rule for a phase with no events still verifiable -> pass', () => {
    const gc = new GcProfiler();
    gc.phase('warmup');
    gc.phase('steady');
    // No events anywhere.
    const rep = checkNoGc(gc.summary(), {
        phases: { warmup: { maxMajor: 0 }, steady: { maxMajor: 0 } }
    });
    assert.equal(rep.verdict, 'pass');
});

test('global + phase rules combined -- both evaluate', () => {
    const gc = new GcProfiler();
    gc.phase('steady');
    gc.record(GC_MAJOR, 5, performance.now() + 1);
    const rep = checkNoGc(gc.summary(), {
        maxMajor: 0,                                     // global
        phases: { steady: { maxMajor: 0 } }              // per-phase
    });
    assert.equal(rep.verdict, 'fail');
    // Both should have fired, so two violations
    assert.equal(rep.violations.length, 2);
});

test('per-phase maxAllocRate is inconclusive (heap is global-only in G2)', () => {
    const gc = new GcProfiler();
    gc.phase('steady');
    const rep = checkNoGc(gc.summary(), {
        phases: { steady: { maxAllocRate: 1000 } }
    });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checkedByPhase.steady.maxAllocRate, false);
});

// ---- assertNoGc with phases ----

test('assertNoGc throws GcBudgetError on phase-rule fail', () => {
    const gc = new GcProfiler();
    gc.phase('steady');
    gc.record(GC_MAJOR, 5, performance.now() + 1);
    assert.throws(
        () => assertNoGc(gc.summary(), { phases: { steady: { maxMajor: 0 } } }),
        GcBudgetError
    );
});

test('assertNoGc throws GcInconclusiveError naming phase.rule for undeclared phases', () => {
    const gc = new GcProfiler();
    gc.phase('warmup');
    try {
        assertNoGc(gc.summary(), { phases: { steady: { maxMajor: 0 } } });
        assert.fail('should have thrown');
    } catch (e) {
        assert.ok(e instanceof GcInconclusiveError);
        assert.match(e.message, /steady\.maxMajor/);
    }
});

// ---- reset ----

test('reset clears phase intern table and per-phase counters', () => {
    const gc = new GcProfiler();
    gc.phase('warmup');
    gc.record(GC_MAJOR, 5, performance.now() + 1);
    gc.reset();
    const s = gc.summary();
    assert.deepEqual(s.phases, {});
    assert.equal(s.gc.major, 0);
});

test('reset then reuse phase name gets a fresh phase', () => {
    const gc = new GcProfiler();
    gc.phase('steady');
    gc.record(GC_MAJOR, 5, performance.now() + 1);
    gc.reset();
    gc.phase('steady');
    // No events in the new steady phase.
    const s = gc.summary();
    assert.equal(s.phases.steady.gc.major, 0);
});

// ---- back-compat ----

test('back-compat: profiler without any phase() call still works', () => {
    const gc = new GcProfiler();
    gc.record(GC_MAJOR, 5);
    const rep = checkNoGc(gc.summary(), { maxMajor: 0 });
    assert.equal(rep.verdict, 'fail');
    assert.deepEqual(rep.checkedByPhase, {});
});

test('back-compat: rules without phases block work identically to G1', () => {
    const gc = new GcProfiler();
    const rep = checkNoGc(gc.summary(), { maxMajor: 0 });
    assert.equal(rep.verdict, 'pass');
    assert.deepEqual(rep.checkedByPhase, {});
});

// ---- live: real profiler with phases ----

test('live: pooled loop split into warmup+steady, both pass', async () => {
    const gc = new GcProfiler().start();
    const buf = new Float64Array(1024);

    gc.phase('warmup');
    for (let i = 0; i < 50000; i++) buf[i & 1023] = i * 0.5;
    await new Promise((r) => setTimeout(r, 30));

    gc.phase('steady');
    for (let i = 0; i < 100000; i++) buf[i & 1023] = i * 0.7;
    await new Promise((r) => setTimeout(r, 50));

    const rep = assertNoGc(gc.summary(), {
        phases: {
            warmup: { maxMajor: 0 },
            steady: { maxMajor: 0 }
        }
    });
    assert.equal(rep.verdict, 'pass');
    gc.stop();
});
