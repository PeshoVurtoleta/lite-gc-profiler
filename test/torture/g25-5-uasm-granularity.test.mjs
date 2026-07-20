// Torture tests for Batch 12 (v1.9.0), H2 -- the uasm granularity floor.
//
// THE ATTACK THIS FILE RECORDS
//
// performance.measureUserAgentSpecificMemory() reports QUANTIZED figures. The
// quantum is not contractual: it varies by browser build, by isolate, and by
// what else the page is doing. Through v1.8.0 the library treated every uasm
// reading as exact, which opened the gate in both directions on a rule that
// gates (maxAllocRate reads uasm.growthRate on source='uasm'):
//
//   FALSE PASS  -- a flat run of identical readings reports growthRate 0 and
//                  gates green. But "every reading was identical" is equally
//                  consistent with real growth finer than the quantum. The
//                  channel never demonstrated it could resolve anything, and
//                  a pass it did not earn is the worst bug in this package.
//
//   FALSE FAIL  -- a flat workload whose true footprint straddles a bucket
//                  boundary reports +1 quantum between first and last sample.
//                  Over a short window that is megabytes per second of
//                  fabricated growth, and CI goes red on a workload that
//                  allocated nothing.
//
// Both now route to 'inconclusive' -- never pass, never fail.
//
// HOW THESE TESTS DRIVE THE REAL SAMPLER
//
// Node has neither measureUserAgentSpecificMemory nor crossOriginIsolated, so
// g13-5-browser tests the GATE against hand-built uasm summaries. That is not
// enough here: H2's floor is DERIVED from the reading sequence, so the
// derivation itself has to be exercised. We install a scripted stub on
// globalThis and only THEN load Gc.js, so its module-level UASM_SUPPORTED
// constant evaluates true.
//
// Every import of Gc.js in this file is therefore dynamic and happens after the
// stub is installed. That is load-bearing twice over. Static imports are
// evaluated before a module's body runs, so a static import here would capture
// the un-stubbed environment. And the import must carry no cache-busting query
// string: a '../../Gc.js?something' URL is a SECOND module instance, and while
// the tests pass against it, node's coverage reporter cannot merge two
// instances of one file -- it reports the last one loaded and the shipped-file
// coverage gate collapses from 96% to 34% on an artifact of the test harness.
// node --test gives each file its own process, so this dynamic import is the
// first and only load of Gc.js here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- scripted uasm environment (installed before the fresh import) ----

let READINGS = [];
let READ_IDX = 0;

globalThis.crossOriginIsolated = true;
performance.measureUserAgentSpecificMemory = function () {
    // Past the end of the script, hold the last value. A test that samples more
    // times than it scripted gets a flat tail, not an undefined -> NaN cascade.
    const v = READINGS.length === 0 ? 0 : READINGS[Math.min(READ_IDX, READINGS.length - 1)];
    READ_IDX++;
    return Promise.resolve({ bytes: v, breakdown: [] });
};

const { GcProfiler, checkNoGc, compareGc, gateReps, assertNoGc, GcInconclusiveError }
    = await import('../../Gc.js');

const Q = 1048576;              // 1 MiB -- a plausible browser quantum
const STEP_MS = 100;            // sample spacing; 6 samples => a 500ms window

/** Run a scripted reading sequence through the real sampler; return the summary. */
async function runUasm(seq, opts) {
    READINGS = seq;
    READ_IDX = 0;
    const gc = new GcProfiler(64, { source: 'uasm' });
    let t = 0;
    for (let i = 0; i < seq.length; i++) {
        await gc.sampleUasm(t);
        t += (opts && opts.stepMs) || STEP_MS;
    }
    return gc.summary();
}

// Reading scripts, named for what the workload was actually doing.

/** Perfectly flat: the quantum swallowed everything, including any real growth. */
const FLAT_IDENTICAL = [100 * Q, 100 * Q, 100 * Q, 100 * Q, 100 * Q, 100 * Q];

/** Flat workload sitting on a bucket boundary: readings jitter by exactly one quantum. */
const FLAT_CROSSING_ONE_QUANTUM = [100 * Q, 100 * Q, 101 * Q, 100 * Q, 101 * Q, 101 * Q];

/** A real leak: 20 quanta over the window, every step well above the floor. */
const GENUINE_GROWTH = [100 * Q, 102 * Q, 105 * Q, 109 * Q, 114 * Q, 120 * Q];

/** A real, resolvable, clean run -- churn up and down, net displacement downward. */
const RESOLVED_AND_CLEAN = [100 * Q, 105 * Q, 98 * Q, 100 * Q, 96 * Q];

// =============================================================================
// AXIS A -- MUST produce 'inconclusive'. Never pass, never fail.
// =============================================================================

test('[axis A] flat identical readings -> inconclusive, not the old green pass', async () => {
    const s = await runUasm(FLAT_IDENTICAL);
    assert.equal(s.uasm.samples, 6);
    assert.equal(s.uasm.granularityBytes, null,
        'no non-zero step was ever observed, so there is no floor to report');
    assert.equal(s.uasm.belowGranularity, true);

    const rep = checkNoGc(s, { maxAllocRate: 1024 });
    assert.equal(rep.verdict, 'inconclusive',
        'AXIS A VIOLATION: identical quantized readings must not gate green. '
        + 'growthRate 0 here means "the channel resolved nothing", not "nothing was allocated".');
    assert.equal(rep.checked.maxAllocRate, false);
    assert.equal(rep.reason, 'uasm_below_granularity');
    assert.throws(() => assertNoGc(s, { maxAllocRate: 1024 }), GcInconclusiveError);
});

test('[axis A] flat workload crossing one quantum -> inconclusive, not a fabricated fail', async () => {
    const s = await runUasm(FLAT_CROSSING_ONE_QUANTUM);
    assert.equal(s.uasm.granularityBytes, Q, 'the smallest non-zero step IS the floor');
    assert.equal(s.uasm.belowGranularity, true,
        'net displacement of exactly one quantum is the largest thing bucketing alone can manufacture');

    // The raw rate here is ~2 MB/s of pure artifact. Against a 1 MB/s budget
    // v1.8.0 returned 'fail' on a workload that allocated nothing.
    assert.ok(s.uasm.growthRate > 1024 * 1024,
        'precondition: this sequence really does fabricate a super-budget rate');

    const rep = checkNoGc(s, { maxAllocRate: 1024 * 1024 });
    assert.equal(rep.verdict, 'inconclusive',
        'AXIS A VIOLATION: bucket jitter must not be reported as a budget violation');
    assert.equal(rep.reason, 'uasm_below_granularity');
});

test('[axis A] one sample -> inconclusive and flagged unresolved', async () => {
    const s = await runUasm([100 * Q]);
    assert.equal(s.uasm.samples, 1);
    assert.equal(s.uasm.granularityBytes, null);
    assert.equal(s.uasm.belowGranularity, true,
        'a single reading resolves nothing; the flag must agree with the sample-count gate');
    assert.equal(checkNoGc(s, { maxAllocRate: 1024 }).verdict, 'inconclusive');
});

test('[axis A] differential: an unresolved candidate poisons the delta', async () => {
    const control = await runUasm(RESOLVED_AND_CLEAN);
    const candidate = await runUasm(FLAT_CROSSING_ONE_QUANTUM);
    assert.equal(control.uasm.belowGranularity, false, 'precondition: control resolved');

    const rep = compareGc(control, candidate, { maxExtraAllocRate: 1024 });
    assert.equal(rep.verdict, 'inconclusive',
        'AXIS A VIOLATION: a delta is only as resolvable as its worse side');
    assert.equal(rep.checked.maxExtraAllocRate, false);
    assert.equal(rep.reason, 'uasm_below_granularity');
});

test('[axis A] differential: an unresolved CONTROL poisons the delta too', async () => {
    const control = await runUasm(FLAT_IDENTICAL);
    const candidate = await runUasm(RESOLVED_AND_CLEAN);
    const rep = compareGc(control, candidate, { maxExtraAllocRate: 1024 });
    assert.equal(rep.verdict, 'inconclusive',
        'AXIS A VIOLATION: an unresolved baseline cannot certify a candidate');
    assert.equal(rep.reason, 'uasm_below_granularity');
});

test('[axis A] rep gate folds belowGranularity with ANY, not majority', async () => {
    const clean1 = await runUasm(RESOLVED_AND_CLEAN);
    const clean2 = await runUasm(RESOLVED_AND_CLEAN);
    const clean3 = await runUasm(RESOLVED_AND_CLEAN);
    const blind = await runUasm(FLAT_IDENTICAL);

    // Three resolved reps and one blind one. Majority-of-reps logic would call
    // this resolved and gate it; that is how a set of runs ends up greener than
    // the runs it is made of.
    const rep = gateReps([clean1, clean2, blind, clean3], { maxAllocRate: 1024 * 1024 });
    assert.equal(rep.verdict, 'inconclusive',
        'AXIS A VIOLATION: resolved reps must not vouch for a blind one');
    assert.equal(rep.checked.maxAllocRate, false);
    assert.equal(rep.reason, 'uasm_below_granularity');
});

// =============================================================================
// AXIS B -- MUST produce 'fail'. Real signal must still be caught.
// =============================================================================

test('[axis B] genuine super-floor growth still fails', async () => {
    const s = await runUasm(GENUINE_GROWTH);
    assert.equal(s.uasm.granularityBytes, 2 * Q, 'smallest observed step is 2 quanta');
    assert.equal(s.uasm.belowGranularity, false,
        'net displacement of 20 quanta is twenty times anything bucketing can invent');

    const rep = checkNoGc(s, { maxAllocRate: 1024 * 1024 });
    assert.equal(rep.verdict, 'fail',
        'AXIS B VIOLATION: H2 must not become a blanket amnesty for the uasm lane');
    assert.equal(rep.violations.length, 1);
    assert.equal(rep.violations[0].metric, 'heap.allocRateBytesPerSec');
    assert.equal(rep.reason, undefined, 'a fail is not labelled with the granularity reason');
});

test('[axis B] growth of exactly floor+1 byte is resolvable and fails', async () => {
    // The boundary itself. gran is Q (the 100->101 step); net is Q + 1.
    const s = await runUasm([100 * Q, 101 * Q, 101 * Q + 1]);
    assert.equal(s.uasm.granularityBytes, 1, 'the +1 step is the smallest non-zero delta');
    assert.equal(s.uasm.belowGranularity, false);
    assert.equal(checkNoGc(s, { maxAllocRate: 1024 }).verdict, 'fail');
});

// =============================================================================
// AXIS C -- MUST produce 'pass'. The gate must not become useless.
// =============================================================================

test('[axis C] resolved, clean run passes untouched', async () => {
    const s = await runUasm(RESOLVED_AND_CLEAN);
    assert.equal(s.uasm.belowGranularity, false);
    const rep = checkNoGc(s, { maxAllocRate: 1024 * 1024 });
    assert.equal(rep.verdict, 'pass',
        'AXIS C VIOLATION: a channel that demonstrably resolves must still be gateable');
    assert.equal(rep.violations.length, 0);
    assert.equal(rep.reason, undefined, 'no reason key on a pass -- report shape is unchanged');
});

test('[axis C] rep gate over uniformly resolved reps passes', async () => {
    const reps = [];
    for (let i = 0; i < 3; i++) reps.push(await runUasm(RESOLVED_AND_CLEAN));
    const rep = gateReps(reps, { maxAllocRate: 1024 * 1024 });
    assert.equal(rep.verdict, 'pass');
    assert.equal(rep.reason, undefined);
});

test('[axis C] summaries predating v1.9.0 gate exactly as they did before', () => {
    // Back-compat, stated as a pin rather than left to inference. A hand-built
    // or archived summary has no belowGranularity field. Treating "field absent"
    // as "unresolved" would turn every stored v1.2.0-v1.8.0 uasm artifact
    // inconclusive overnight -- a breaking change wearing a safety fix's coat.
    // The check is `=== true`, so absence gates as it always did.
    const legacy = {
        schema: 'lite-gc/1', source: 'uasm', supported: true,
        gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, p99Ms: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 },
        heap: { supported: false, used: 0, peak: 0, firstSample: 0, samples: 0, allocBytes: 0, allocRateBytesPerSec: 0, gcDrops: 0, freedBytes: 0 },
        uasm: { supported: true, bytes: 1000, peak: 1000, firstSample: 500, samples: 5, growthRate: 1000 },
        frames: { count: 0, long: 0 }, phases: {}, byRegion: {}
    };
    assert.equal(checkNoGc(legacy, { maxAllocRate: 1024 * 1024 }).verdict, 'pass');
});

// =============================================================================
// AXIS D -- self-consistency invariants
// =============================================================================

test('[axis D] granularityBytes equals the smallest non-zero |delta| in the window', async () => {
    // Deltas: +7Q, -3Q, +11Q, -3Q. Floor must be 3Q, and it must come from the
    // magnitude -- a floor derived from signed deltas would report -3Q or pick +7Q.
    const s = await runUasm([100 * Q, 107 * Q, 104 * Q, 115 * Q, 112 * Q]);
    assert.equal(s.uasm.granularityBytes, 3 * Q);
});

test('[axis D] granularityBytes is null, never 0, when nothing resolved', async () => {
    const s = await runUasm(FLAT_IDENTICAL);
    assert.equal(s.uasm.granularityBytes, null);
    assert.notEqual(s.uasm.granularityBytes, 0,
        'null is "not measured"; 0 would claim a floor of zero bytes, i.e. perfect resolution');
    // The same rule the viewer will have to obey when it draws this field.
    assert.equal(JSON.stringify(s.uasm.granularityBytes), 'null');
});

test('[axis D] growthRate is left RAW when belowGranularity -- the flag carries the doubt', async () => {
    // Recorded deviation from the roadmap wording ("such deltas contribute zero
    // to growth"). Rewriting an unresolvable rate to a clean-looking 0 is the
    // same move as averaging a missing metric as zero, which the v1.7.1 dilution
    // guard exists to refuse. A number you must not trust beats a zero you might.
    // If this ever changes it should change deliberately, so it is pinned.
    const s = await runUasm(FLAT_CROSSING_ONE_QUANTUM);
    assert.equal(s.uasm.belowGranularity, true);
    assert.notEqual(s.uasm.growthRate, 0,
        'the measurement is preserved; only the verdict is withheld');
});

test('[axis D] the floor is windowed -- reset() does not let a resolved window vouch', async () => {
    READINGS = GENUINE_GROWTH;
    READ_IDX = 0;
    const gc = new GcProfiler(64, { source: 'uasm' });
    let t = 0;
    for (let i = 0; i < GENUINE_GROWTH.length; i++) { await gc.sampleUasm(t); t += STEP_MS; }
    assert.equal(gc.summary().uasm.belowGranularity, false, 'precondition: window one resolved');

    gc.reset();
    READINGS = FLAT_IDENTICAL;
    READ_IDX = 0;
    for (let i = 0; i < FLAT_IDENTICAL.length; i++) { await gc.sampleUasm(t); t += STEP_MS; }

    const s2 = gc.summary();
    assert.equal(s2.uasm.granularityBytes, null,
        'a floor measured in a previous window is not evidence about this one');
    assert.equal(s2.uasm.belowGranularity, true);
});

test('[axis D] the reason label appears only where it applies', async () => {
    // Present on the granularity route.
    const blind = await runUasm(FLAT_IDENTICAL);
    assert.equal(checkNoGc(blind, { maxAllocRate: 1024 }).reason, 'uasm_below_granularity');

    // Absent on an inconclusive that has nothing to do with granularity: a kind
    // rule on uasm is unanswerable whatever the resolution.
    const resolved = await runUasm(GENUINE_GROWTH);
    const kindRep = checkNoGc(resolved, { maxMajor: 0 });
    assert.equal(kindRep.verdict, 'inconclusive');
    assert.equal(kindRep.reason, undefined,
        'mislabelling an unrelated inconclusive sends the reader to the wrong fix');

    // Absent on a non-uasm source entirely.
    const heapish = { ...blind, source: 'heap' };
    assert.equal(checkNoGc(heapish, { maxAllocRate: 1024 }).reason, undefined);
});

test('[axis D] the floor gates maxAllocRate only -- it does not speak for other lanes', async () => {
    // Scoping pin. maxBytesPerOp and maxBytesPerFrame also read 'needsUasm' in
    // VERDICT_MATRIX, but their actual numbers come from heap deltas: sampleUasm
    // is async and cannot be awaited at a phase boundary. A uasm floor says
    // nothing about a heap-derived per-op figure, so it must not gate one.
    const s = await runUasm(FLAT_IDENTICAL);
    assert.equal(s.uasm.belowGranularity, true);

    // Rules the floor must NOT have moved: still inconclusive for their own
    // pre-existing reasons, and still without the granularity label.
    const kindRep = checkNoGc(s, { maxMajor: 0, maxMinor: 0, maxPauseMs: 1 });
    assert.equal(kindRep.verdict, 'inconclusive');
    assert.equal(kindRep.checked.maxMajor, false);
    assert.equal(kindRep.reason, undefined);
});

test('[axis D] a mid-window reading glitch cannot lower the floor below a real step', async () => {
    // Two identical readings in the middle produce a zero delta. Zero is not a
    // "smallest non-zero step" and must not become the floor -- a floor of 0
    // would make every net displacement resolvable and re-open the hole.
    const s = await runUasm([100 * Q, 100 * Q, 105 * Q, 105 * Q, 110 * Q]);
    assert.equal(s.uasm.granularityBytes, 5 * Q);
    assert.equal(s.uasm.belowGranularity, false, 'net 10Q over a 5Q floor is resolvable');
});
