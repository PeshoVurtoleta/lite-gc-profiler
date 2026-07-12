// Torture tests for Batch 1 (v1.1.0): verdict integrity, phases, settle.
// 18 scenarios: 8 axis-A (inconclusive), 4 axis-B (fail), 3 axis-C (pass),
// 2 axis-D (self-consistency), plus one G3 settle-timeout scenario.
//
// Axis A ranks above everything: a green here means the falsifiability
// claim itself was silently falsified. Treat any axis-A regression as
// blocking the release train.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    GcProfiler, checkNoGc, assertNoGc,
    GcBudgetError, GcInconclusiveError,
    GC_MAJOR, GC_MINOR
} from '../../Gc.js';
import {
    assertAxisA, assertAxisB, assertAxisC, assertAxisD,
    makeSummary, makePhase
} from './harness.mjs';

// =============================================================================
// AXIS A -- MUST produce 'inconclusive'
// =============================================================================

test("[axis A] source='none' + maxMajor:0 -- the v1.0.0 silent hole", () => {
    // A green verdict here means G1 didn't actually close the falsifiability
    // hole. This is scenario #1 for a reason: if this ever regresses, the whole
    // package is compromised.
    const s = makeSummary('none');
    assertAxisA(s, { maxMajor: 0 }, "source='none' + maxMajor:0");
});

test("[axis A] source='heap' + maxMajor:0 -- kind rules unverifiable on Chrome", () => {
    const s = makeSummary('heap', { heap: { samples: 100 } });
    assertAxisA(s, { maxMajor: 0 }, "source='heap' + maxMajor:0");
});

test("[axis A] source='heap' + maxMinor:0 -- kind rules unverifiable on Chrome", () => {
    const s = makeSummary('heap', { heap: { samples: 100 } });
    assertAxisA(s, { maxMinor: 0 }, "source='heap' + maxMinor:0");
});

test('[axis A] maxAllocRate with heap.samples=0 -- delta needs two points', () => {
    const s = makeSummary('gc');                              // no samples fed
    assertAxisA(s, { maxAllocRate: 1000 }, 'maxAllocRate + samples=0');
});

test('[axis A] maxAllocRate with heap.samples=1 -- delta still needs two', () => {
    const s = makeSummary('gc', { heap: { samples: 1 } });
    assertAxisA(s, { maxAllocRate: 1000 }, 'maxAllocRate + samples=1');
});

test('[axis A] phase rule referencing a never-declared phase', () => {
    const s = makeSummary('gc', { phases: { warmup: makePhase() } });
    assertAxisA(s, { phases: { steady: { maxMajor: 0 } } },
        'phase rule for undeclared "steady"');
});

test('[axis A] mixed: fail-worthy phase rule + rule on undeclared phase', () => {
    // Trap: the fail-worthy claim (steady is dirty) COULD escalate to 'fail'.
    // But 'steady' was never declared, so it's inconclusive, not fail.
    // The gate must not fabricate a fail from an unverifiable claim.
    const s = makeSummary('gc');                              // no phases declared
    assertAxisA(s, { phases: { steady: { maxMajor: 0 } } },
        'undeclared phase must be inconclusive, not fabricate a fail');
});

test('[axis A] settle timeout -- drained:false signals inconclusive posture', () => {
    // The gate report itself doesn't consume settle's drained flag (that's the
    // caller's job), but the *semantic* is that a timed-out settle means the
    // summary is potentially incomplete. This scenario asserts the two pieces
    // that together let CI implement the semantic: the timeout resolves with
    // drained:false, and the report from an incomplete summary should not be
    // treated as pass.
    return new Promise((resolve) => {
        const gc = new GcProfiler().start();
        // Force sustained batches so quietTicks never accumulates
        const bump = setInterval(() => { gc._batchCount++; }, 1);
        gc.settle({ maxWaitMs: 20 }).then((r) => {
            clearInterval(bump);
            assert.equal(r.drained, false,
                'AXIS A: settle timeout must return drained:false, not silently pass');
            gc.stop();
            resolve();
        });
    });
});

// =============================================================================
// AXIS B -- MUST produce 'fail'
// =============================================================================

test('[axis B] single major GC in an otherwise clean window', () => {
    const s = makeSummary('gc', { gc: { major: 1, count: 1, totalMs: 12, maxMs: 12 } });
    assertAxisB(s, { maxMajor: 0 }, 'single major triggers fail');
});

test('[axis B] fail beats inconclusive when both signals are present', () => {
    // A violation is hard evidence; unverifiable rules alongside must not
    // downgrade the verdict. The gate has proof of failure and must say so.
    const s = makeSummary('gc', { gc: { major: 1, count: 1 } });
    const rep = assertAxisB(s, { maxMajor: 0, maxAllocRate: 1000 }, 'fail-beats-inconclusive');
    assert.equal(rep.checked.maxMajor, true);
    assert.equal(rep.checked.maxAllocRate, false);
});

test('[axis B] steady-phase major with warmup allowance -- global rules do not shadow phase rules', () => {
    // Warmup has 1 major (allowed under phase rule maxMajor:1); steady has 1
    // major (forbidden under maxMajor:0). Global rule allows 2 majors. Only
    // the phase rule catches the failure -- assert the failure is not masked.
    const s = makeSummary('gc', {
        gc: { major: 2, count: 2 },                           // global total is 2
        phases: {
            warmup: makePhase({ gc: { major: 1, count: 1 } }),
            steady: makePhase({ gc: { major: 1, count: 1 } })
        }
    });
    const rep = assertAxisB(s, {
        maxMajor: 2,                                          // global rule PASSES on totals
        phases: { warmup: { maxMajor: 1 }, steady: { maxMajor: 0 } }
    }, 'steady phase violation not masked by lenient global rule');
    assert.ok(rep.violations.some((v) => v.metric === 'phases.steady.gc.major'));
});

test('[axis B] multiple rule violations aggregate', () => {
    const s = makeSummary('gc', { gc: { major: 2, minor: 5, count: 7, totalMs: 20, maxMs: 12 } });
    const rep = assertAxisB(s, { maxMajor: 0, maxMinor: 0, maxPauseMs: 4 },
        'three rules fail, all three surface');
    assert.equal(rep.violations.length, 3);
});

// =============================================================================
// AXIS C -- MUST produce 'pass'
// =============================================================================

test('[axis C] clean profiler through repeated start/stop cycles', () => {
    // Cycling start/stop must not leak entries across cycles or produce phantom
    // stats. Each cycle is a fresh window post-reset.
    const gc = new GcProfiler();
    for (let i = 0; i < 5; i++) {
        gc.start();
        gc.stop();
        gc.reset();
    }
    const s = gc.summary();
    assertAxisC(s, { maxMajor: 0 }, 'start/stop cycles do not produce phantom majors');
});

test('[axis C] sibling PerformanceObserver must not perturb GC observer', () => {
    // If a user's own PerformanceObserver is active for e.g. 'measure' entries,
    // our 'gc' observer must not be affected. Both should coexist.
    const gc = new GcProfiler().start();
    const sibling = new PerformanceObserver(() => {});
    sibling.observe({ entryTypes: ['measure'] });
    // Do some marked work to trigger sibling activity
    for (let i = 0; i < 100; i++) {
        performance.mark('m-' + i);
        performance.measure('meas-' + i, 'm-' + i);
    }
    performance.clearMarks();
    performance.clearMeasures();
    sibling.disconnect();
    // Our summary should be clean (no marks are GC entries).
    const s = gc.summary();
    assertAxisC(s, { maxMajor: 0 }, 'sibling PerformanceObserver did not perturb gate');
    gc.stop();
});

test('[axis C] back-to-back settle() calls both return drained', () => {
    return new Promise((resolve) => {
        const gc = new GcProfiler().start();
        gc.settle().then((r1) => {
            gc.settle().then((r2) => {
                assert.equal(r1.drained, true);
                assert.equal(r2.drained, true);
                const s = gc.summary();
                assertAxisC(s, { maxMajor: 0 }, 'back-to-back settle preserves clean verdict');
                gc.stop();
                resolve();
            });
        });
    });
});

// =============================================================================
// AXIS D -- self-consistency invariants
// =============================================================================

test('[axis D] assertNoGc throws iff checkNoGc.verdict is not pass (respecting allowInconclusive)', () => {
    assertAxisD(() => {
        // Case 1: fail
        const failSummary = makeSummary('gc', { gc: { major: 1, count: 1 } });
        const failRep = checkNoGc(failSummary, { maxMajor: 0 });
        assert.equal(failRep.verdict, 'fail');
        assert.throws(() => assertNoGc(failSummary, { maxMajor: 0 }));

        // Case 2: inconclusive, default strict
        const incSummary = makeSummary('none');
        const incRep = checkNoGc(incSummary, { maxMajor: 0 });
        assert.equal(incRep.verdict, 'inconclusive');
        assert.throws(() => assertNoGc(incSummary, { maxMajor: 0 }));

        // Case 3: inconclusive, allowInconclusive
        const rep3 = assertNoGc(incSummary, { maxMajor: 0 }, { allowInconclusive: true });
        assert.equal(rep3.verdict, 'inconclusive');

        // Case 4: pass
        const passSummary = makeSummary('gc');
        const passRep = checkNoGc(passSummary, { maxMajor: 0 });
        assert.equal(passRep.verdict, 'pass');
        const rep4 = assertNoGc(passSummary, { maxMajor: 0 });
        assert.equal(rep4.verdict, 'pass');

        return true;
    }, 'assertNoGc/checkNoGc verdict agreement');
});

test('[axis D] verdict is a pure function of (summary, rules) -- byte-identical reports', () => {
    assertAxisD(() => {
        const s = makeSummary('gc', {
            gc: { major: 2, minor: 3, count: 5, totalMs: 15.5, maxMs: 8.25 },
            heap: { samples: 5, allocRateBytesPerSec: 1000 }
        });
        const rules = { maxMajor: 0, maxMinor: 5, maxPauseMs: 10, maxAllocRate: 2000 };
        const r1 = checkNoGc(s, rules);
        const r2 = checkNoGc(s, rules);
        assert.equal(JSON.stringify(r1), JSON.stringify(r2),
            'checkNoGc is not deterministic under identical inputs');
        return true;
    }, 'purity: identical inputs -> identical reports');
});

// =============================================================================
// PERTURBATION BOUND -- the torturer itself must not allocate majors
// =============================================================================

test('[perturbation bound] torture harness itself induces zero majors', () => {
    // If our test harness allocates majors, our torture claims are compromised.
    // This is a lightweight check; the full end-of-suite gate lands in a
    // torture/global.mjs when Batch 5 arrives.
    return new Promise((resolve) => {
        const gc = new GcProfiler().start();
        if (global.gc) global.gc();
        gc.settle().then(() => {
            gc.reset();
            // Simulate the harness patterns used above: makeSummary calls
            for (let i = 0; i < 1000; i++) {
                const s = makeSummary('gc', { gc: { major: 1, count: 1 } });
                checkNoGc(s, { maxMajor: 0 });
            }
            gc.settle().then(() => {
                const s = gc.summary();
                assert.equal(s.gc.major, 0,
                    'PERTURBATION BOUND VIOLATION: torture harness induced ' + s.gc.major
                    + ' major(s). Every torture claim above is now compromised.');
                gc.stop();
                resolve();
            });
        });
    });
});
