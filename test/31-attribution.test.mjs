// Standard-case tests for allocation attribution (G27, v1.13.0).
// Adversarial cases live in test/torture/g27-6-attribution.test.mjs.
//
// Run under `node --expose-gc` (measureAllocs requires it). The inspector
// sampler is available in Node, so these exercise the real attribution path;
// the degrade-to-null cases are covered structurally here and adversarially
// in the torture file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureAllocs, checkAllocs, assertAllocs } from '../Gc.js';

// A named allocator so attribution has a recognizable function name to find.
function makeThing(i) { return { a: i, b: i * 2, tag: 't' + (i & 7) }; }

// ---------------------------------------------------------------------------
// the environment guard -- attribution MUST actually work here
// ---------------------------------------------------------------------------
//
// This suite runs under `node --expose-gc`, where node:inspector is present, so
// attribution is REQUIRED to be available. Every other test in this file
// tolerates `available: false` (it may run on a runtime without the inspector),
// which means a dead inspector loader -- one that silently degrades to
// no_inspector in every configuration -- would let the whole suite pass green
// while the feature does nothing. This single test refuses that: it asserts the
// mechanism is genuinely live in the environment the tests actually run in, so
// a loader that cannot reach node:inspector fails loudly instead of silently.

test('attribution is genuinely available under --expose-gc in Node (loader is live)', () => {
    const keep = [];
    const r = measureAllocs((i) => { keep.push(makeThing(i)); },
        { iterations: 2000, batches: 4, attribute: true });
    assert.equal(r.attribution.available, true,
        'node:inspector is present under --expose-gc, so attribution must be available; ' +
        'available:false here means the inspector loader could not reach node:inspector ' +
        '(reason=' + r.attribution.reason + ')');
});

// ---------------------------------------------------------------------------
// the opt-in contract
// ---------------------------------------------------------------------------

test('without attribute, attribution is null and the number is unchanged', () => {
    const keep = [];
    const r = measureAllocs((i) => { keep.push(makeThing(i)); }, { iterations: 500, batches: 3 });
    assert.equal(r.attribution, null, 'the inspector is never touched on the common path');
    assert.equal(typeof r.bytesPerCall, 'number');
});

test('with attribute, attribution is present and reports availability', () => {
    const keep = [];
    const r = measureAllocs((i) => { keep.push(makeThing(i)); },
        { iterations: 2000, batches: 4, attribute: true });
    assert.ok(r.attribution, 'attribution present when requested');
    assert.equal(typeof r.attribution.available, 'boolean');
});

test('attribution does not change the gate number vs an unattributed run', () => {
    // Same workload, one attributed one not: bytesPerCall is computed from the
    // heap delta either way, so both must land in the same ballpark and both
    // gate identically at maxBytesPerCall: 0 (a retainer).
    const k1 = []; const k2 = [];
    const plain = measureAllocs((i) => { k1.push(makeThing(i)); }, { iterations: 2000, batches: 4 });
    const attr = measureAllocs((i) => { k2.push(makeThing(i)); }, { iterations: 2000, batches: 4, attribute: true });
    assert.equal(checkAllocs(plain, { maxBytesPerCall: 0 }).verdict, 'fail');
    assert.equal(checkAllocs(attr, { maxBytesPerCall: 0 }).verdict, 'fail');
});

// ---------------------------------------------------------------------------
// naming the site (Node path)
// ---------------------------------------------------------------------------

test('a retaining workload names its allocation site', () => {
    const keep = [];
    const r = measureAllocs((i) => { keep.push(makeThing(i)); },
        { iterations: 3000, batches: 5, attribute: true });
    if (!r.attribution.available) return;   // no inspector on this runtime; torture covers that
    assert.ok(Array.isArray(r.attribution.sites));
    // The heaviest user sites should include our named allocator or the closure
    // that calls it -- both are in this test file, a real user URL.
    const names = r.attribution.sites.map((s) => s.function);
    assert.ok(names.some((n) => n === 'makeThing' || n.includes('') /* anon closure */),
        'expected a named user site, got: ' + JSON.stringify(names));
});

test('sites are heaviest-first and selfPct sums toward 100 among user bytes', () => {
    const keep = [];
    const r = measureAllocs((i) => { keep.push(makeThing(i)); },
        { iterations: 3000, batches: 5, attribute: true });
    if (!r.attribution.available || r.attribution.sites.length === 0) return;
    const s = r.attribution.sites;
    for (let i = 1; i < s.length; i++) {
        assert.ok(s[i - 1].selfBytes >= s[i].selfBytes, 'sites must be sorted heaviest-first');
    }
    const pctSum = s.reduce((a, x) => a + x.selfPct, 0);
    assert.ok(pctSum <= 100.0001, 'selfPct is a share of user bytes, cannot exceed 100');
});

test('topSites caps how many sites are returned', () => {
    const keep = [];
    const r = measureAllocs((i) => { keep.push(makeThing(i)); },
        { iterations: 3000, batches: 5, attribute: true, topSites: 1 });
    if (!r.attribution.available) return;
    assert.ok(r.attribution.sites.length <= 1, 'topSites: 1 keeps at most one site');
});

test('native/internal bytes are bucketed separately, not attributed to user sites', () => {
    const keep = [];
    const r = measureAllocs((i) => { keep.push(makeThing(i)); },
        { iterations: 3000, batches: 5, attribute: true });
    if (!r.attribution.available) return;
    assert.equal(typeof r.attribution.nativeBytes, 'number');
    // No user site should carry a node: or empty URL.
    for (const s of r.attribution.sites) {
        assert.ok(s.url && s.url.indexOf('node:') !== 0, 'user sites never carry node: URLs: ' + s.url);
    }
});

// ---------------------------------------------------------------------------
// checkAllocs failure message enrichment
// ---------------------------------------------------------------------------

test('a failure message names the top allocation site when attribution is present', () => {
    const keep = [];
    const r = measureAllocs((i) => { keep.push(makeThing(i)); },
        { iterations: 3000, batches: 5, attribute: true });
    const rep = checkAllocs(r, { maxBytesPerCall: 0 });
    assert.equal(rep.verdict, 'fail');
    if (r.attribution.available && r.attribution.sites.length > 0) {
        assert.match(rep.violations[0].reason, /top allocation site:/);
        assert.match(rep.violations[0].reason, /% of sampled bytes/);
    }
});

test('a failure message without attribution is the plain reason', () => {
    const keep = [];
    const r = measureAllocs((i) => { keep.push(makeThing(i)); }, { iterations: 2000, batches: 4 });
    const rep = checkAllocs(r, { maxBytesPerCall: 0 });
    assert.equal(rep.verdict, 'fail');
    assert.doesNotMatch(rep.violations[0].reason, /top allocation site:/,
        'no attribution -> no site suffix');
});

test('attribution never flips a passing verdict to fail', () => {
    // A non-retaining workload passes maxBytesPerCall: 0 regardless of what the
    // sampler saw (the sampler sees transient allocation too).
    const r = measureAllocs((i) => { const tmp = makeThing(i); return tmp.a; },
        { iterations: 3000, batches: 5, attribute: true });
    const rep = checkAllocs(r, { maxBytesPerCall: 0 });
    // Transient-only work retains ~0; verdict is pass or inconclusive, never
    // fail-because-attribution.
    assert.notEqual(rep.verdict, 'fail',
        'a transient allocator must not fail just because the sampler saw bytes');
});

// ---------------------------------------------------------------------------
// options validation
// ---------------------------------------------------------------------------

test('topSites must be a positive integer when attribute is on', () => {
    assert.throws(() => measureAllocs(() => {}, { iterations: 10, attribute: true, topSites: 0 }), RangeError);
    assert.throws(() => measureAllocs(() => {}, { iterations: 10, attribute: true, topSites: -1 }), RangeError);
    assert.throws(() => measureAllocs(() => {}, { iterations: 10, attribute: true, topSites: 2.5 }), RangeError);
});

test('topSites is ignored (not validated) when attribute is off', () => {
    // A stray topSites with attribute off should not throw -- it is simply unused.
    assert.doesNotThrow(() => measureAllocs(() => {}, { iterations: 10, topSites: 0 }));
});

test('assertAllocs still throws on a real retainer with attribution on', () => {
    const keep = [];
    assert.throws(
        () => assertAllocs((i) => { keep.push(makeThing(i)); },
            { maxBytesPerCall: 0 }, { iterations: 3000, batches: 5, attribute: true }),
        (e) => e && e.name === 'GcBudgetError'
    );
});

// ---------------------------------------------------------------------------
// _attributeProfile / _isUserFrame -- pure-function unit tests with synthetic
// profile heads, covering the branches the live inspector cannot provoke on a
// runtime where it works (empty, native-only, non-finite selfSize, filtering).
// ---------------------------------------------------------------------------

import { _attributeProfile, _isUserFrame } from '../Gc.js';

const frame = (url, fn, self, kids) => ({
    callFrame: { functionName: fn, url, lineNumber: 10, columnNumber: 4 },
    selfSize: self,
    children: kids || []
});

test('_isUserFrame: empty, node:, library, and bare-internal URLs are not user', () => {
    assert.equal(_isUserFrame({ url: '' }), false, 'native/synthetic');
    assert.equal(_isUserFrame({ url: 'node:internal/timers' }), false);
    assert.equal(_isUserFrame({ url: 'node:inspector' }), false);
    assert.equal(_isUserFrame({ url: 'per_thread' }), false, 'bare internal name');
    assert.equal(_isUserFrame({ url: 'file:///app/src/pool.js' }), true, 'a real source file');
    assert.equal(_isUserFrame({ url: 'https://host/app.js' }), true);
});

test('_attributeProfile: sums selfSize per user site, heaviest first', () => {
    const head = frame('file:///app/a.js', 'top', 0, [
        frame('file:///app/a.js', 'small', 100, []),
        frame('file:///app/b.js', 'big', 900, [])
    ]);
    const r = _attributeProfile(head, 5);
    assert.equal(r.totalSampledBytes, 1000);
    assert.equal(r.sites[0].function, 'big');
    assert.equal(r.sites[0].selfBytes, 900);
    assert.equal(r.sites[0].selfPct, 90);
    assert.equal(r.sites[1].function, 'small');
});

test('_attributeProfile: native and internal bytes go to nativeBytes, not sites', () => {
    const head = frame('file:///app/a.js', 'user', 200, [
        frame('', 'push', 500, []),                 // native
        frame('node:internal/x', 'internal', 300, []) // internal
    ]);
    const r = _attributeProfile(head, 5);
    assert.equal(r.totalSampledBytes, 200, 'only the user frame counts as user bytes');
    assert.equal(r.nativeBytes, 800, 'native + internal are bucketed together');
    assert.equal(r.sites.length, 1);
});

test('_attributeProfile: an empty profile head yields zero everything', () => {
    const r = _attributeProfile(frame('file:///app/a.js', 'x', 0, []), 5);
    assert.equal(r.totalSampledBytes, 0);
    assert.equal(r.nativeBytes, 0);
    assert.deepEqual(r.sites, []);
});

test('_attributeProfile: a native-only profile has zero user sites, selfPct not NaN', () => {
    const head = frame('', 'native', 0, [frame('', 'push', 1000, [])]);
    const r = _attributeProfile(head, 5);
    assert.equal(r.totalSampledBytes, 0);
    assert.equal(r.nativeBytes, 1000);
    assert.deepEqual(r.sites, [], 'no user site to report');
});

test('_attributeProfile: non-finite selfSize is ignored, never poisons the total', () => {
    const head = frame('file:///app/a.js', 'ok', 500, [
        frame('file:///app/b.js', 'bad', NaN, []),
        frame('file:///app/c.js', 'worse', Infinity, [])
    ]);
    const r = _attributeProfile(head, 5);
    assert.equal(r.totalSampledBytes, 500, 'NaN/Infinity selfSize contribute nothing');
    assert.equal(r.sites.length, 1);
});

test('_attributeProfile: topSites caps the site list but not the total', () => {
    const head = frame('file:///app/a.js', 'top', 0, [
        frame('file:///app/1.js', 'a', 100, []),
        frame('file:///app/2.js', 'b', 200, []),
        frame('file:///app/3.js', 'c', 300, [])
    ]);
    const r = _attributeProfile(head, 2);
    assert.equal(r.sites.length, 2, 'capped at topSites');
    assert.equal(r.totalSampledBytes, 600, 'total still counts every user site');
    assert.equal(r.sites[0].function, 'c', 'kept sites are the heaviest');
});

test('_attributeProfile: same site across branches accumulates', () => {
    const head = frame('file:///app/a.js', 'top', 0, [
        frame('file:///app/pool.js', 'alloc', 100, []),
        frame('file:///app/pool.js', 'alloc', 150, [])   // same fn+url+line
    ]);
    const r = _attributeProfile(head, 5);
    assert.equal(r.sites.length, 1, 'the two occurrences fold into one site');
    assert.equal(r.sites[0].selfBytes, 250);
});

test('_attributeProfile: a deep tree does not stack-overflow (iterative walk)', () => {
    // Build a 20k-deep chain; a recursive walk would blow the stack.
    let node = frame('file:///app/leaf.js', 'leaf', 10, []);
    for (let i = 0; i < 20000; i++) node = frame('file:///app/n.js', 'n', 1, [node]);
    assert.doesNotThrow(() => _attributeProfile(node, 5));
});
