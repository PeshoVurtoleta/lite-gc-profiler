// G26.6 -- Torture for measureAllocs (v1.11.0). The per-call retained-alloc
// assertion is the estimator most likely to be trusted for a hard "== 0"
// claim in another package's CI, so a silent pass here propagates a false
// zero-GC guarantee across the ecosystem. Four axes:
//
//   A -- MUST be inconclusive. A green verdict on unmeasurable input is the
//        worst bug: it certifies zero allocation that was never measured.
//   B -- real retention that MUST fail, even buried in batch noise.
//   C -- clean signal under hostile conditions that MUST pass.
//   D -- self-consistency invariants across measureAllocs/checkAllocs/assertAllocs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    measureAllocs, checkAllocs, assertAllocs,
    GcBudgetError, GcInconclusiveError,
    VERDICT_MATRIX
} from '../../Gc.js';

const ALLOCS_SCHEMA = 'lite-gc-allocs/1';

// Build a measureAllocs-shaped result literal so source columns and evidence
// flags can be exercised without depending on a real runtime producing them.
function makeAllocs(over) {
    const base = {
        schema: ALLOCS_SCHEMA,
        iterations: 1000,
        batches: 8,
        warmupCalls: 1000,
        measuredBatches: 8,
        bytesPerCall: 0,
        maxBytesPerCall: 0,
        batchBytes: [0, 0, 0, 0, 0, 0, 0, 0],
        settled: true,
        source: 'gc',
        summary: {
            schema: 'lite-gc/1',
            source: 'gc',
            supported: true,
            uasm: { supported: false, samples: 0 }
        }
    };
    return Object.assign(base, over);
}

// =============================================================================
// AXIS A -- MUST produce 'inconclusive'
// =============================================================================

test("[axis A] source='none' + maxBytesPerCall -> inconclusive", () => {
    // A green verdict here claims zero retention on a runtime with no memory
    // API. The per-call analogue of the per-op silent hole.
    const r = measureAllocs((i) => i | 0, { iterations: 200, batches: 2, source: 'none' });
    const rep = checkAllocs(r, { maxBytesPerCall: 0 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checked.maxBytesPerCall, false);
});

test('[axis A] settled:false (a batch missed its forced settle) -> inconclusive', () => {
    // A partial min is not a floor. If any batch lacked a heap reading, the
    // minimum could be an artefact of the missing batch, not the true cost.
    const r = makeAllocs({
        settled: false,
        measuredBatches: 6,
        batchBytes: [0, 0, null, 0, 0, 0, null, 0],
        bytesPerCall: 0,
        maxBytesPerCall: 0
    });
    const rep = checkAllocs(r, { maxBytesPerCall: 0 });
    assert.equal(rep.verdict, 'inconclusive', 'unsettled run must not certify zero');
    assert.equal(rep.checked.maxBytesPerCall, false);
    assert.ok(rep.reasons.some((s) => /did not settle/.test(s)));
});

test('[axis A] bytesPerCall null despite settled -> inconclusive', () => {
    // No batch produced a finite reading (every memoryUsage was bad). null is
    // "not measured", never a laundered 0.
    const r = makeAllocs({
        bytesPerCall: null,
        maxBytesPerCall: null,
        measuredBatches: 0,
        batchBytes: [null, null, null, null, null, null, null, null],
        settled: false
    });
    assert.equal(checkAllocs(r, { maxBytesPerCall: 0 }).verdict, 'inconclusive');
});

test('[axis A] NaN bytesPerCall -> inconclusive, never a pass', () => {
    // NaN > 0 is false, so a naive gate would PASS. _isFiniteMetric rejects it.
    const r = makeAllocs({ bytesPerCall: NaN, maxBytesPerCall: NaN });
    const rep = checkAllocs(r, { maxBytesPerCall: 0 });
    assert.equal(rep.verdict, 'inconclusive', 'NaN must not pass a zero budget');
});

test('[axis A] Infinity bytesPerCall -> inconclusive', () => {
    const r = makeAllocs({ bytesPerCall: Infinity, maxBytesPerCall: Infinity });
    assert.equal(checkAllocs(r, { maxBytesPerCall: 0 }).verdict, 'inconclusive');
});

test('[axis A] source=heap synthetic with unmet needsHeap -> inconclusive', () => {
    // needsHeap requires bytesPerCall be a finite number. A heap-sourced result
    // that somehow carries null must not pass.
    const r = makeAllocs({ source: 'heap', bytesPerCall: null, settled: true, measuredBatches: 8 });
    assert.equal(checkAllocs(r, { maxBytesPerCall: 0 }).verdict, 'inconclusive');
});

test('[axis A] assertAllocs throws GcInconclusiveError on unmeasurable input', () => {
    const r = makeAllocs({ source: 'none', bytesPerCall: null });
    // Route through assertAllocs by faking measureAllocs via a source:none run.
    assert.throws(
        () => assertAllocs((i) => i | 0, { maxBytesPerCall: 0 }, { iterations: 200, batches: 2, source: 'none' }),
        GcInconclusiveError
    );
    void r;
});

// =============================================================================
// AXIS B -- real retention that MUST fail
// =============================================================================

test('[axis B] one clean batch cannot rescue a retaining function', () => {
    // The min estimator's failure mode would be a single artificially-low
    // batch dragging the reported figure under the limit. Even so, a genuine
    // retainer measured across real batches must fail: the floor is the
    // retention, and a batch cannot retain LESS than the function does.
    let sink = [];
    const retain = (i) => { sink.push({ a: i, b: i * 2 }); };
    const rep = assertViaMeasure(retain, { maxBytesPerCall: 0 }, { iterations: 2000, batches: 8 });
    assert.equal(rep.verdict, 'fail');
    assert.ok(rep.violations[0].actual > 0);
});

test('[axis B] a synthetic result with a real min > limit fails', () => {
    const r = makeAllocs({
        batchBytes: [72000, 80000, 96000, 72000, 101000, 72000, 85000, 79000],
        bytesPerCall: 72, maxBytesPerCall: 101, measuredBatches: 8, settled: true
    });
    const rep = checkAllocs(r, { maxBytesPerCall: 64 });
    assert.equal(rep.verdict, 'fail');
    assert.equal(rep.violations[0].actual, 72);
    assert.match(rep.violations[0].reason, /min over 8 batches/);
});

test('[axis B] the boundary: min exactly at limit passes, one over fails', () => {
    const at = makeAllocs({ bytesPerCall: 50, maxBytesPerCall: 60 });
    assert.equal(checkAllocs(at, { maxBytesPerCall: 50 }).verdict, 'pass',
        'exactly at the limit is not over it');
    const over = makeAllocs({ bytesPerCall: 51, maxBytesPerCall: 60 });
    assert.equal(checkAllocs(over, { maxBytesPerCall: 50 }).verdict, 'fail');
});

test('[axis B] assertAllocs throws GcBudgetError on a retaining function', () => {
    let sink = [];
    const retain = (i) => { sink.push([i, i, i]); };
    assert.throws(
        () => assertAllocs(retain, { maxBytesPerCall: 0 }, { iterations: 2000, batches: 8 }),
        GcBudgetError
    );
});

// =============================================================================
// AXIS C -- clean signal under hostile conditions, MUST pass
// =============================================================================

test('[axis C] a zero-retention function passes maxBytesPerCall 0 across many batches', () => {
    const scratch = new Float64Array(8);
    const clean = (i) => { scratch[i & 7] = scratch[i & 7] + 1; };
    const rep = assertViaMeasure(clean, { maxBytesPerCall: 0 }, { iterations: 5000, batches: 12 });
    assert.equal(rep.verdict, 'pass');
});

test('[axis C] a single batch still yields a coherent (if noisier) result', () => {
    const scratch = new Float64Array(2);
    const clean = (i) => { scratch[i & 1] += 1; };
    const r = measureAllocs(clean, { iterations: 5000, batches: 1 });
    assert.equal(r.batchBytes.length, 1);
    assert.equal(r.bytesPerCall, r.maxBytesPerCall, 'one batch: min equals max');
    assert.equal(checkAllocs(r, { maxBytesPerCall: 8 }).verdict, 'pass');
});

test('[axis C] tiny iteration count does not crash or misreport shape', () => {
    const r = measureAllocs((i) => i | 0, { iterations: 1, batches: 2 });
    assert.equal(r.iterations, 1);
    assert.ok(r.bytesPerCall === null || typeof r.bytesPerCall === 'number');
});

test('[axis C] a huge but legal limit passes without overflow', () => {
    const r = makeAllocs({ bytesPerCall: 1e6, maxBytesPerCall: 1e6 });
    assert.equal(checkAllocs(r, { maxBytesPerCall: Number.MAX_SAFE_INTEGER }).verdict, 'pass');
});

// =============================================================================
// AXIS D -- self-consistency invariants
// =============================================================================

test('[axis D] checkAllocs does not mutate the result it is given', () => {
    const r = makeAllocs({ bytesPerCall: 40, maxBytesPerCall: 90 });
    const wire = JSON.stringify(r);
    checkAllocs(r, { maxBytesPerCall: 10 });
    assert.equal(JSON.stringify(r), wire, 'result must be untouched after a check');
});

test('[axis D] repeated checks of one result agree exactly', () => {
    const r = makeAllocs({ bytesPerCall: 33, maxBytesPerCall: 50, source: 'gc' });
    const a = JSON.stringify(checkAllocs(r, { maxBytesPerCall: 10 }));
    const b = JSON.stringify(checkAllocs(r, { maxBytesPerCall: 10 }));
    assert.equal(a, b);
});

test('[axis D] assertAllocs verdict matches checkAllocs on the same measurement', () => {
    const scratch = new Float64Array(4);
    const clean = (i) => { scratch[i & 3] += 1; };
    // Measure once, then check; assert should agree with a fresh measure+check.
    const r = measureAllocs(clean, { iterations: 4000, batches: 8 });
    const checkVerdict = checkAllocs(r, { maxBytesPerCall: 0 }).verdict;
    assert.equal(checkVerdict, 'pass');
    assert.doesNotThrow(() => assertAllocs(clean, { maxBytesPerCall: 0 }, { iterations: 4000, batches: 8 }));
});

test('[axis D] bytesPerCall in the report equals bytesPerCall in the result', () => {
    const r = makeAllocs({ bytesPerCall: 17, maxBytesPerCall: 40 });
    const rep = checkAllocs(r, { maxBytesPerCall: 100 });
    assert.equal(rep.bytesPerCall, r.bytesPerCall);
});

test('[axis D] batchBytes min/iterations equals reported bytesPerCall on a real run', () => {
    const scratch = new Float64Array(4);
    const clean = (i) => { scratch[i & 3] += 1; };
    const r = measureAllocs(clean, { iterations: 3000, batches: 6 });
    const measured = r.batchBytes.filter((b) => b !== null);
    if (measured.length > 0) {
        const expectedMin = Math.min(...measured) / r.iterations;
        assert.equal(r.bytesPerCall, expectedMin, 'reported min must be the batch min');
    }
});

// =============================================================================
// resource safety -- the measurement guard and --expose-gc gate
// =============================================================================

test('measureAllocs releases the measurement guard even when fn throws', () => {
    const boom = () => { throw new Error('workload exploded'); };
    assert.throws(() => measureAllocs(boom, { iterations: 100, batches: 2 }), /workload exploded/);
    // If the guard leaked, this second measurement would throw the
    // "another measurement is already in flight" error instead of running.
    assert.doesNotThrow(() => measureAllocs((i) => i | 0, { iterations: 100, batches: 2 }));
});

test('measureAllocs throws without --expose-gc (stubbed)', () => {
    const realGc = globalThis.gc;
    try {
        // Simulate a runtime without --expose-gc.
        globalThis.gc = undefined;
        assert.throws(
            () => measureAllocs((i) => i | 0, { iterations: 100, batches: 2 }),
            (e) => e instanceof RangeError && /--expose-gc/.test(e.message)
        );
    } finally {
        globalThis.gc = realGc;
    }
});

test('measureAllocs releases the guard after the --expose-gc throw', () => {
    const realGc = globalThis.gc;
    try {
        globalThis.gc = undefined;
        try { measureAllocs((i) => i | 0, { iterations: 100, batches: 2 }); } catch (e) { void e; }
    } finally {
        globalThis.gc = realGc;
    }
    // The guard is entered AFTER the --expose-gc check, so it should never have
    // been taken. A following real measurement must run cleanly.
    assert.doesNotThrow(() => measureAllocs((i) => i | 0, { iterations: 100, batches: 2 }));
});

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

// measure + check in one shot, returning the report (not throwing), so an axis
// assertion can inspect the verdict regardless of pass/fail.
function assertViaMeasure(fn, rules, opts) {
    const r = measureAllocs(fn, opts);
    return checkAllocs(r, rules);
}
