// Self-noise calibration for v1.1.0 (G3).
//
// The profiler's own presence has a footprint: PerformanceObserver receives
// node-allocated entry lists, and every attached observer costs something.
// This test measures that footprint against a pure zero-alloc noop loop and
// asserts:
//
//   (a) zero majors -- HARD invariant. If the profiler itself causes a
//       full-heap collection, the entire gate is compromised: any user
//       "zero-major" claim would be poisoned by our observer's own churn.
//   (b) minors, longest pause, heap growth -- documented as the ceiling
//       the profiler contributes. These numbers go in the README so users
//       know what to subtract from ambient measurements.
//
// The bounds asserted here are the ones we're willing to publish as guarantees.
// If they tighten in a later version, update the numbers here and in the README.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GcProfiler } from '../Gc.js';

// Documented ceiling for the profiler's own contribution over a ~500ms window.
// The heap-growth number is a regression sentinel only. It's noisy because
// most of it comes from V8 runtime state (JIT code cache, timer queue, ambient
// promise/microtask allocation) rather than the profiler itself. The honest
// measurement of profiler-only heap contribution requires a differential
// against a control run without the profiler -- that lands in G4 as compareGc.
// For G3, we assert only the strict claims: zero majors, bounded minors,
// bounded pause. The heap number is printed for documentation.
const SELF_NOISE_MAX_MAJORS = 0;                // hard: any major fails the gate
const SELF_NOISE_MAX_MINORS = 5;                // observer batches can trigger scavenges
const SELF_NOISE_MAX_PAUSE_MS = 2;              // any single pause > 2ms flags perturbation
const SELF_NOISE_MAX_HEAP_GROWTH_BYTES = 4 * 1024 * 1024;   // 4 MB regression sentinel

test('self-noise: profiler contributes zero majors over 500ms noop', async () => {
    const gc = new GcProfiler().start();
    // Prime V8: run the loop once cold so JIT warmup doesn't count against us.
    let x = 0;
    for (let i = 0; i < 1e6; i++) x = i * 1.000001;
    if (global.gc) global.gc();
    // The forced global.gc() delivers its entry asynchronously; settle before
    // resetting or that entry lands in the measured window as a false major.
    await gc.settle();

    const beforeHeap = process.memoryUsage().heapUsed;
    gc.reset();                                  // discard prime measurements

    // Zero-alloc noop loop. Just numeric ops, no object creation, no closures.
    const t0 = performance.now();
    while (performance.now() - t0 < 500) {
        for (let i = 0; i < 1e5; i++) x = i * 1.000001;
    }

    const r = await gc.settle();
    assert.equal(r.drained, true, 'settle should drain within maxWaitMs');

    const s = gc.summary();
    const afterHeap = process.memoryUsage().heapUsed;
    const heapGrowth = afterHeap - beforeHeap;

    // Print the numbers so Zahary can copy them into the README.
    // These are informational, not part of the assertion:
    process.stderr.write(
        '\n  --- self-noise numbers (500ms noop, ' + s.source + ' source) ---\n'
        + '    majors:       ' + s.gc.major + '\n'
        + '    minors:       ' + s.gc.minor + '\n'
        + '    incremental:  ' + s.gc.incremental + '\n'
        + '    weakcb:       ' + s.gc.weakcb + '\n'
        + '    totalPause:   ' + s.gc.totalMs.toFixed(3) + ' ms\n'
        + '    longestPause: ' + s.gc.maxMs.toFixed(3) + ' ms\n'
        + '    p99Pause:     ' + s.gc.p99Ms.toFixed(3) + ' ms\n'
        + '    heapGrowth:   ' + heapGrowth + ' bytes\n'
        + '    settleWaited: ' + r.waited.toFixed(2) + ' ms\n'
        + '  --------------------------------------------------------\n'
        + '  (' + x + ' -- keep-alive)\n\n'
    );

    // Assertions -- the strict claim.
    assert.ok(
        s.gc.major <= SELF_NOISE_MAX_MAJORS,
        'profiler self-noise exceeded major ceiling: ' + s.gc.major
            + ' > ' + SELF_NOISE_MAX_MAJORS
            + ' (a single self-induced major poisons all zero-major user claims)'
    );
    assert.ok(
        s.gc.minor <= SELF_NOISE_MAX_MINORS,
        'profiler self-noise exceeded minor ceiling: ' + s.gc.minor
            + ' > ' + SELF_NOISE_MAX_MINORS
    );
    assert.ok(
        s.gc.maxMs <= SELF_NOISE_MAX_PAUSE_MS,
        'profiler self-noise exceeded pause ceiling: ' + s.gc.maxMs
            + ' > ' + SELF_NOISE_MAX_PAUSE_MS + 'ms'
    );
    assert.ok(
        heapGrowth <= SELF_NOISE_MAX_HEAP_GROWTH_BYTES,
        'profiler self-noise exceeded heap-growth ceiling: ' + heapGrowth
            + ' > ' + SELF_NOISE_MAX_HEAP_GROWTH_BYTES + ' bytes'
    );

    gc.stop();
});

test('self-noise: sampleHeap during a noop loop does not add majors', async () => {
    const gc = new GcProfiler().start();
    let x = 0;
    for (let i = 0; i < 1e6; i++) x = i * 1.000001;
    if (global.gc) global.gc();
    await gc.settle();                           // drain pre-reset entries
    gc.reset();

    const t0 = performance.now();
    while (performance.now() - t0 < 200) {
        for (let i = 0; i < 1e4; i++) x = i * 1.000001;
        gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }

    await gc.settle();
    const s = gc.summary();
    assert.equal(s.gc.major, 0, 'sampleHeap-during-noop must not induce majors');
    assert.ok(s.heap.samples > 0, 'samples should have accumulated');
    // Keep-alive
    assert.ok(x > 0);
    gc.stop();
});

test('self-noise: phase transitions during a noop loop do not add majors', async () => {
    const gc = new GcProfiler().start();
    let x = 0;
    for (let i = 0; i < 1e6; i++) x = i * 1.000001;
    if (global.gc) global.gc();
    await gc.settle();                           // drain pre-reset entries
    gc.reset();

    gc.phase('a');
    const t0 = performance.now();
    let toggle = 0;
    // Toggle phases many times; stay under the 1024 boundary cap.
    while (performance.now() - t0 < 200 && toggle < 500) {
        for (let i = 0; i < 1e4; i++) x = i * 1.000001;
        gc.phase(toggle & 1 ? 'a' : 'b');
        toggle++;
    }

    await gc.settle();
    const s = gc.summary();
    assert.equal(s.gc.major, 0, 'phase transitions must not induce majors');
    assert.ok(x > 0);
    gc.stop();
});
