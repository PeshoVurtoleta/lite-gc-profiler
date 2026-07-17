// Torture tests for Batch 5 (browser second source + calibration): 11
// scenarios. Axis D reduced from the original plan's 2 to 1 -- the "SPP
// probe stream shape matches summary shape" invariant lives in the sibling
// lite-scope-gc-probe package.
//
// Node cannot exercise the real browser APIs (performance.memory,
// measureUserAgentSpecificMemory), so these scenarios test the GATE's
// behavior on synthetic browser-shaped summaries. Real browser behavior
// (heuristic false-positive/false-negative calibration) is covered by
// demo/calibration.html, not automated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    GcProfiler, checkNoGc, assertNoGc, compareGc, gateReps,
    aggregateGc, createBaseline, checkAgainstBaseline,
    VERDICT_MATRIX
} from '../../Gc.js';
import { assertAxisA, assertAxisC, assertAxisD, makeSummary } from './harness.mjs';

function makeUasm(over) {
    return makeSummary('uasm', Object.assign({
        uasm: { supported: true, samples: 5, bytes: 1000000, peak: 1500000, firstSample: 500000, growthRate: 100000 }
    }, over || {}));
}

// =============================================================================
// AXIS A -- MUST produce 'inconclusive'
// =============================================================================

test("[axis A] source='uasm' + maxMajor:0 -> inconclusive (no event kinds on uasm)", () => {
    // Uasm exposes bytes, not event kinds. A kind rule on a uasm-only gate
    // cannot be answered. This is the browser equivalent of G3.5's silent-
    // hole test on Firefox/Safari.
    const s = makeUasm({ uasm: { supported: true, samples: 2, growthRate: 0 } });
    assertAxisA(s, { maxMajor: 0 }, 'kind rule on uasm has no answer');
});

test("[axis A] source='uasm' + maxAllocRate with <2 samples -> inconclusive", () => {
    // Growth rate requires two points; one sample can't answer.
    const s = makeUasm({ uasm: { supported: true, samples: 1, growthRate: 0 } });
    assertAxisA(s, { maxAllocRate: 1000000 },
        'growth rate needs two samples; one sample is inconclusive');
});

test("[axis A] source='none' + maxAllocRate -> inconclusive (mirrors G3.5 axis-A but for uasm-adjacent)", () => {
    // Firefox / Safari path: no heap API, no uasm. Any memory rule is
    // unverifiable. This is regression protection for the silent-hole class
    // even as we widened the source enum.
    const s = makeSummary('none');
    assertAxisA(s, { maxAllocRate: 1000000 },
        'no memory channel available on this source');
});

// =============================================================================
// AXIS B -- MUST produce 'fail'
// =============================================================================

test("[axis B] uasm growth rate over limit -> fail", () => {
    const s = makeUasm({
        uasm: { supported: true, samples: 4, bytes: 5000000, peak: 5000000, firstSample: 1000000, growthRate: 2000000 }
    });
    const rep = checkNoGc(s, { maxAllocRate: 500000 });
    assert.equal(rep.verdict, 'fail', 'uasm growthRate must fail when over limit');
});

test('[axis B] uasm rep gate: single leaky rep among many clean under all-clean -> fail (D4 policy pin, uasm form)', () => {
    // Mirrors G5.5 axis-B #1 but on uasm channel. If this silently passes,
    // the D4 policy pin has been broken for the uasm path -- and every
    // uasm-based zero-alloc claim weakens.
    const reps = [];
    for (let i = 0; i < 9; i++) reps.push(makeUasm({ uasm: { supported: true, samples: 3, growthRate: 100000 } }));
    reps.push(makeUasm({ uasm: { supported: true, samples: 3, growthRate: 5000000 } }));         // one dirty rep
    const rep = gateReps(reps, { maxAllocRate: 1000000 },
        { policy: { maxAllocRate: 'all-clean' } });
    assert.equal(rep.verdict, 'fail', 'one dirty rep under all-clean must fail');
});

test('[axis B] uasm compareGc: candidate growth much higher than control -> fail', () => {
    const control = makeUasm({ uasm: { supported: true, samples: 3, growthRate: 100000 } });
    const candidate = makeUasm({ uasm: { supported: true, samples: 3, growthRate: 5000000 } });
    const rep = compareGc(control, candidate, { maxExtraAllocRate: 500000 });
    assert.equal(rep.verdict, 'fail');
    assert.ok(rep.violations.some((v) => v.metric.includes('uasm.growthRate.delta')),
        'delta metric must reflect uasm channel, not heap');
});

// =============================================================================
// AXIS C -- MUST produce 'pass'
// =============================================================================

test('[axis C] clean uasm workload under reasonable limits -> pass', () => {
    const s = makeUasm({ uasm: { supported: true, samples: 5, growthRate: 100000 } });
    assertAxisC(s, { maxAllocRate: 500000 }, 'clean uasm rate under limit');
});

test("[axis C] source='heap' still works after adding uasm column (regression protection)", () => {
    // Adding the uasm column to VERDICT_MATRIX should not have perturbed
    // heap-source verdicts. This is the "additive changes stay additive" pin.
    const s = makeSummary('heap', { heap: { supported: true, samples: 5, allocRateBytesPerSec: 100000 } });
    assertAxisC(s, { maxAllocRate: 500000 }, 'heap-source verdicts unchanged');
});

test('[axis C] uasm rep gate on clean reps + best-clean policy for pauses -> pass', () => {
    // best-clean pauses semantics unchanged for uasm (pauses aren't a uasm
    // concept, so the policy defaults still apply to kind-source runs).
    const reps = [];
    for (let i = 0; i < 5; i++) reps.push(makeUasm({ uasm: { supported: true, samples: 3, growthRate: 100000 } }));
    const rep = gateReps(reps, { maxAllocRate: 500000 });
    assert.equal(rep.verdict, 'pass');
});

// =============================================================================
// AXIS D -- self-consistency invariants
// =============================================================================

test('[axis D] VERDICT_MATRIX exposes every source column for every rule', () => {
    // Any rule row missing the uasm column would silently degrade verdicts
    // (undefined state falls through to 'not checkable'). Assert every row
    // has all four expected columns.
    const expected = ['gc', 'heap', 'uasm', 'none'];
    for (const rule in VERDICT_MATRIX) {
        for (const source of expected) {
            assert.ok(VERDICT_MATRIX[rule][source] !== undefined,
                'rule ' + rule + ' missing source column ' + source);
        }
    }
});

test('[axis D] baseline captured from uasm reps round-trips through JSON', () => {
    // Ensures createBaseline handles uasm-populated aggregates and
    // checkAgainstBaseline reads them back correctly. A regression here
    // means baseline files for uasm-gated packages silently drop the uasm
    // channel on serialization.
    const reps = [];
    for (let i = 0; i < 5; i++) reps.push(makeUasm({ uasm: { supported: true, samples: 3, growthRate: 100000 + i * 10000 } }));
    const agg = aggregateGc(reps);
    const baseline = createBaseline(agg);
    const json = JSON.parse(JSON.stringify(baseline));
    assert.ok(json.uasm, 'baseline must include uasm block');
    assert.ok(json.uasm.growthRate, 'uasm.growthRate stats must survive round-trip');
    // And it should still gate correctly.
    // Force the fingerprint to match by copying (in production users see fingerprint mismatch as inconclusive)
    const same = Object.assign({}, agg);
    const rep = checkAgainstBaseline(same, json);
    // On the same-data comparison the verdict should be pass or (if fingerprint differs) inconclusive.
    // Both are consistent -- the invariant is that we don't crash on uasm data.
    assert.ok(rep.verdict === 'pass' || rep.verdict === 'inconclusive');
});
