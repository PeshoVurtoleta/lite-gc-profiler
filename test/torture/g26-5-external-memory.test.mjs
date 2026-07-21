// Torture tests for Batch 13 (v1.10.0): G25 external-memory channel, and the
// forced-GC provenance micro-candidate.
//
// THE BLIND SPOT G25 CLOSES
//
// ArrayBuffer backing stores live OUTSIDE the V8 heap. They are tracked in
// process.memoryUsage().external / .arrayBuffers, and are invisible to
// heapUsed -- which is the only number maxAllocRate has ever gated on.
// Measured on node 22: 300 retained Float64Array(4096) is 9.375 MB of backing
// store and moves heapUsed by 0.062 MB. A 152x blind spot, in the measurement
// channel behind the package's headline claim. The ecosystem's signature data
// structure is a preallocated typed-array ring, so this is not a hypothetical.
//
// WHY THE GATE NEEDS A SETTLE PROTOCOL
//
// A single forced collection does not reliably reclaim backing stores
// allocated shortly before it. Measured, same fixture, separate processes:
// -0.20 MB growth on one run, +9.17 MB on the next. Gating that would produce
// flaky false fails at full magnitude. So a sample counts as settled only when
// two forced collections preceded it, `arrayBuffers.settled` reports whether
// the window was, and maxArrayBuffersGrowth routes to inconclusive when it was
// not -- the same shape as H2's granularity floor, for the same reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GcProfiler, measureOps, measureFrames, measureOpsAsync, checkNoGc, gateReps } from '../../Gc.js';

const MB = 1048576;
const HAS_MU = typeof process !== 'undefined' && typeof process.memoryUsage === 'function';

/** Drive a workload through a hand-rolled settled window. */
function runSettled(workload, opts) {
    const settle = !(opts && opts.settle === false);
    const gc = new GcProfiler(256, { source: 'gc' });
    if (settle) gc.forceSettle();
    let mu = process.memoryUsage();
    gc.sampleHeap(performance.now(), mu.heapUsed, mu);
    workload();
    if (settle) gc.forceSettle();
    mu = process.memoryUsage();
    gc.sampleHeap(performance.now(), mu.heapUsed, mu);
    return gc.summary();
}

// maxAllocRate is a RATE -- allocBytes * 1000 / elapsedMs -- and these windows
// are a few milliseconds long, so its denominator is "how fast does this host
// run the loop". Measured on one box, the identical workload below produced
// 31, 11 and 5 MB/s across three consecutive runs (windows of 3.9, 5.9 and
// 13.1 ms). A plausible-looking 200 MB/s limit is therefore not a budget, it
// is a hardware detector: on a machine a few times faster it fires, adds a
// second violation, and turns every 'inconclusive' assertion in this file into
// 'fail' and axis B's exactly-one-violation pin into two. That is precisely
// what happened on an M4.
//
// So the co-rule is present but deliberately unreachable. Axis B still pins
// the conjunction that matters -- exactly one rule fires, and it is the
// external one -- while the substantive claim, that heapUsed barely moves for
// a multi-MB backing-store leak, is measured directly in bytes by the sibling
// axis B test rather than inferred from a threshold.
const UNREACHABLE_RATE = 1e15;                  // bytes/sec; no host reaches this
const RULES = { maxAllocRate: UNREACHABLE_RATE, maxArrayBuffersGrowth: 1 * MB };

// Routing assertions gate ONLY the rule whose routing is under test. A second
// rule that can fail on its own does not make them stricter, it makes them
// answer a different question.
const AB_ONLY = { maxArrayBuffersGrowth: 1 * MB };

// =============================================================================
// AXIS B -- the leak the old gate could not see MUST fail
// =============================================================================

test('[axis B] a retained ArrayBuffer ring fails the new rule while passing maxAllocRate', { skip: !HAS_MU }, () => {
    const ring = [];
    const s = runSettled(() => { for (let i = 0; i < 300; i++) ring.push(new Float64Array(4096)); });

    // The pin is the CONJUNCTION. Either half alone proves nothing: a rule that
    // fires when maxAllocRate also fires has added no coverage.
    const rep = checkNoGc(s, RULES);
    assert.equal(rep.checked.maxAllocRate, true, 'precondition: the heap rule was verifiable');
    assert.equal(rep.verdict, 'fail');
    assert.equal(rep.violations.length, 1, 'exactly one rule should have fired');
    assert.equal(rep.violations[0].metric, 'arrayBuffers.growthBytes',
        'AXIS B VIOLATION: the leak must be caught by the external rule, not the heap rule');
    assert.ok(s.arrayBuffers.growthBytes > 8 * MB, 'the growth should be most of the 9.4 MB allocated');
    assert.ok(ring.length === 300);
});

test('[axis B] the blind spot is real -- heapUsed barely moves for a multi-MB backing-store leak', { skip: !HAS_MU }, () => {
    const ring = [];
    const s = runSettled(() => { for (let i = 0; i < 300; i++) ring.push(new Float64Array(4096)); });
    // If this ratio ever collapses toward 1, node has started accounting
    // backing stores inside heapUsed and G25's premise needs re-examining.
    const hidden = s.arrayBuffers.growthBytes / Math.max(1, s.heap.allocBytes);
    assert.ok(hidden > 5,
        'expected external growth to dwarf heap growth; got ratio ' + hidden.toFixed(1)
        + '. If node now counts backing stores in heapUsed, this rule is redundant.');
    assert.ok(ring.length === 300);
});

// =============================================================================
// AXIS C -- clean workloads MUST pass, deterministically
// =============================================================================

test('[axis C] transient backing stores pass -- allocation is not retention', { skip: !HAS_MU }, () => {
    const s = runSettled(() => {
        for (let i = 0; i < 300; i++) { const t = new Float64Array(4096); t[0] = i; }
    });
    assert.equal(s.arrayBuffers.settled, true);
    const rep = checkNoGc(s, AB_ONLY);
    assert.equal(rep.verdict, 'pass',
        'AXIS C VIOLATION: 9.4 MB allocated and dropped is not a leak, and the '
        + 'rule must not punish churn. Got growthBytes=' + s.arrayBuffers.growthBytes);
});

test('[axis C] measureOps stabilize:deep is deterministic across repeated runs', { skip: !HAS_MU }, () => {
    // The flakiness this protocol exists to remove. Three runs in one process;
    // under plain stabilize the same fixture has produced both -0.2 MB and
    // +9.2 MB.
    const verdicts = [];
    for (let run = 0; run < 3; run++) {
        const r = measureOps((i) => { const t = new Float64Array(1024); t[0] = i; },
            { ops: 200, warmup: 50, stabilize: 'deep' });
        assert.equal(r.summary.arrayBuffers.settled, true, 'deep mode must produce settled samples');
        verdicts.push(checkNoGc(r.summary, AB_ONLY).verdict);
    }
    assert.deepEqual(verdicts, ['pass', 'pass', 'pass'],
        'AXIS C VIOLATION: a settled channel must not flap. Got ' + verdicts.join(', '));
});

// =============================================================================
// AXIS A -- unverifiable states MUST be inconclusive, never pass, never fail
// =============================================================================

test('[axis A] an unsettled window routes to inconclusive rather than reporting a flaky number', { skip: !HAS_MU }, () => {
    const ring = [];
    const s = runSettled(() => { for (let i = 0; i < 300; i++) ring.push(new Float64Array(4096)); },
        { settle: false });
    assert.equal(s.arrayBuffers.settled, false);
    assert.ok(s.arrayBuffers.samples >= 2, 'samples alone are not sufficient here');

    const rep = checkNoGc(s, AB_ONLY);
    assert.equal(rep.verdict, 'inconclusive',
        'AXIS A VIOLATION: two samples without two collections each is not evidence');
    assert.equal(rep.checked.maxArrayBuffersGrowth, false);
    assert.ok(ring.length === 300);
});

test('[axis A] a window that never sampled memoryUsage is unsupported, not zero-growth', { skip: !HAS_MU }, () => {
    // The old two-argument call. The channel must report "not measured", and
    // the gate must refuse -- reporting growthBytes 0 here would be a green
    // pass on a workload nobody looked at.
    const gc = new GcProfiler(256, { source: 'gc' });
    gc.forceSettle(); gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    gc.forceSettle(); gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    const s = gc.summary();

    assert.equal(s.arrayBuffers.supported, false);
    assert.equal(s.arrayBuffers.samples, 0);
    assert.equal(checkNoGc(s, AB_ONLY).verdict, 'inconclusive');
});

test('[axis A] a half-settled window is unsettled -- AND, not OR', { skip: !HAS_MU }, () => {
    const gc = new GcProfiler(256, { source: 'gc' });
    gc.forceSettle();
    let mu = process.memoryUsage();
    gc.sampleHeap(performance.now(), mu.heapUsed, mu);          // settled
    mu = process.memoryUsage();
    gc.sampleHeap(performance.now(), mu.heapUsed, mu);          // NOT settled
    const s = gc.summary();
    assert.equal(s.arrayBuffers.settled, false,
        'AXIS A VIOLATION: a delta is only as settled as its worse end');
});

test('[axis A] rep gating requires every rep to have sampled the channel', { skip: !HAS_MU }, () => {
    const withChannel = runSettled(() => {});
    const withoutChannel = (() => {
        const gc = new GcProfiler(256, { source: 'gc' });
        gc.forceSettle(); gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
        gc.forceSettle(); gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
        return gc.summary();
    })();

    const clean = gateReps([withChannel, withChannel], { maxArrayBuffersGrowth: 1 * MB });
    assert.equal(clean.checked.maxArrayBuffersGrowth, true, 'precondition: uniform reps gate');

    const mixed = gateReps([withChannel, withoutChannel, withChannel], { maxArrayBuffersGrowth: 1 * MB });
    assert.equal(mixed.verdict, 'inconclusive',
        'AXIS A VIOLATION: reps that sampled must not vouch for one that did not');
    assert.equal(mixed.checked.maxArrayBuffersGrowth, false);
});

// =============================================================================
// AXIS D -- shape, scope and honesty invariants
// =============================================================================

test('[axis D] maxExternalGrowth is rejected with the measurement that disqualified it', () => {
    // `external` is reported but not gateable: after a window that allocated
    // and correctly dropped ~12 MB of typed arrays, the NEXT window's external
    // delta still read the full ~12 MB while arrayBuffers read ~0. Anyone
    // reaching for this rule read the roadmap; they get the finding, not a shrug.
    assert.throws(
        () => checkNoGc({ source: 'gc', gc: {}, heap: { samples: 2 } }, { maxExternalGrowth: 1024 }),
        (e) => {
            assert.ok(e instanceof TypeError);
            assert.match(e.message, /deliberately not gateable/);
            assert.match(e.message, /arrayBuffers/, 'name the rule to use instead');
            return true;
        }
    );
});

test('[axis D] the external block is reported and marked ungateable', { skip: !HAS_MU }, () => {
    const s = runSettled(() => {});
    assert.equal(s.external.supported, true, 'diagnosis still needs the number');
    assert.equal(s.external.gateable, false,
        'the block must say so in the envelope, not only in the docs -- a viewer '
        + 'reads the envelope');
});

test("[axis D] stabilize:'deep' is rejected, not downgraded, where unsupported", async () => {
    // Silent downgrade would be the fail-open: plain stabilize produces
    // unsettled samples, so the rule would read numbers that flap.
    assert.throws(() => measureFrames(() => {}, { frames: 2, stabilize: 'deep' }),
        (e) => e instanceof RangeError && /measureOps-only/.test(e.message));
    await assert.rejects(() => measureOpsAsync(async () => {}, { ops: 2, stabilize: 'deep' }),
        (e) => e instanceof RangeError && /measureOps-only/.test(e.message));
});

test('[axis D] the external rule is node-only and the matrix says so', () => {
    const base = {
        gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, p99Ms: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 },
        heap: { supported: true, samples: 5, allocBytes: 0, allocRateBytesPerSec: 0 },
        uasm: { supported: false, samples: 0, growthRate: 0, granularityBytes: null, belowGranularity: true },
        arrayBuffers: { supported: true, bytes: 0, peak: 0, firstSample: 0, samples: 5, growthBytes: 0, settled: true },
        external: { supported: true, bytes: 0, peak: 0, firstSample: 0, samples: 5, growthBytes: 0, gateable: false },
        frames: { count: 0, long: 0 }, phases: {}, byRegion: {}
    };
    // Chrome's performance.memory has no external field; uasm folds external
    // memory into one total it cannot decompose. Neither may pretend.
    for (const src of ['heap', 'uasm', 'none']) {
        const rep = checkNoGc({ ...base, source: src }, { maxArrayBuffersGrowth: 1024 });
        assert.equal(rep.verdict, 'inconclusive', src + ' must not gate an external rule');
        assert.equal(rep.checked.maxArrayBuffersGrowth, false);
    }
    assert.equal(checkNoGc({ ...base, source: 'gc' }, { maxArrayBuffersGrowth: 1024 }).verdict, 'pass');
});

test('[axis D] the channel is windowed -- reset() drops settle state and samples', { skip: !HAS_MU }, () => {
    const gc = new GcProfiler(256, { source: 'gc' });
    gc.forceSettle();
    let mu = process.memoryUsage();
    gc.sampleHeap(performance.now(), mu.heapUsed, mu);
    gc.forceSettle();
    mu = process.memoryUsage();
    gc.sampleHeap(performance.now(), mu.heapUsed, mu);
    assert.equal(gc.summary().arrayBuffers.settled, true);

    gc.reset();
    const s = gc.summary();
    assert.equal(s.arrayBuffers.supported, false, 'a previous window is not evidence about this one');
    assert.equal(s.arrayBuffers.samples, 0);
});

test('[axis D] a mocked memoryUsage cannot poison the channel with non-finite readings', { skip: !HAS_MU }, () => {
    const gc = new GcProfiler(256, { source: 'gc' });
    gc.forceSettle();
    gc.sampleHeap(1, 1000, { external: 5000, arrayBuffers: 4000 });
    gc.forceSettle();
    gc.sampleHeap(2, 1000, { external: NaN, arrayBuffers: NaN });   // dropped
    gc.forceSettle();
    gc.sampleHeap(3, 1000, { external: 9000, arrayBuffers: 8000 });
    const s = gc.summary();
    assert.equal(s.arrayBuffers.growthBytes, 4000,
        'growth must be measured against the last VALID reading, not against NaN');
    assert.ok(Number.isFinite(s.external.growthBytes));
});

// =============================================================================
// Forced-GC provenance
// =============================================================================

test('[axis D] foreignForced is zero when only the library forces collections', { skip: !HAS_MU }, () => {
    const gc = new GcProfiler(256, { source: 'gc' });
    gc.forceSettle();
    const s = gc.summary();
    // A raw `forced` count would be useless here: the library's own anchors
    // are indistinguishable from a caller's stray gc() by time window alone.
    // The library knows how many it caused, so it subtracts them.
    assert.equal(s.gc.ownForced, 2, 'forceSettle performs exactly two collections');
    assert.equal(s.gc.foreignForced, 0);
});

test('[axis D] foreignForced never goes negative', { skip: !HAS_MU }, () => {
    // The one-entry-per-forced-collection relationship is empirical (verified
    // on node 22), not contractual. A build that emitted two entries per call,
    // or an observer that has not flushed yet, must read as "none foreign" --
    // never as a negative count that a viewer would draw below the axis.
    const gc = new GcProfiler(256, { source: 'gc' });
    gc.forceSettle(); gc.forceSettle();
    const s = gc.summary();
    assert.ok(s.gc.foreignForced >= 0, 'got ' + s.gc.foreignForced);
    assert.ok(s.gc.ownForced >= 4);
});
