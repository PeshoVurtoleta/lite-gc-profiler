// Standard-case tests for measureAllocs / checkAllocs / assertAllocs
// (G26, v1.11.0). Adversarial cases live in test/torture/g26-6-allocs.test.mjs.
//
// These run under --expose-gc (the npm test script supplies it). measureAllocs
// requires it and throws otherwise; the "no --expose-gc" behaviour is covered
// in the torture file by stubbing globalThis.gc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    measureAllocs, checkAllocs, assertAllocs,
    GcBudgetError, GcInconclusiveError,
    VERDICT_MATRIX
} from '../Gc.js';

// A function that retains nothing: pure integer work into a shared slot.
const scratch = new Float64Array(4);
function zeroRetention(i) {
    scratch[i & 3] = scratch[i & 3] + i;
    return scratch[0] | 0;
}

// A function that retains a fresh object on every call. `sink` is module-level
// so the objects genuinely survive the forced collection inside each batch.
let sink = [];
function retainsPerCall(i) {
    sink.push({ a: i, b: i * 2, c: i & 7 });
}

// -----------------------------------------------------------------------------
// shape
// -----------------------------------------------------------------------------

test('measureAllocs returns the documented shape', () => {
    const r = measureAllocs(zeroRetention, { iterations: 1000, batches: 4 });
    assert.equal(r.schema, 'lite-gc-allocs/1');
    assert.equal(r.iterations, 1000);
    assert.equal(r.batches, 4);
    assert.equal(r.warmupCalls, 1000);      // defaults to iterations
    assert.equal(typeof r.measuredBatches, 'number');
    assert.ok(r.bytesPerCall === null || typeof r.bytesPerCall === 'number');
    assert.ok(r.maxBytesPerCall === null || typeof r.maxBytesPerCall === 'number');
    assert.ok(Array.isArray(r.batchBytes));
    assert.equal(r.batchBytes.length, 4);
    assert.equal(typeof r.settled, 'boolean');
    assert.equal(typeof r.source, 'string');
    assert.ok(r.summary && r.summary.schema === 'lite-gc/1');
});

test('warmup defaults to iterations and is honoured explicitly', () => {
    const r = measureAllocs(zeroRetention, { iterations: 500, batches: 2, warmup: 50 });
    assert.equal(r.warmupCalls, 50);
});

test('batches defaults to 8', () => {
    const r = measureAllocs(zeroRetention, { iterations: 200 });
    assert.equal(r.batches, 8);
    assert.equal(r.batchBytes.length, 8);
});

// -----------------------------------------------------------------------------
// the core differential -- retention vs none
// -----------------------------------------------------------------------------

test('a zero-retention function reports bytesPerCall 0 (min strips noise)', () => {
    const r = measureAllocs(zeroRetention, { iterations: 4000, batches: 8 });
    assert.equal(r.bytesPerCall, 0,
        'a function that retains nothing must floor to 0 across enough batches; got '
        + r.bytesPerCall + ' batches=' + JSON.stringify(r.batchBytes));
    assert.equal(r.settled, true);
    assert.equal(r.source, 'gc');
});

test('a retaining function reports a positive, plausible bytesPerCall', () => {
    sink = [];
    const r = measureAllocs(retainsPerCall, { iterations: 2000, batches: 8 });
    assert.ok(r.bytesPerCall > 0,
        'a function retaining an object per call must measure > 0; got ' + r.bytesPerCall);
    // A small object is tens of bytes; assert a sane band rather than an exact
    // figure (V8 object layout is version-dependent).
    assert.ok(r.bytesPerCall >= 16 && r.bytesPerCall < 512,
        'retained bytes-per-call outside a plausible band: ' + r.bytesPerCall);
});

test('bytesPerCall is the MIN and maxBytesPerCall is >= it', () => {
    sink = [];
    const r = measureAllocs(retainsPerCall, { iterations: 2000, batches: 8 });
    assert.ok(r.maxBytesPerCall >= r.bytesPerCall,
        'max must not be below min: ' + r.maxBytesPerCall + ' < ' + r.bytesPerCall);
    const perCall = r.batchBytes.map((b) => b / r.iterations);
    assert.equal(r.bytesPerCall, Math.min(...perCall), 'reported min must equal batch min');
    assert.equal(r.maxBytesPerCall, Math.max(...perCall), 'reported max must equal batch max');
});

// -----------------------------------------------------------------------------
// checkAllocs
// -----------------------------------------------------------------------------

test('checkAllocs passes a zero-retention run at maxBytesPerCall 0', () => {
    const r = measureAllocs(zeroRetention, { iterations: 4000, batches: 8 });
    const rep = checkAllocs(r, { maxBytesPerCall: 0 });
    assert.equal(rep.verdict, 'pass');
    assert.equal(rep.violations.length, 0);
    assert.equal(rep.checked.maxBytesPerCall, true);
});

test('checkAllocs fails a retaining run at maxBytesPerCall 0', () => {
    sink = [];
    const r = measureAllocs(retainsPerCall, { iterations: 2000, batches: 8 });
    const rep = checkAllocs(r, { maxBytesPerCall: 0 });
    assert.equal(rep.verdict, 'fail');
    assert.equal(rep.violations[0].rule, 'maxBytesPerCall');
    assert.ok(rep.violations[0].actual > 0);
    assert.match(rep.violations[0].reason, /min over \d+ batches/);
});

test('checkAllocs passes a retaining run under a generous limit', () => {
    sink = [];
    const r = measureAllocs(retainsPerCall, { iterations: 2000, batches: 8 });
    const rep = checkAllocs(r, { maxBytesPerCall: 4096 });
    assert.equal(rep.verdict, 'pass');
});

test('checkAllocs with no rules is a pass (nothing to gate)', () => {
    const r = measureAllocs(zeroRetention, { iterations: 500, batches: 2 });
    assert.equal(checkAllocs(r).verdict, 'pass');
    assert.equal(checkAllocs(r, {}).verdict, 'pass');
});

test('checkAllocs rejects a foreign result shape', () => {
    assert.throws(() => checkAllocs({ schema: 'lite-gc-ops/1' }, { maxBytesPerCall: 0 }), TypeError);
    assert.throws(() => checkAllocs(null, { maxBytesPerCall: 0 }), TypeError);
});

// -----------------------------------------------------------------------------
// assertAllocs
// -----------------------------------------------------------------------------

test('assertAllocs returns the report on pass', () => {
    const rep = assertAllocs(zeroRetention, { maxBytesPerCall: 0 }, { iterations: 4000, batches: 8 });
    assert.equal(rep.verdict, 'pass');
});

test('assertAllocs throws GcBudgetError on fail', () => {
    sink = [];
    assert.throws(
        () => assertAllocs(retainsPerCall, { maxBytesPerCall: 0 }, { iterations: 2000, batches: 8 }),
        GcBudgetError
    );
});

// -----------------------------------------------------------------------------
// verifiability / matrix
// -----------------------------------------------------------------------------

test('maxBytesPerCall is in the verdict matrix with all four columns', () => {
    const row = VERDICT_MATRIX.maxBytesPerCall;
    assert.ok(row, 'maxBytesPerCall missing from VERDICT_MATRIX');
    for (const col of ['gc', 'heap', 'uasm', 'none']) {
        assert.ok(col in row, 'missing column ' + col);
    }
    assert.equal(row.none, 'no');
});

test('source none yields null bytesPerCall and an inconclusive gate', () => {
    const r = measureAllocs(zeroRetention, { iterations: 500, batches: 2, source: 'none' });
    assert.equal(r.bytesPerCall, null, 'no memory channel means no number');
    assert.equal(r.source, 'none');
    const rep = checkAllocs(r, { maxBytesPerCall: 0 });
    assert.equal(rep.verdict, 'inconclusive');
    assert.equal(rep.checked.maxBytesPerCall, false);
});

test('assertAllocs throws GcInconclusiveError on an unmeasurable source', () => {
    assert.throws(
        () => assertAllocs(zeroRetention, { maxBytesPerCall: 0 }, { iterations: 500, batches: 2, source: 'none' }),
        GcInconclusiveError
    );
});

test('allowInconclusive lets an unmeasurable run return instead of throwing', () => {
    const rep = assertAllocs(zeroRetention, { maxBytesPerCall: 0 },
        { iterations: 500, batches: 2, source: 'none', allowInconclusive: true });
    assert.equal(rep.verdict, 'inconclusive');
});

// -----------------------------------------------------------------------------
// input validation
// -----------------------------------------------------------------------------

test('measureAllocs rejects a non-function workload', () => {
    assert.throws(() => measureAllocs(null, { iterations: 100 }), TypeError);
    assert.throws(() => measureAllocs(42, { iterations: 100 }), TypeError);
});

test('measureAllocs rejects an async workload with a pointer to measureOpsAsync', () => {
    assert.throws(
        () => measureAllocs(async (i) => i, { iterations: 100 }),
        (e) => e instanceof TypeError && /measureOpsAsync/.test(e.message)
    );
});

test('measureAllocs requires opts', () => {
    assert.throws(() => measureAllocs(zeroRetention), TypeError);
    assert.throws(() => measureAllocs(zeroRetention, null), TypeError);
});

test('measureAllocs validates iterations', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, '100', undefined]) {
        assert.throws(() => measureAllocs(zeroRetention, { iterations: bad }), RangeError,
            'iterations=' + String(bad));
    }
});

test('measureAllocs validates batches', () => {
    for (const bad of [0, -1, 2.5, NaN, Infinity]) {
        assert.throws(() => measureAllocs(zeroRetention, { iterations: 100, batches: bad }), RangeError,
            'batches=' + String(bad));
    }
});

test('measureAllocs validates warmup', () => {
    for (const bad of [-1, 1.5, NaN, Infinity]) {
        assert.throws(() => measureAllocs(zeroRetention, { iterations: 100, warmup: bad }), RangeError,
            'warmup=' + String(bad));
    }
    // 0 is valid for warmup (unlike iterations).
    assert.doesNotThrow(() => measureAllocs(zeroRetention, { iterations: 100, warmup: 0 }));
});

test('checkAllocs rejects an unknown rule key rather than ignoring it', () => {
    const r = measureAllocs(zeroRetention, { iterations: 200, batches: 2 });
    // A silently-ignored rule makes the gate pass everything, so unknown keys
    // throw. The shared validator adds a "Did you mean" hint for casing/plural
    // slips; a dropped interior character (maxBytesPerCal) is beyond its fuzzy
    // match, but it must still be rejected.
    assert.throws(
        () => checkAllocs(r, { maxBytesPerCal: 0 }),
        (e) => e instanceof TypeError && /unknown rule "maxBytesPerCal"/.test(e.message)
    );
    // A casing slip does get the hint.
    assert.throws(
        () => checkAllocs(r, { maxbytespercall: 0 }),
        (e) => e instanceof TypeError && /Did you mean maxBytesPerCall/.test(e.message)
    );
});

test('checkAllocs rejects a non-finite threshold', () => {
    const r = measureAllocs(zeroRetention, { iterations: 200, batches: 2 });
    assert.throws(() => checkAllocs(r, { maxBytesPerCall: NaN }), RangeError);
    assert.throws(() => checkAllocs(r, { maxBytesPerCall: Infinity }), RangeError);
});

// -----------------------------------------------------------------------------
// serialisation
// -----------------------------------------------------------------------------

test('a measureAllocs result round-trips through JSON and still gates', () => {
    const r = measureAllocs(zeroRetention, { iterations: 2000, batches: 4 });
    const wire = JSON.parse(JSON.stringify(r));
    const rep = checkAllocs(wire, { maxBytesPerCall: 0 });
    assert.equal(rep.verdict, 'pass');
});
