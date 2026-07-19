// Torture scenarios for the frames aggregation primitives added in v1.8.0
// (G23, slot G24.5). Standard cases live in test/23-aggregate-frames.test.mjs.
//
// This file applies the SAME adversarial discipline the g23-5 pass applied
// to the ops aggregator, plus one extra axis for the frames-specific
// concerns:
//
//   Axis AA -- dilution: an unmeasurable context must not read the system
//              cleaner than reality by silently averaging its missing metric
//              as zero
//   Axis AB -- stability provenance: mixed present/absent must not claim
//              stability the aggregate cannot show
//   Axis AC -- adversarial inputs: NaN/Infinity, hostile getters, mixed
//              sources, huge counts, order-independence, immutability
//   Axis AD -- frames-specific: frameTimes deliberately absent from aggregate;
//              droppedFrames sums (not averages); asyncResidual sums
//   Axis R  -- real Node worker_threads round-trip: measureFrames inside a
//              worker, ship result back, aggregate on main

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    measureFrames,
    aggregateFrameReports, checkAggregateFramesReport
} from '../../Gc.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const GC_JS = resolve(HERE, '..', '..', 'Gc.js');

const noop = (i) => i | 0;
const fastSched = (cb) => setTimeout(cb, 0);

// Fully-populated synthetic report for cases where a real measureFrames
// call would be too slow or unnecessary. Every optional field present so
// dilution-guard tests can target one omission at a time.
function synth(overrides) {
    return Object.assign({
        frames: 100, source: 'gc',
        bytesPerFrame: 10, bytesPerFrameStable: true,
        majorsPerKFrame: 0, minorsPerKFrame: 0,
        maxPauseMsPerFrame: 0, droppedFrames: 0, asyncResidual: 0
    }, overrides);
}

// =============================================================================
// AXIS AA -- dilution (a missing metric cannot make the system read cleaner)
// =============================================================================

test('[axis AA] an unmeasurable metric cannot dilute a sibling toward clean', () => {
    // ctx A has real numbers; ctx B is missing majorsPerKFrame. If the
    // aggregator silently averaged B's missing metric as zero, the
    // system-wide rate would drop by half -- a passing gate on a partial
    // dataset. Dilution guard: unknown propagates.
    const withMajors = synth({ majorsPerKFrame: 10 });
    const withoutMajors = synth({ majorsPerKFrame: undefined });
    const multi = aggregateFrameReports([withMajors, withoutMajors]);
    assert.equal(multi.aggregate.majorsPerKFrame, null,
        'unknown majors from B must not dilute A\'s real 10/1000 rate toward 5/1000');
});

test('[axis AA] a diluted metric gates inconclusive, never green', () => {
    const withMajors = synth({ majorsPerKFrame: 2 });
    const withoutMajors = synth({ majorsPerKFrame: undefined });
    const multi = aggregateFrameReports([withMajors, withoutMajors]);
    // Rule limit is 5 -- the diluted-to-1 rate would pass. Aggregator
    // marks the metric unknown, gate routes to inconclusive.
    const rep = checkAggregateFramesReport(multi, { maxMajorsPerKFrame: 5 });
    assert.equal(rep.verdict, 'inconclusive',
        'a metric aggregated from partial coverage cannot yield a pass verdict');
});

test('[axis AA] the browser frames lane may not carry majors, and the aggregate must not invent them', () => {
    // Simulate two contexts from a browser lane whose source is 'heap' --
    // it cannot report majorsPerKFrame at all. Both contexts absent; the
    // aggregate is unknown, not zero.
    const rA = synth({ source: 'heap', majorsPerKFrame: undefined,
                       minorsPerKFrame: undefined, maxPauseMsPerFrame: undefined });
    const rB = synth({ source: 'heap', majorsPerKFrame: undefined,
                       minorsPerKFrame: undefined, maxPauseMsPerFrame: undefined });
    const multi = aggregateFrameReports([rA, rB]);
    assert.equal(multi.aggregate.majorsPerKFrame, null);
    assert.equal(multi.aggregate.minorsPerKFrame, null);
    assert.equal(multi.aggregate.maxPauseMsPerFrame, null);
});

test('[axis AA] fully-populated inputs still aggregate as weighted numbers', () => {
    // Guard against overcorrection: a fully-populated input set must
    // produce numeric aggregates, not null. If the dilution logic is
    // wrong, this fails and everything else looks fine.
    const rA = synth({ frames: 200, majorsPerKFrame: 5, minorsPerKFrame: 10 });
    const rB = synth({ frames: 800, majorsPerKFrame: 10, minorsPerKFrame: 20 });
    const multi = aggregateFrameReports([rA, rB]);
    assert.equal(typeof multi.aggregate.majorsPerKFrame, 'number');
    assert.equal(typeof multi.aggregate.minorsPerKFrame, 'number');
    // (5*200 + 10*800)/1000 = 9 majors/K, (10*200 + 20*800)/1000 = 18 minors/K
    assert.ok(Math.abs(multi.aggregate.majorsPerKFrame - 9) < 1e-9);
    assert.ok(Math.abs(multi.aggregate.minorsPerKFrame - 18) < 1e-9);
});

// =============================================================================
// AXIS AB -- stability provenance
// =============================================================================

test('[axis AB] a mixed stability set does not claim stability', () => {
    // Some contexts report bytesPerFrameStable, others do not. The
    // aggregator cannot certify a flag half the inputs did not carry.
    const rA = synth({ bytesPerFrameStable: true });
    const rB = synth({ bytesPerFrameStable: undefined });
    const multi = aggregateFrameReports([rA, rB]);
    assert.equal(multi.aggregate.bytesPerFrameStable, false,
        'aggregate must not claim stability with unknown provenance from a silent context');
});

test('[axis AB] an all-absent stability set stays true (legacy lanes only)', () => {
    // If NO context reports the flag, there is no provenance to lose.
    // All-absent is the case of a fully-legacy input set and stays true.
    const rA = synth({ bytesPerFrameStable: undefined });
    const rB = synth({ bytesPerFrameStable: undefined });
    const multi = aggregateFrameReports([rA, rB]);
    assert.equal(multi.aggregate.bytesPerFrameStable, true);
});

test('[axis AB] one false anywhere degrades to false, regardless of provenance', () => {
    const rA = synth({ bytesPerFrameStable: true });
    const rB = synth({ bytesPerFrameStable: false });
    const rC = synth({ bytesPerFrameStable: true });
    const multi = aggregateFrameReports([rA, rB, rC]);
    assert.equal(multi.aggregate.bytesPerFrameStable, false);
});

// =============================================================================
// AXIS AC -- adversarial inputs
// =============================================================================

test('[axis AC] NaN bytesPerFrame in any context does not yield a pass', () => {
    const rA = synth({ bytesPerFrame: NaN });
    const rB = synth({ bytesPerFrame: 10 });
    const multi = aggregateFrameReports([rA, rB]);
    const rep = checkAggregateFramesReport(multi, { maxBytesPerFrame: 100 });
    assert.notEqual(rep.verdict, 'pass',
        'NaN in per-context bytesPerFrame must not yield pass');
});

test('[axis AC] Infinity droppedFrames routes to inconclusive at the gate', () => {
    const rA = synth({ droppedFrames: Infinity });
    const rB = synth({ droppedFrames: 5 });
    const multi = aggregateFrameReports([rA, rB]);
    const rep = checkAggregateFramesReport(multi, { maxDroppedFrames: 100 });
    assert.notEqual(rep.verdict, 'pass');
});

test('[axis AC] a lying getter is observed exactly once per metric', () => {
    let reads = 0;
    const evil = {
        frames: 100, source: 'gc',
        get bytesPerFrame() { reads++; return reads === 1 ? 10 : 999999; },
        bytesPerFrameStable: true, majorsPerKFrame: 0, minorsPerKFrame: 0,
        maxPauseMsPerFrame: 0, droppedFrames: 0, asyncResidual: 0
    };
    const multi = aggregateFrameReports([evil]);
    assert.equal(multi.aggregate.bytesPerFrame, 10,
        'aggregator must read metric fields once, not re-sample under the gate');
});

test('[axis AC] aggregation is order-independent', () => {
    const rA = synth({ frames: 100, bytesPerFrame: 10, droppedFrames: 3 });
    const rB = synth({ frames: 200, bytesPerFrame: 20, droppedFrames: 5 });
    const rC = synth({ frames: 300, bytesPerFrame: 30, droppedFrames: 7 });
    const abc = aggregateFrameReports([rA, rB, rC]).aggregate;
    const cba = aggregateFrameReports([rC, rB, rA]).aggregate;
    const bac = aggregateFrameReports([rB, rA, rC]).aggregate;
    assert.ok(Math.abs(abc.bytesPerFrame - cba.bytesPerFrame) < 1e-9);
    assert.ok(Math.abs(abc.bytesPerFrame - bac.bytesPerFrame) < 1e-9);
    assert.equal(abc.droppedFrames, cba.droppedFrames);
    assert.equal(abc.totalFrames, cba.totalFrames);
});

test('[axis AC] aggregation does not mutate its inputs', () => {
    const rA = synth({ frames: 100, bytesPerFrame: 10 });
    const rB = synth({ frames: 200, bytesPerFrame: 20 });
    const before = { rAFrames: rA.frames, rABpf: rA.bytesPerFrame,
                     rBFrames: rB.frames, rBBpf: rB.bytesPerFrame };
    aggregateFrameReports([rA, rB]);
    assert.equal(rA.frames, before.rAFrames);
    assert.equal(rA.bytesPerFrame, before.rABpf);
    assert.equal(rB.frames, before.rBFrames);
    assert.equal(rB.bytesPerFrame, before.rBBpf);
});

test('[axis AC] mixed sources refuse to fabricate a comparable verdict', () => {
    const rA = synth({ source: 'gc' });
    const rB = synth({ source: 'heap' });
    const multi = aggregateFrameReports([rA, rB]);
    assert.equal(multi.aggregate.source, 'mixed');
    const rep = checkAggregateFramesReport(multi, { maxDroppedFrames: 0 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.reason, 'source_mismatch');
});

test('[axis AC] a genuinely over-budget aggregate still fails cleanly', () => {
    // Guard against the dilution guard being over-eager: legitimate
    // failures must still be flagged as fails.
    const rA = synth({ frames: 100, droppedFrames: 50 });
    const rB = synth({ frames: 100, droppedFrames: 50 });
    const multi = aggregateFrameReports([rA, rB]);
    // Sum is 100; limit is 10 -- must fail, not inconclusive.
    const rep = checkAggregateFramesReport(multi, { maxDroppedFrames: 10 });
    assert.equal(rep.verdict, 'fail');
    assert.equal(rep.violations[0].actual, 100);
});

// =============================================================================
// AXIS AD -- frames-specific semantic pins
// =============================================================================

test('[axis AD] frameTimes are deliberately absent from the aggregate object', async () => {
    const r1 = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const r2 = await measureFrames(noop, { frames: 30, scheduler: fastSched });
    const multi = aggregateFrameReports([r1, r2]);
    assert.equal(multi.aggregate.frameTimes, undefined,
        'frameTimes must NOT appear in aggregate -- percentiles are not compositional');
    assert.ok(multi.perContext[0].frameTimes,
        'perContext preserves per-context frameTimes for manual inspection');
});

test('[axis AD] droppedFrames sums across contexts, not averages', () => {
    // Ten contexts each dropping one frame is ten dropped frames total,
    // not "an average of one." A gate on total system health needs the sum.
    const contexts = [];
    for (let i = 0; i < 10; i++) contexts.push(synth({ droppedFrames: 1 }));
    const multi = aggregateFrameReports(contexts);
    assert.equal(multi.aggregate.droppedFrames, 10);
});

test('[axis AD] asyncResidual sums across contexts', () => {
    const rA = synth({ asyncResidual: 1024 });
    const rB = synth({ asyncResidual: 2048 });
    const rC = synth({ asyncResidual: 4096 });
    const multi = aggregateFrameReports([rA, rB, rC]);
    assert.equal(multi.aggregate.asyncResidual, 7168);
});

// =============================================================================
// AXIS R -- real Node worker_threads round-trip
// =============================================================================

test('[axis R] real Node worker_thread frames result survives structured clone and aggregates', async () => {
    // Spawn two Node worker_threads workers, each runs measureFrames
    // against a fast-sched polyfill scheduler (rAF not available in
    // node workers). Ship results back via postMessage, aggregate on
    // main. Pins:
    //   1. measureFrames works inside a Node worker (perf_hooks
    //      inherited, setTimeout polyfill scheduler picks up)
    //   2. The frames result shape (with nested frameTimes and summary
    //      tree) survives Node structured clone
    //   3. The aggregator handles genuine cross-context frame results

    const dir = mkdtempSync(join(tmpdir(), 'lite-gc-g24-5-'));
    const workerPath = join(dir, 'worker.mjs');
    writeFileSync(workerPath, [
        "import { measureFrames } from " + JSON.stringify(GC_JS) + ";",
        "import { parentPort } from 'node:worker_threads';",
        "const fastSched = (cb) => setTimeout(cb, 0);",
        "const result = await measureFrames((i) => i | 0,",
        "    { frames: 30, warmup: 5, scheduler: fastSched });",
        "parentPort.postMessage(result);",
        ""
    ].join('\n'));

    async function runOne() {
        return new Promise((res, rej) => {
            // Workers inherit --expose-gc from parent; do not pass execArgv.
            const w = new Worker(workerPath);
            w.once('message', (m) => { w.terminate(); res(m); });
            w.once('error', (e) => rej(e));
        });
    }

    const reports = await Promise.all([runOne(), runOne()]);
    assert.equal(reports.length, 2);
    for (const r of reports) {
        assert.equal(r.schema, 'lite-gc-frames/1',
            'frames schema must survive structured clone');
        assert.equal(r.frames, 30);
        assert.equal(typeof r.source, 'string');
        assert.ok(r.frameTimes, 'frameTimes structure must survive clone');
        assert.ok(r.summary, 'summary tree must survive clone');
    }

    const multi = aggregateFrameReports(reports);
    assert.equal(multi.contexts, 2);
    assert.equal(multi.aggregate.totalFrames, 60);
    // Two noop workloads across two contexts should not drop any frames
    // under a fast-sched polyfill scheduler.
    const rep = checkAggregateFramesReport(multi, { maxDroppedFrames: 10 });
    assert.equal(rep.verdict, 'pass',
        'two noop workloads across two Node worker_thread contexts must pass a permissive gate; got '
        + rep.verdict);
});
