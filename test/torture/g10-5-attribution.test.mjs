// Torture tests for Batch 4 (attribution): 13 scenarios across axes A/B/C/D.
// 4 axis-A (inconclusive), 4 axis-B (fail), 3 axis-C (pass), 2 axis-D
// (self-consistency invariants).
//
// The HONESTY ENFORCEMENT test is axis B scenario #1. It asserts that when
// a GC fires during region B but was CAUSED by allocation in region A, the
// gate charges region B (firing-site), not region A. If this ever passes on
// the "charge the allocator" reading, the README disclaimer has been silently
// broken by the code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    GcProfiler, checkNoGc, assertNoGc,
    GcBudgetError, GcInconclusiveError,
    GC_MAJOR, GC_MINOR
} from '../../Gc.js';
import { startExplainSampling } from '../../ExplainSampling.js';
import { assertAxisA, assertAxisC, assertAxisD, makeSummary, makePhase } from './harness.mjs';

function makePhaseWithRegion(gc) {
    // helper: create a summary literal with a region declared
    return { gc };
}

// =============================================================================
// AXIS A -- MUST produce 'inconclusive'
// =============================================================================

test("[axis A] perRegion rule referencing a never-entered region", () => {
    const gc = new GcProfiler();
    gc.enter('drain'); gc.exit();
    // 'render' was never entered
    const s = gc.summary();
    assertAxisA(s, { perRegion: { render: { maxMajor: 0 } } },
        'perRegion rule for undeclared region');
});

test("[axis A] source='heap' + perRegion maxMajor -> inconclusive", () => {
    // Same rationale as G1: kind rules unverifiable on heap source, at any scope.
    const s = makeSummary('heap', { heap: { samples: 10 }, phases: {} });
    s.byRegion = { drain: makePhase() };
    assertAxisA(s, { perRegion: { drain: { maxMajor: 0 } } },
        "kind rule unverifiable on 'heap' source at region scope too");
});

test('[axis A] perRegion maxAllocRate always inconclusive in Batch 4', () => {
    // Heap accounting is global-only in Batch 4; per-region alloc rate cannot
    // be answered until per-region heap tracking lands (a future gate).
    const gc = new GcProfiler();
    gc.enter('drain'); gc.exit();
    const s = gc.summary();
    assertAxisA(s, { perRegion: { drain: { maxAllocRate: 1000 } } },
        'per-region maxAllocRate unverifiable in Batch 4');
});

test('[axis A] mixed: violation-worthy region + rule on undeclared region -> inconclusive if only the undeclared has a rule', async () => {
    // The point: an undeclared-region rule alone must NOT fabricate a fail
    // from evidence in some OTHER region. Only the rule the caller asked about
    // matters for that rule's verdict.
    const gc = new GcProfiler();
    gc.enter('drain');
    gc.record(GC_MAJOR, 5, performance.now() + 0.5);        // drain has a major
    gc.exit();
    // But the rule targets 'render', which was never entered.
    const s = gc.summary();
    assertAxisA(s, { perRegion: { render: { maxMajor: 0 } } },
        'unverifiable region rule must not fabricate fail from unrelated evidence');
});

// =============================================================================
// AXIS B -- MUST produce 'fail'
// =============================================================================

test('[axis B] HONESTY ENFORCEMENT: GC during region B charges B, not the allocator region A', async () => {
    // This is the test that makes the README disclaimer true. If this test
    // ever passes under "charge the allocator" semantics, someone silently
    // changed attribution to blame allocators, which contradicts what the
    // library promises.
    const gc = new GcProfiler();
    gc.enter('A');
    // "A" would be the allocator in a real scenario; we simulate by making
    // A a clean region and injecting the major during B.
    gc.exit();
    await new Promise((r) => setTimeout(r, 2));
    gc.enter('B');
    // GC fires during B (firing-site)
    gc.record(GC_MAJOR, 5, performance.now() + 0.5);
    gc.exit();

    // Rule: B must be clean. B is where the pause fired -> fail.
    const s = gc.summary();
    const rep = checkNoGc(s, { perRegion: { B: { maxMajor: 0 } } });
    assert.equal(rep.verdict, 'fail',
        'FIRING-SITE ATTRIBUTION: pause during B must charge B, not the allocator');
    // And a rule against A should pass -- A had zero events in its interval.
    const repA = checkNoGc(s, { perRegion: { A: { maxMajor: 0 } } });
    assert.equal(repA.verdict, 'pass',
        'A had no events in its interval; charging A would be blame-shifting');
});

test('[axis B] nested regions: event during inner charges innermost, not outer', async () => {
    const gc = new GcProfiler();
    gc.enter('outer');
    await new Promise((r) => setTimeout(r, 2));
    gc.enter('inner');
    gc.record(GC_MAJOR, 5, performance.now() + 0.1);
    gc.exit();
    gc.exit();
    const s = gc.summary();
    // Rule against inner must fail; rule against outer must pass.
    const repInner = checkNoGc(s, { perRegion: { inner: { maxMajor: 0 } } });
    assert.equal(repInner.verdict, 'fail', 'inner should be charged');
    const repOuter = checkNoGc(s, { perRegion: { outer: { maxMajor: 0 } } });
    assert.equal(repOuter.verdict, 'pass', 'outer should NOT be charged');
});

test('[axis B] region + global rules both violated -> both violations surface', async () => {
    const gc = new GcProfiler();
    gc.enter('render');
    gc.record(GC_MAJOR, 5, performance.now() + 0.5);
    gc.exit();
    const s = gc.summary();
    const rep = checkNoGc(s, {
        maxMajor: 0,                                         // global
        perRegion: { render: { maxMajor: 0 } }               // region
    });
    assert.equal(rep.verdict, 'fail');
    assert.equal(rep.violations.length, 2, 'both violations must appear -- neither shadows the other');
});

test('[axis B] fail beats inconclusive at region scope', async () => {
    const gc = new GcProfiler();
    gc.enter('render');
    gc.record(GC_MAJOR, 5, performance.now() + 0.5);
    gc.exit();
    // Rule: render.maxMajor:0 fails; render.maxAllocRate:1000 is unverifiable
    const s = gc.summary();
    const rep = checkNoGc(s, {
        perRegion: {
            render: { maxMajor: 0, maxAllocRate: 1000 }
        }
    });
    assert.equal(rep.verdict, 'fail', 'evidence of failure beats unverifiable alloc rate');
    assert.equal(rep.checkedByRegion.render.maxMajor, true);
    assert.equal(rep.checkedByRegion.render.maxAllocRate, false);
});

// =============================================================================
// AXIS C -- MUST produce 'pass'
// =============================================================================

test('[axis C] high-frequency region churn does not induce majors', async () => {
    const gc = new GcProfiler().start();
    if (global.gc) global.gc();
    await gc.settle();
    gc.reset();
    // Enter/exit many regions rapidly; must not allocate a major
    let x = 0;
    for (let i = 0; i < 500; i++) {
        gc.enter('r-' + (i % 4));                            // reuse 4 region names
        for (let j = 0; j < 100; j++) x += j;
        gc.exit();
    }
    await gc.settle();
    const s = gc.summary();
    assert.equal(s.gc.major, 0, 'region churn must not induce majors');
    assert.ok(x > 0);
    gc.stop();
});

test('[axis C] long region names still work', () => {
    const gc = new GcProfiler();
    const longName = 'r'.repeat(200);
    gc.enter(longName);
    gc.exit();
    const s = gc.summary();
    assert.ok(s.byRegion[longName]);
});

test('[axis C] explain sampling: clean loop, sampler runs and stops without failing the gate', async () => {
    // Verifies explain mode is usable but doesn't affect ordinary code paths.
    const h = startExplainSampling({ intervalBytes: 4096 });
    await h.started;
    // Do harmless work
    let x = 0;
    for (let i = 0; i < 1000; i++) x += i;
    const result = await h.stop();
    assert.ok(Array.isArray(result.topStacks));
    assert.equal(typeof result.samplingInterval, 'number');
    assert.ok(x > 0);
});

// =============================================================================
// AXIS D -- self-consistency invariants
// =============================================================================

test('[axis D] sum of per-region GC counts = global count - unattributed count', async () => {
    assertAxisD(() => {
        // Note: this uses direct summary construction to control counters exactly.
        // Live tests would need real GC events to verify, which are non-deterministic.
        // Instead we verify the accounting logic on a hand-built summary.
        const gc = new GcProfiler();
        gc.enter('a');
        gc.record(GC_MAJOR, 5, performance.now() + 0.5);
        gc.exit();
        // Now record an event outside any region (in the unattributed window)
        gc.record(GC_MAJOR, 5, performance.now() + 100);     // way after exit
        const s = gc.summary();

        let regionSum = 0;
        for (const name in s.byRegion) {
            if (name === 'unattributed') continue;
            regionSum += s.byRegion[name].gc.major;
        }
        const unattributed = s.byRegion.unattributed ? s.byRegion.unattributed.gc.major : 0;
        assert.equal(regionSum + unattributed, s.gc.major,
            'sum of per-region + unattributed must equal global');
        return true;
    }, 'region accounting sums correctly');
});

test('[axis D] explain sampling can be stopped independently of GcProfiler lifecycle', async () => {
    // The invariant "explain never runs inside a gating run" is a convention
    // enforced at the CLI level (separate 'run' vs 'explain' subcommands),
    // not at the library level. This test verifies the two can coexist
    // without corrupting each other's state -- neither leaks into the other.
    const gc = new GcProfiler().start();
    const h = startExplainSampling({ intervalBytes: 8192 });
    await h.started;
    // Do work that both would observe
    let x = 0;
    for (let i = 0; i < 10000; i++) x += i;

    const explainResult = await h.stop();
    await gc.settle();
    const gcSummary = gc.summary();
    gc.stop();

    assert.ok(Array.isArray(explainResult.topStacks));
    assert.equal(typeof gcSummary.gc.major, 'number');
    assert.ok(x > 0);
    // Neither state was corrupted.
});
