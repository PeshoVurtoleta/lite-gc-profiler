// Support-surface tests (v1.9.1). The error message IS the documentation for
// most first-time users -- they meet it before they meet the README, and what
// it says determines whether they fix the measurement or reach for
// allowInconclusive and switch the safety off.
//
// So the messages are pinned. Not their exact wording -- that should stay free
// to improve -- but the two things that make them useful: the CAUSE is named,
// and a concrete NEXT STEP is given. A message that says only "cannot verify"
// has failed at its job even though nothing threw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GcProfiler, measureOps, assertNoGc, GcInconclusiveError } from '../Gc.js';

function makeSummary(source, over) {
    const s = {
        schema: 'lite-gc/1',
        source,
        supported: source !== 'none',
        gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, p99Ms: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 },
        heap: { supported: source === 'heap', used: 0, peak: 0, firstSample: 0, samples: 0, allocBytes: 0, allocRateBytesPerSec: 0, gcDrops: 0, freedBytes: 0 },
        uasm: { supported: source === 'uasm', bytes: 0, peak: 0, firstSample: 0, samples: 0, growthRate: 0, granularityBytes: null, belowGranularity: true },
        frames: { count: 0, long: 0 },
        phases: {}, byRegion: {}
    };
    if (over && over.uasm) Object.assign(s.uasm, over.uasm);
    if (over && over.heap) Object.assign(s.heap, over.heap);
    return s;
}

function messageFrom(summary, rules) {
    try {
        assertNoGc(summary, rules);
        assert.fail('expected an inconclusive throw');
    } catch (e) {
        assert.ok(e instanceof GcInconclusiveError, 'expected GcInconclusiveError, got ' + e.name);
        return e.message;
    }
}

// ---- every inconclusive message routes somewhere ----

test('every inconclusive message points at the triage doc', () => {
    const msg = messageFrom(makeSummary('none'), { maxMajor: 0 });
    assert.match(msg, /INCONCLUSIVE\.md/,
        'a user who cannot act on the inline hint needs somewhere to go');
});

test('inconclusive message still names the unverifiable rules and the source', () => {
    // Regression guard on the v1.0.0 contract -- the hint is additive, it does
    // not displace what was already there.
    const msg = messageFrom(makeSummary('none'), { maxMajor: 0, maxMinor: 0 });
    assert.match(msg, /maxMajor/);
    assert.match(msg, /maxMinor/);
    assert.match(msg, /source=none/);
});

test('allowInconclusive is presented as a deliberate choice, not a fix', () => {
    // Wording matters here. "Pass { allowInconclusive: true } to accept" reads
    // as the remedy; the remedy must be the fix, and the escape hatch must read
    // like one. The hint has to come first.
    const msg = messageFrom(makeSummary('none'), { maxMajor: 0 });
    assert.match(msg, /allowInconclusive/);
    assert.ok(msg.indexOf('INCONCLUSIVE.md') < msg.indexOf('allowInconclusive'),
        'the escape hatch must not be the first route offered');
});

// ---- the first-contact three ----

test("source:'none' names the runtimes and offers the frame lane", () => {
    const msg = messageFrom(makeSummary('none'), { maxMajor: 0 });
    assert.match(msg, /Firefox|Safari/, 'a stranger needs to know which runtime this is');
    assert.match(msg, /frame lane/, 'the lane that still works there must be named');
});

test('a heap-source summary explains why kind rules cannot be answered', () => {
    const msg = messageFrom(makeSummary('heap', { heap: { samples: 5 } }), { maxMajor: 0 });
    assert.match(msg, /GC events/, 'name the missing thing, not just the failure');
    assert.match(msg, /maxAllocRate|node/, 'name what to do instead');
});

test('a two-sample shortfall points at sampleHeap and the measure helpers', () => {
    const msg = messageFrom(makeSummary('gc'), { maxAllocRate: 1024 });
    assert.match(msg, /two heap samples|sampleHeap/);
    assert.match(msg, /measureOps|measureFrames/,
        'most users should not be driving GcProfiler by hand');
});

// ---- the v1.9.0 route ----

test('uasm_below_granularity names the field and both fixes', () => {
    const s = makeSummary('uasm', {
        uasm: { samples: 5, growthRate: 2097152, granularityBytes: 1048576, belowGranularity: true }
    });
    const msg = messageFrom(s, { maxAllocRate: 1024 });
    assert.match(msg, /uasm_below_granularity/, 'the reason code must be visible for searching');
    assert.match(msg, /granularityBytes/, 'name the field the user should inspect');
    assert.match(msg, /longer window/, 'fix one: sample more');
    assert.match(msg, /heap/, 'fix two: change instrument');
});

// ---- construction-time errors ----

test('source:uasm on an unsupported runtime explains how isolation is obtained', () => {
    // Previously this said what was required and stopped. "requires
    // crossOriginIsolated" is not actionable to anyone who does not already
    // know that cross-origin isolation is a response-header decision.
    try {
        new GcProfiler(64, { source: 'uasm' });
        assert.fail('expected a RangeError on a runtime without the uasm API');
    } catch (e) {
        assert.ok(e instanceof RangeError);
        assert.match(e.message, /Cross-Origin-Opener-Policy/);
        assert.match(e.message, /Cross-Origin-Embedder-Policy/);
        assert.match(e.message, /node/, 'tell a node user what to use instead');
    }
});

test('stabilize without --expose-gc gives the exact flag AND the opt-out', () => {
    // The most common node-side first-run error. The message already gets this
    // right, and it is pinned so it does not get shortened away later: a user
    // needs the literal flag to paste, and needs to know they can simply not
    // use stabilize. Naming only the requirement leaves them stuck.
    const savedGc = globalThis.gc;
    globalThis.gc = undefined;                 // non-configurable under --expose-gc
    try {
        assert.throws(
            () => measureOps((i) => i | 0, { ops: 100, stabilize: true }),
            (e) => {
                assert.ok(e instanceof RangeError);
                assert.match(e.message, /node --expose-gc/, 'give the literal flag');
                assert.match(e.message, /globalThis\.gc/, 'name what is actually missing');
                assert.match(e.message, /drop stabilize/, 'name the opt-out');
                return true;
            }
        );
    } finally {
        globalThis.gc = savedGc;
    }
});
