// Torture tests for Batch 12 (v1.9.0), H1 -- bounded-time reporting.
//
// WHAT CHANGED
//
// Two report-path sites sorted unconditionally: percentile() over the GC
// pause-duration ring (Gc.js:95 in v1.8.0) and _framePercentiles() over frame
// work-times (:2561). Both now verify order first, in one O(N) pass with early
// exit, and sort only on violation. The ring can hold MAX_RING_CAPACITY (2**24)
// doubles; at that size the difference between a linear pass and a full TimSort
// is the difference between a report you wait for and one you do not.
//
// WHAT MUST NOT CHANGE
//
// Anything a caller can observe. Skipping a sort is only sound if the sort
// would have been the identity, so the pins below are split accordingly:
//
//   (a) branch pins  -- ordered input must not reach the sort; out-of-order
//                       input must. Verified by instrumenting
//                       Float64Array.prototype.sort and filtering by CALL SITE,
//                       not by array length: the duration-ring percentile fires
//                       in the same window with a run-dependent length and would
//                       make a length filter flaky.
//
//   (b) output pins  -- the reported percentiles must be a function of the
//                       multiset only, never of arrival order. Same values in,
//                       same values out, whichever branch ran.
//
// NOT PINNED HERE, AND WHY: the NaN case. _isSortedAscending is written
// `!(prev <= cur)` precisely so a NaN forces the real sort -- with `prev > cur`
// the array [NaN, 1, 2] would be called sorted and left alone, where
// TypedArray.prototype.sort moves NaN to the END, silently shifting every
// percentile. There is no public path that can put a NaN into either buffer
// (both are filled from performance.now() deltas and PerformanceObserver
// durations), so the guarantee rests on the predicate's shape and the comment
// above it. If a future lane ever admits caller-supplied durations, this is
// the first test that needs writing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- sort instrumentation, installed before the fresh import ----

const realSort = Float64Array.prototype.sort;
let SORTS = [];

Float64Array.prototype.sort = function () {
    // Frame 0 is this wrapper, frame 1 is the sort() call site inside Gc.js.
    const stack = new Error().stack || '';
    SORTS.push({
        length: this.length,
        fromFrames: stack.indexOf('_framePercentiles') !== -1,
        fromPauseRing: stack.indexOf('at percentile') !== -1
    });
    return realSort.apply(this, arguments);
};

// A plain static-equivalent import: patching Float64Array.prototype.sort does
// not need to precede module evaluation, because `view.sort()` resolves the
// method at call time. No cache-busting query string -- a second module
// instance of Gc.js would break the shipped-file coverage gate, which cannot
// merge two instances of one file.
const { measureFrames } = await import('../../Gc.js');

const fastSched = (cb) => setTimeout(cb, 0);

/** Occupy the thread for ~ms. Coarse on purpose: the pins use wide separations. */
function burn(ms) {
    if (ms <= 0) return;
    const end = performance.now() + ms;
    while (performance.now() < end) { /* spin */ }
}

/**
 * Run one frame per entry of `targets`, burning that many ms in frame i.
 * Returns the frames result plus only those sorts that came from the
 * frame-percentile site.
 */
async function runFrames(targets) {
    SORTS = [];
    let i = 0;
    const result = await measureFrames(
        () => { burn(targets[i]); i++; },
        {
            frames: targets.length,
            warmup: 0,
            scheduler: fastSched,
            source: 'none',
            stabilize: false
        }
    );
    return { result, frameSorts: SORTS.filter((s) => s.fromFrames) };
}

// A well-separated multiset: 3ms apart, so ordinary scheduler noise cannot
// reorder adjacent entries and the order statistics are known in advance.
const SPREAD = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27];
// A fixed permutation of SPREAD. Fixed, not random: a torture pin that fails
// one run in fifty is a pin nobody trusts.
const SHUFFLED = [15, 0, 27, 9, 3, 24, 6, 21, 12, 18];

// Nearest-rank over 10 entries, matching _framePercentiles' index arithmetic:
// p50 -> idx 5 (=15ms), p95 -> idx 9 (=27ms), p99 -> idx 9, max -> idx 9.
const EXPECT = { p50: 15, p95: 27, p99: 27, max: 27 };
const TOL_MS = 5;

function assertNear(actual, expected, label) {
    assert.ok(Math.abs(actual - expected) <= TOL_MS,
        label + ': expected ~' + expected + 'ms, got ' + actual.toFixed(3) + 'ms');
}

// =============================================================================
// (a) BRANCH PINS -- the fast path must be taken exactly when it is sound
// =============================================================================

test('[axis D] ascending frame work-times never reach the sort', async () => {
    // Frame 0 does nothing, frame 1 burns 20ms. A 20ms separation cannot be
    // inverted by scheduler noise, so the input is ordered by construction.
    const { frameSorts } = await runFrames([0, 20]);
    assert.equal(frameSorts.length, 0,
        'ordered input took the sort branch: the O(N) verify pass is not being consulted');
});

test('[axis D] descending frame work-times DO reach the sort', async () => {
    // The same construction reversed. Without this the previous pin would also
    // pass against a build that had simply deleted both sorts.
    const { frameSorts } = await runFrames([20, 0]);
    assert.equal(frameSorts.length, 1,
        'out-of-order input skipped the sort: percentiles would be read off an unsorted buffer');
    assert.equal(frameSorts[0].length, 2);
});

test('[axis D] a single frame never sorts', async () => {
    const { frameSorts } = await runFrames([5]);
    assert.equal(frameSorts.length, 0, 'a one-element window is sorted by definition');
});

test('[axis D] the pause-ring site is instrumented and distinct from the frames site', async () => {
    // Guards the instrumentation itself. These two call sites share a prototype
    // method; if the stack filter ever stops distinguishing them, the branch
    // pins above go quietly vacuous -- they would pass by matching nothing.
    SORTS = [];
    await runFrames([20, 0]);
    const framesSorts = SORTS.filter((s) => s.fromFrames);
    assert.equal(framesSorts.length, 1);
    assert.ok(framesSorts.every((s) => !s.fromPauseRing),
        'a frames sort was attributed to the pause ring: the call-site filter is broken');
});

// =============================================================================
// (b) OUTPUT PINS -- percentiles depend on the multiset, never on arrival order
// =============================================================================

test('[axis D] ascending input yields the correct order statistics via the skip path', async () => {
    // The load-bearing pin. Ascending input takes the branch that does NOT
    // sort, so if skipping were ever unsound these numbers would be wrong --
    // this asserts the skipped sort really would have been the identity.
    const { result, frameSorts } = await runFrames(SPREAD);
    assert.equal(frameSorts.length, 0, 'precondition: this run must exercise the skip path');
    assertNear(result.frameTimes.p50, EXPECT.p50, 'p50 on the skip path');
    assertNear(result.frameTimes.p95, EXPECT.p95, 'p95 on the skip path');
    assertNear(result.frameTimes.p99, EXPECT.p99, 'p99 on the skip path');
    assertNear(result.frameTimes.max, EXPECT.max, 'max on the skip path');
});

test('[axis D] shuffled input yields the same order statistics via the sort path', async () => {
    const { result, frameSorts } = await runFrames(SHUFFLED);
    assert.equal(frameSorts.length, 1, 'precondition: this run must exercise the sort path');
    assertNear(result.frameTimes.p50, EXPECT.p50, 'p50 on the sort path');
    assertNear(result.frameTimes.p95, EXPECT.p95, 'p95 on the sort path');
    assertNear(result.frameTimes.p99, EXPECT.p99, 'p99 on the sort path');
    assertNear(result.frameTimes.max, EXPECT.max, 'max on the sort path');
});

test('[axis D] the two paths agree with each other on the same multiset', async () => {
    // Stated directly rather than left as a corollary of the two pins above:
    // the branch a run happens to take must be invisible in its report.
    const ordered = await runFrames(SPREAD);
    const shuffled = await runFrames(SHUFFLED);
    assert.equal(ordered.frameSorts.length, 0);
    assert.equal(shuffled.frameSorts.length, 1);

    for (const key of ['p50', 'p95', 'p99', 'max']) {
        const a = ordered.result.frameTimes[key];
        const b = shuffled.result.frameTimes[key];
        assert.ok(Math.abs(a - b) <= TOL_MS,
            'arrival order changed ' + key + ': ' + a.toFixed(3) + ' vs ' + b.toFixed(3)
            + '. The report must be a function of the multiset alone.');
    }
});

test('[axis D] percentiles stay monotonic on both paths', async () => {
    for (const targets of [SPREAD, SHUFFLED]) {
        const { result } = await runFrames(targets);
        const f = result.frameTimes;
        assert.ok(f.p50 <= f.p95, 'p50 <= p95 violated');
        assert.ok(f.p95 <= f.p99, 'p95 <= p99 violated');
        assert.ok(f.p99 <= f.max, 'p99 <= max violated');
    }
});

test('[axis D] near-equal work-times report that value on whichever branch runs', async () => {
    // The realistic steady-state shape: a well-behaved render loop produces
    // work-times that cluster tightly and arrive in no particular order.
    // Whichever branch that lands on, the reported value must be the cluster.
    //
    // Note this does NOT pin the branch. Exact float equality is not
    // constructible through the frames lane -- six burn(8) calls yield six
    // distinct doubles -- so `<=` versus `<` in the predicate is a cost
    // question (a run of equal values would sort needlessly under `<`), not a
    // correctness one. `<=` is used because it is both cheaper and the honest
    // spelling of "non-decreasing".
    const { result } = await runFrames([8, 8, 8, 8, 8, 8]);
    assertNear(result.frameTimes.p50, 8, 'p50 on a tightly clustered window');
    assertNear(result.frameTimes.max, 8, 'max on a tightly clustered window');
    assert.ok(result.frameTimes.p50 <= result.frameTimes.max, 'p50 <= max violated');
});
