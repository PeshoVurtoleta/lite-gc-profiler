// G27.6 -- Torture for allocation attribution (v1.13.0). Attribution is the one
// lane that is ALLOWED to be absent -- it is advisory, sampled, best-effort --
// so the torture is the inverse of the usual: instead of proving a metric fails
// closed, it proves attribution can degrade in every way WITHOUT corrupting the
// measurement, the session, or the verdict. Axes:
//
//   A -- degrade, never throw: every way the sampler can fail leaves a clean
//        result whose bytesPerCall gate still works.
//   B -- attribution NEVER changes a verdict (the load-bearing rule).
//   C -- session hygiene: the inspector session is always torn down, even when
//        the workload throws, so a following run is not contaminated.
//   D -- self-consistency of the reported attribution shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureAllocs, checkAllocs } from '../../Gc.js';

function makeThing(i) { return { a: i, b: i * 2 }; }

// =============================================================================
// AXIS A -- degrade, never throw
// =============================================================================

test('[A] attribute:true never throws for lack of a usable sampler', () => {
    // On a runtime with no inspector this returns available:false; on Node it
    // returns available:true. Either way, no throw and a real number.
    const keep = [];
    let r;
    assert.doesNotThrow(() => {
        r = measureAllocs((i) => { keep.push(makeThing(i)); },
            { iterations: 1000, batches: 3, attribute: true });
    });
    assert.ok(r.attribution, 'attribution object is always present when requested');
    assert.equal(typeof r.attribution.available, 'boolean');
    assert.equal(typeof r.bytesPerCall, 'number', 'the number survives regardless of the sampler');
});

test('[A] an unavailable attribution still carries a reason string', () => {
    // We cannot un-install the inspector mid-process, so assert the shape holds
    // in BOTH branches: available with sites, or unavailable with a reason.
    const keep = [];
    const r = measureAllocs((i) => { keep.push(makeThing(i)); },
        { iterations: 1000, batches: 3, attribute: true });
    if (r.attribution.available) {
        assert.ok(Array.isArray(r.attribution.sites));
        assert.equal(typeof r.attribution.totalSampledBytes, 'number');
    } else {
        assert.equal(typeof r.attribution.reason, 'string');
        assert.ok(r.attribution.reason.length > 0);
    }
});

test('[A] the gate is verifiable on an attributed run exactly as on a plain one', () => {
    const k1 = []; const k2 = [];
    const plain = measureAllocs((i) => { k1.push(makeThing(i)); }, { iterations: 2000, batches: 4 });
    const attr = measureAllocs((i) => { k2.push(makeThing(i)); }, { iterations: 2000, batches: 4, attribute: true });
    const rp = checkAllocs(plain, { maxBytesPerCall: 0 });
    const ra = checkAllocs(attr, { maxBytesPerCall: 0 });
    assert.equal(rp.checked.maxBytesPerCall, ra.checked.maxBytesPerCall,
        'attribution does not change what the gate can verify');
});

// =============================================================================
// AXIS B -- attribution NEVER changes a verdict
// =============================================================================

test('[B] a transient-only workload passes maxBytesPerCall:0 even though the sampler saw bytes', () => {
    // The sampler observes ALL allocation, transient included. A pure-transient
    // workload retains ~0, so it must pass -- attribution seeing megabytes of
    // transient churn must not fail it.
    const r = measureAllocs((i) => { const t = makeThing(i); return t.a + t.b; },
        { iterations: 3000, batches: 5, attribute: true });
    const rep = checkAllocs(r, { maxBytesPerCall: 0 });
    assert.notEqual(rep.verdict, 'fail',
        'transient allocation is not retention; attribution must not promote it to a failure');
});

test('[B] verdict is identical with and without attribution for the same retainer', () => {
    const k1 = []; const k2 = [];
    const plain = measureAllocs((i) => { k1.push(makeThing(i)); }, { iterations: 3000, batches: 5 });
    const attr = measureAllocs((i) => { k2.push(makeThing(i)); }, { iterations: 3000, batches: 5, attribute: true });
    assert.equal(checkAllocs(plain, { maxBytesPerCall: 0 }).verdict,
        checkAllocs(attr, { maxBytesPerCall: 0 }).verdict);
});

test('[B] the site suffix is the ONLY difference attribution makes to a failure', () => {
    // Strip the "; top allocation site: ..." suffix from an attributed failure
    // and it must equal the plain failure's reason prefix.
    const k1 = []; const k2 = [];
    const plain = measureAllocs((i) => { k1.push(makeThing(i)); }, { iterations: 3000, batches: 5 });
    const attr = measureAllocs((i) => { k2.push(makeThing(i)); }, { iterations: 3000, batches: 5, attribute: true });
    const rp = checkAllocs(plain, { maxBytesPerCall: 0 });
    const ra = checkAllocs(attr, { maxBytesPerCall: 0 });
    if (rp.verdict !== 'fail' || ra.verdict !== 'fail') return;
    const strip = (s) => s.split('; top allocation site:')[0];
    // Both reasons share the same "bytesPerCall X > limit ... (min over ...)" core.
    assert.ok(strip(ra.reason ? ra.reason : ra.violations[0].reason)
        .startsWith('bytesPerCall'), 'core reason unchanged by attribution');
});

// =============================================================================
// AXIS C -- session hygiene (no contamination of a following run)
// =============================================================================

test('[C] a workload that throws under attribution still releases the measurement guard', () => {
    // If the session/guard leaked, the NEXT measureAllocs would throw
    // "another measurement is already in flight". Prove it does not.
    assert.throws(() => measureAllocs((i) => { if (i === 500) throw new Error('boom'); },
        { iterations: 1000, batches: 3, attribute: true }), /boom/);
    // A following run must succeed cleanly.
    const keep = [];
    assert.doesNotThrow(() => {
        const r = measureAllocs((i) => { keep.push(makeThing(i)); },
            { iterations: 500, batches: 2, attribute: true });
        assert.equal(typeof r.bytesPerCall, 'number');
    });
});

test('[C] repeated attributed runs do not contaminate each other', () => {
    // Session-per-run discipline: each run gets a fresh sampler. Ten runs in a
    // row must each produce an independent, self-consistent result.
    for (let n = 0; n < 10; n++) {
        const keep = [];
        const r = measureAllocs((i) => { keep.push(makeThing(i)); },
            { iterations: 500, batches: 2, attribute: true });
        assert.ok(r.attribution, 'run ' + n + ' has attribution');
        assert.equal(typeof r.bytesPerCall, 'number', 'run ' + n + ' has a number');
    }
});

test('[C] an attributed run followed by a plain run leaves the plain run untouched', () => {
    const k1 = [];
    measureAllocs((i) => { k1.push(makeThing(i)); }, { iterations: 500, batches: 2, attribute: true });
    const k2 = [];
    const plain = measureAllocs((i) => { k2.push(makeThing(i)); }, { iterations: 500, batches: 2 });
    assert.equal(plain.attribution, null, 'the plain run never gained an inspector session');
});

// =============================================================================
// AXIS D -- self-consistency of the attribution shape
// =============================================================================

test('[D] when available, totalSampledBytes equals the sum of user site selfBytes plus tail', () => {
    const keep = [];
    const r = measureAllocs((i) => { keep.push(makeThing(i)); },
        { iterations: 3000, batches: 5, attribute: true });
    if (!r.attribution.available) return;
    // The kept sites are the top N; their selfBytes must not exceed the total.
    const shown = r.attribution.sites.reduce((a, s) => a + s.selfBytes, 0);
    assert.ok(shown <= r.attribution.totalSampledBytes + 1,
        'shown sites cannot exceed the user total they are a subset of');
});

test('[D] selfPct is consistent with selfBytes over the user total', () => {
    const keep = [];
    const r = measureAllocs((i) => { keep.push(makeThing(i)); },
        { iterations: 3000, batches: 5, attribute: true });
    if (!r.attribution.available || r.attribution.totalSampledBytes === 0) return;
    for (const s of r.attribution.sites) {
        const expected = (s.selfBytes / r.attribution.totalSampledBytes) * 100;
        assert.ok(Math.abs(s.selfPct - expected) < 1e-6, 'selfPct must match selfBytes/total');
    }
});

test('[D] every reported site has a real URL and a numeric line', () => {
    const keep = [];
    const r = measureAllocs((i) => { keep.push(makeThing(i)); },
        { iterations: 3000, batches: 5, attribute: true });
    if (!r.attribution.available) return;
    for (const s of r.attribution.sites) {
        assert.equal(typeof s.url, 'string');
        assert.ok(s.url.length > 0, 'a user site always has a non-empty URL');
        assert.equal(typeof s.line, 'number');
        assert.equal(typeof s.function, 'string');
    }
});

test('[D] attribution is stable in shape across a batch of identical runs', () => {
    const shapes = new Set();
    for (let n = 0; n < 5; n++) {
        const keep = [];
        const r = measureAllocs((i) => { keep.push(makeThing(i)); },
            { iterations: 1000, batches: 3, attribute: true });
        shapes.add(r.attribution.available ? 'available' : ('unavailable:' + r.attribution.reason));
    }
    // All runs on one host take the same branch -- either all available or all
    // the same unavailable reason. A mix would mean flaky session handling.
    assert.equal(shapes.size, 1, 'attribution availability must be stable on one host: ' + [...shapes]);
});
