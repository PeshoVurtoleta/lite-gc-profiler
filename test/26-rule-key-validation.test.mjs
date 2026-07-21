// v1.10.0: unknown rule keys on the checkNoGc lane.
//
// The ops and frames lanes have rejected unknown keys since v1.5.1. checkNoGc
// -- the package's PRIMARY lane -- did not. It read the property names it knew
// and ignored everything else, so a plural typo:
//
//     checkNoGc(summary, { maxMajors: 0 })
//
// returned verdict 'pass' with an empty `checked` map. A gate that verified
// nothing, reporting green. llms.txt had claimed the rejecting behaviour was
// universal since v1.5.1, so the documentation was writing cheques the primary
// lane did not honour.
//
// Same class as H2 and found the same way: by writing the test that would have
// caught it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNoGc, assertNoGc } from '../Gc.js';

const SUMMARY = {
    schema: 'lite-gc/1', source: 'gc', supported: true,
    gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, p99Ms: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 },
    heap: { supported: true, used: 0, peak: 0, firstSample: 0, samples: 5, allocBytes: 0, allocRateBytesPerSec: 0, gcDrops: 0, freedBytes: 0 },
    uasm: { supported: false, bytes: 0, peak: 0, firstSample: 0, samples: 0, growthRate: 0, granularityBytes: null, belowGranularity: true },
    arrayBuffers: { supported: false, bytes: 0, peak: 0, firstSample: 0, samples: 0, growthBytes: 0, settled: false },
    external: { supported: false, bytes: 0, peak: 0, firstSample: 0, samples: 0, growthBytes: 0, gateable: false },
    frames: { count: 0, long: 0 }, phases: { warmup: { gc: { major: 0, minor: 0, maxMs: 0, totalMs: 0 } } }, byRegion: {}
};

test('a typo in a rule name throws instead of passing vacuously', () => {
    assert.throws(() => checkNoGc(SUMMARY, { maxMajors: 0 }), TypeError);
    assert.throws(() => checkNoGc(SUMMARY, { maxmajor: 0 }), TypeError);
    assert.throws(() => checkNoGc(SUMMARY, { maxPause: 5 }), TypeError);
});

test('the typo error suggests the rule that was meant', () => {
    try {
        checkNoGc(SUMMARY, { maxMajors: 0 });
        assert.fail('should have thrown');
    } catch (e) {
        assert.match(e.message, /Did you mean maxMajor\?/);
        assert.match(e.message, /pass everything/, 'say WHY the key is rejected');
    }
});

test('a typo nested under phases is caught too', () => {
    // Equally silent before: the phase loop only copied keys already present
    // in VERDICT_MATRIX, so a typo inside a phase evaporated.
    assert.throws(
        () => checkNoGc(SUMMARY, { phases: { warmup: { maxMajorz: 0 } } }),
        (e) => e instanceof TypeError && /under phases\.warmup/.test(e.message)
    );
});

test('a typo nested under perRegion is caught too', () => {
    assert.throws(
        () => checkNoGc(SUMMARY, { perRegion: { draw: { maxPauseMsz: 1 } } }),
        (e) => e instanceof TypeError && /under perRegion\.draw/.test(e.message)
    );
});

test('structural keys and every real rule still pass validation', () => {
    // The guard must not become the new fail-closed bug.
    assert.equal(checkNoGc(SUMMARY, { maxMajor: 0 }).verdict, 'pass');
    assert.equal(checkNoGc(SUMMARY, { phases: { warmup: { maxMajor: 0 } } }).verdict, 'pass');
    assert.equal(checkNoGc(SUMMARY, { maxMajor: 0, phases: {}, perRegion: {} }).verdict, 'pass');
    assert.equal(checkNoGc(SUMMARY, undefined).verdict, 'pass', 'the default rules must survive');
    assert.equal(checkNoGc(SUMMARY, { maxMajor: undefined, maxMinor: 0 }).verdict, 'pass',
        'explicit undefined means "rule omitted", as everywhere else');
});

test('assertNoGc surfaces the same rejection', () => {
    assert.throws(() => assertNoGc(SUMMARY, { maxMajorz: 0 }), TypeError);
});

test('a deliberately ungated rule gets its reason, not "unknown"', () => {
    try {
        checkNoGc(SUMMARY, { maxExternalGrowth: 1024 });
        assert.fail('should have thrown');
    } catch (e) {
        assert.ok(e instanceof TypeError);
        assert.match(e.message, /deliberately not gateable/);
        assert.match(e.message, /reconciles lazily/, 'give the measurement that decided it');
        assert.match(e.message, /maxArrayBuffersGrowth/, 'name the rule to use instead');
    }
});
