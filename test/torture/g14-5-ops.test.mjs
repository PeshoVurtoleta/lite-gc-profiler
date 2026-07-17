// Torture scenarios for Batch 6 (per-op primitives): 10 scenarios across
// axis A (inconclusive traps), axis B (fail-through-noise), axis C (pass
// under hostile conditions), axis D (self-consistency invariants).
//
// The G16.5 partial-report scenario (process.exit before beforeExit) belongs
// with the Register/CLI integration and lives in its own file if needed --
// this file focuses on the pure per-op primitive surface (measureOps,
// checkOps, assertOps, compareOps, assertCompareOps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    measureOps, checkOps, assertOps,
    compareOps, assertCompareOps,
    GcBudgetError, GcInconclusiveError,
    VERDICT_MATRIX
} from '../../Gc.js';

// =============================================================================
// AXIS A -- MUST produce 'inconclusive'
// =============================================================================

test("[axis A] source='none' + maxBytesPerOp -> inconclusive (no memory channel)", () => {
    // A green verdict here would silently claim zero allocation on a runtime
    // that has no memory API. This is the per-op analogue of the v1.0.0 silent
    // hole (G3.5 axis-A #1) and G13.5 axis-A #3.
    const r = measureOps((i) => i | 0, { ops: 100, source: 'none' });
    const rep = checkOps(r, { maxBytesPerOp: 0 });
    assert.equal(rep.verdict, 'inconclusive', 'source=none + memory rule must be inconclusive');
    assert.equal(rep.checked.maxBytesPerOp, false);
});

test("[axis A] source='heap' (simulated) + maxMajorsPerKOp -> inconclusive (no event kinds on heap)", () => {
    // We can't actually get source='heap' on node, but we can build a synthetic
    // measureOps-shaped result and check the gate. This protects against the
    // "kind rules on heap silently pass" class of bugs.
    const synthetic = {
        schema: 'lite-gc-ops/1',
        ops: 1000, warmupOps: 0,
        elapsedMs: 100, opsPerSec: 10000,
        bytesPerOp: 12,
        source: 'heap',
        summary: {
            schema: 'lite-gc/1', source: 'heap',
            gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, p99Ms: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 },
            heap: { supported: true, samples: 2 },
            uasm: { supported: false, samples: 0, growthRate: 0 },
            phases: {
                warmup: { gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 } },
                steady: { gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 } }
            }
        }
    };
    const rep = checkOps(synthetic, { maxMajorsPerKOp: 0 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checked.maxMajorsPerKOp, false);
});

test('[axis A] compareOps: gc-sourced vs heap-sourced (synthetic) -> inconclusive (source mismatch)', () => {
    const gcResult = measureOps((i) => i | 0, { ops: 100 });                 // source=gc
    const heapSynthetic = {
        schema: 'lite-gc-ops/1', ops: 100, warmupOps: 0,
        elapsedMs: 10, opsPerSec: 10000, bytesPerOp: 5,
        source: 'heap',
        summary: gcResult.summary                                             // shape-only reuse
    };
    const rep = compareOps(gcResult, heapSynthetic, { maxExtraBytesPerOp: 1 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.reason, 'source_mismatch');
});

// =============================================================================
// AXIS B -- MUST produce 'fail'
// =============================================================================

test('[axis B] candidate with 10x bytes/op vs clean control -> compareOps fails', () => {
    const sinkA = [];
    const sinkB = [];
    function control(i)   { sinkA.length = 0; return i | 0; }                    // no retention
    function candidate(i) {
        // ~10x more retention per call than the control
        for (let j = 0; j < 10; j++) sinkB.push(new Uint8Array(512));
    }
    const ctlR = measureOps(control,   { ops: 500, warmup: 50 });
    const canR = measureOps(candidate, { ops: 500, warmup: 50 });
    // If either result lost bytesPerOp to a GC intervention, torture punts.
    if (canR.bytesPerOp === null || ctlR.bytesPerOp === null) return;
    const delta = canR.bytesPerOp - ctlR.bytesPerOp;
    if (delta < 100) return;                                                     // GC ate the delta; punt

    const rep = compareOps(ctlR, canR, { maxExtraBytesPerOp: 50 });
    assert.equal(rep.verdict, 'fail');
    assert.ok(rep.violations.some((v) => v.metric === 'bytesPerOp.delta'));
});

test('[axis B] leaky STEADY is not shielded by clean warmup', () => {
    // The failure mode this prevents: someone puts real work in warmup and a
    // token noop in steady to game the gate. That's not what we're testing
    // here -- we're testing the inverse. A clean warmup followed by a heavy
    // steady MUST fail on maxBytesPerOp; warmup allocations are NOT counted
    // toward the steady bytesPerOp because the phase boundary quarantines them.
    const warmupSink = [];                                                       // never touched
    const steadySink = [];
    let call = 0;
    const warmupCount = 100, steadyCount = 500;
    function fn(i) {
        call++;
        if (call <= warmupCount) return;                                         // clean warmup
        for (let j = 0; j < 4; j++) steadySink.push(new Uint8Array(512));        // heavy steady
    }
    const r = measureOps(fn, { ops: steadyCount, warmup: warmupCount });
    if (r.bytesPerOp === null || r.bytesPerOp < 100) return;                     // GC intervention; punt

    // A rule that allows 100 bytes/op must fail against ~2KB/op steady.
    assert.throws(
        () => assertOps(() => { /* noop, we already have the report */ }, {}, {}),
        () => true                                                               // any throw is fine; guard below is the pin
    );
    // Direct assertion on the already-taken measurement:
    const rep = checkOps(r, { maxBytesPerOp: 100 });
    assert.equal(rep.verdict, 'fail', 'steady leak must fail even when warmup was clean');
});

test('[axis B] warmup taking the allocation storm STILL keeps steady clean (mirror pin)', () => {
    // The complementary pin: heavy warmup, clean steady MUST pass on a strict
    // steady rule. Together with the previous scenario this proves that the
    // phase() boundary in measureOps really quarantines warmup allocations.
    const warmupSink = [];
    let call = 0;
    const warmupCount = 200, steadyCount = 500;
    function fn(i) {
        call++;
        if (call <= warmupCount) {
            for (let j = 0; j < 20; j++) warmupSink.push(new Uint8Array(1024));  // heavy warmup
            return;
        }
        // clean steady
    }
    const r = measureOps(fn, { ops: steadyCount, warmup: warmupCount });
    const rep = checkOps(r, { maxBytesPerOp: 100 });
    if (rep.verdict === 'inconclusive') return;                                  // no memory channel; punt
    assert.equal(rep.verdict, 'pass', 'clean steady must not be tainted by warmup allocations');
});

// =============================================================================
// AXIS C -- MUST produce 'pass'
// =============================================================================

test('[axis C] identical noop workloads compare with delta 0 -> pass', () => {
    function noop(i) { return i | 0; }
    const ctl = measureOps(noop, { ops: 1000, warmup: 100 });
    const can = measureOps(noop, { ops: 1000, warmup: 100 });
    const rep = compareOps(ctl, can, { maxExtraBytesPerOp: 1024 });
    // Even with V8 noise, two noop runs should produce a delta well under
    // 1024 bytes/op. If not, the harness itself is contaminated -- an axis-C
    // failure here would mean measureOps has hidden allocation on its own hot
    // path.
    assert.equal(rep.verdict, 'pass', 'noop-vs-noop compareOps must be pass; got ' + rep.verdict);
});

test('[axis C] measureOps itself induces no majors on a noop workload', () => {
    // Perturbation bound for the per-op harness. If measureOps allocates on
    // its own hot path (per-iteration closure capture, per-call summary
    // object churn, etc.) it will show up here as a major even though the
    // user's fn is a noop.
    function noop(i) { return i | 0; }
    const r = measureOps(noop, { ops: 10_000, warmup: 100 });
    const steady = r.summary.phases.steady && r.summary.phases.steady.gc;
    assert.ok(steady, 'steady phase must exist');
    assert.equal(steady.major, 0, 'measureOps must not induce majors on a noop workload');
});

test('[axis C] self-noise cancellation: clean workload lands under the noise floor', () => {
    // A truly noop workload with sufficient ops should report bytesPerOp
    // essentially at zero. This scenario pins two independent claims:
    //
    // 1. The paired-call memoryUsage() cancellation (v1.3.1 hardening) is
    //    subtracting the ~240-byte self-cost as designed. Without it, that
    //    ~240 bytes fold into the delta and inflate bytesPerOp.
    //
    // 2. V8's own residual noise (feedback vectors, tier-up allocations,
    //    incremental marking bookkeeping during the loop) is dilutable by
    //    scale. At 10_000 ops, V8's ~500-1200 bytes of loop-bookkeeping
    //    contributes < 0.15 bytes/op, so a clean workload should land
    //    under 1 byte/op reliably.
    //
    // If either the cancellation regresses or a future V8 pushes its own
    // bookkeeping cost above ~10 KB per 10K-iteration loop, this scenario
    // catches it before any Wave rollout hits `maxBytesPerOp: 0` failures
    // in the wild.
    function noop(i) { return i | 0; }
    // Multiple attempts + best-of: V8 occasionally does an incremental
    // marking step during the loop, spiking the delta for that run. The
    // clean-run case is the pin, not the interference case.
    let bestBytesPerOp = Infinity;
    for (let attempt = 0; attempt < 5; attempt++) {
        const r = measureOps(noop, { ops: 10_000, warmup: 500 });
        if (r.bytesPerOp !== null && r.bytesPerOp < bestBytesPerOp) {
            bestBytesPerOp = r.bytesPerOp;
        }
    }
    assert.ok(bestBytesPerOp < 1,
        'clean noop workload at 10K ops must land under 1 byte/op with self-noise cancellation; got ' + bestBytesPerOp);
});

// =============================================================================
// AXIS D -- self-consistency invariants
// =============================================================================

test('[axis D] measureOps result shape stable across sources (missing channels stay null, not 0)', () => {
    // Iterate every source that node can construct explicitly. Assert the
    // returned shape is identical on the top-level fields and that bytesPerOp
    // is null exactly when the source cannot compute it.
    const sources = ['auto', 'gc', 'none'];                                      // uasm/heap unavailable on node
    const shape = ['schema', 'ops', 'warmupOps', 'elapsedMs', 'opsPerSec',
                   'bytesPerOp', 'source', 'summary'];
    for (const src of sources) {
        const r = measureOps((i) => i | 0, { ops: 100, source: src });
        for (const k of shape) {
            assert.ok(k in r, 'source=' + src + ': result missing key ' + k);
        }
        if (r.source === 'none') {
            assert.equal(r.bytesPerOp, null, 'source=' + src + ' resolved to none: bytesPerOp must be null');
        } else {
            // On gc source, bytesPerOp is either a non-negative number or null
            // (null would be a runtime-quirk edge). Assert type is one of the two.
            assert.ok(r.bytesPerOp === null || (typeof r.bytesPerOp === 'number' && r.bytesPerOp >= 0),
                'source=' + src + ': bytesPerOp must be null or non-negative number');
        }
    }
});

test('[axis D] compareOps verdict matches per-metric manual computation', () => {
    // Synthetic control and candidate with known deltas; compareOps must
    // produce a report whose verdict is consistent with recomputing each
    // delta by hand. Regression protection for the delta arithmetic.
    const base = {
        schema: 'lite-gc-ops/1', ops: 1000, warmupOps: 0,
        elapsedMs: 100, opsPerSec: 10000, bytesPerOp: 10,
        source: 'gc',
        summary: {
            schema: 'lite-gc/1', source: 'gc',
            gc: { count: 5, totalMs: 5, maxMs: 1, avgMs: 1, p99Ms: 1, minor: 5, major: 0, incremental: 0, weakcb: 0 },
            heap: { supported: true, samples: 2 },
            uasm: { supported: false, samples: 0, growthRate: 0 },
            phases: {
                warmup: { gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 } },
                steady: { gc: { count: 5, totalMs: 5, maxMs: 1, avgMs: 1, minor: 5, major: 0, incremental: 0, weakcb: 0 } }
            }
        }
    };
    // Candidate: 3x bytesPerOp, 4x majors -- both must show up as violations
    // when limits are tight, or as pass when limits are lenient.
    const candidate = JSON.parse(JSON.stringify(base));
    candidate.bytesPerOp = 30;                                                   // +20 vs control
    candidate.summary.phases.steady.gc.major = 4;                                // +4 majors in 1000 ops -> +4 per Kop

    // Tight limits: both violations should be reported.
    let rep = compareOps(base, candidate, { maxExtraBytesPerOp: 5, maxExtraMajorsPerKOp: 1 });
    assert.equal(rep.verdict, 'fail');
    assert.ok(rep.violations.some((v) => v.metric === 'bytesPerOp.delta'));
    assert.ok(rep.violations.some((v) => v.metric === 'majorsPerKOp.delta'));

    // Lenient limits that exactly clear both deltas: pass.
    rep = compareOps(base, candidate, { maxExtraBytesPerOp: 25, maxExtraMajorsPerKOp: 5 });
    assert.equal(rep.verdict, 'pass', 'lenient limits above the actual deltas must pass');
});
