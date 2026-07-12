// Shared harness for torture tests. Provides four axis-specific assertion
// primitives so each G-slot test file reads as a flat list of scenarios and
// the axis intent stays visible at the call site.
//
// Design note: this harness is under its own maxMajor:0 gate at end-of-suite
// (see torture/global.mjs, added when Batch 5 lands). Nothing here allocates
// in the pattern of the tortured targets.

import assert from 'node:assert/strict';
import { checkNoGc, assertNoGc, GcBudgetError, GcInconclusiveError } from '../../Gc.js';

/**
 * Axis A -- MUST produce 'inconclusive'. Never 'pass', never 'fail'.
 * A green here is silent falsification: the worst possible bug in this package.
 */
export function assertAxisA(summary, rules, label) {
    const rep = checkNoGc(summary, rules);
    if (rep.verdict === 'pass') {
        assert.fail('AXIS A VIOLATION [' + label + ']: verdict=pass on adversarial input. '
            + 'A silent pass is the worst possible bug -- gate lied about verifiability.');
    }
    if (rep.verdict === 'fail') {
        assert.fail('AXIS A VIOLATION [' + label + ']: verdict=fail on adversarial input. '
            + 'Expected inconclusive (unverifiable), got a false negative.');
    }
    assert.equal(rep.verdict, 'inconclusive', label);
    // Also verify assertNoGc throws GcInconclusiveError by default
    assert.throws(
        () => assertNoGc(summary, rules),
        GcInconclusiveError,
        label + ': assertNoGc should throw GcInconclusiveError on axis-A input'
    );
    return rep;
}

/**
 * Axis B -- MUST produce 'fail'. Real signal buried in noise or edge cases;
 * the gate must find it.
 */
export function assertAxisB(summary, rules, label) {
    const rep = checkNoGc(summary, rules);
    assert.equal(rep.verdict, 'fail', label + ': expected fail, got ' + rep.verdict);
    assert.ok(rep.violations.length > 0, label + ': fail must include at least one violation');
    assert.throws(
        () => assertNoGc(summary, rules),
        GcBudgetError,
        label + ': assertNoGc should throw GcBudgetError'
    );
    return rep;
}

/**
 * Axis C -- MUST produce 'pass'. Clean signal under hostile conditions;
 * the gate must not become flaky against the machine.
 */
export function assertAxisC(summary, rules, label) {
    const rep = checkNoGc(summary, rules);
    assert.equal(rep.verdict, 'pass', label + ': expected pass, got ' + rep.verdict
        + ' (violations=' + JSON.stringify(rep.violations) + ')');
    assert.equal(rep.violations.length, 0, label + ': pass must have zero violations');
    return rep;
}

/**
 * Axis D -- self-consistency invariant. Runs the caller's predicate and asserts.
 * Kept as a thin wrapper so all axis calls read the same at the call site.
 */
export function assertAxisD(predicate, label) {
    const result = predicate();
    assert.ok(result === true || result === undefined,
        'AXIS D VIOLATION [' + label + ']: consistency invariant returned ' + result);
}

/**
 * Build a summary literal for a given source. Standard testing shortcut.
 * Same shape as production summary(); mirrors test/03-verdicts.mjs helper.
 */
export function makeSummary(source, over) {
    const s = {
        schema: 'lite-gc/1',
        source,
        supported: source !== 'none',
        gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, p99Ms: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 },
        heap: { supported: source !== 'none', used: 0, peak: 0, firstSample: 0, samples: 0, allocBytes: 0, allocRateBytesPerSec: 0, gcDrops: 0, freedBytes: 0 },
        frames: { count: 0, long: 0 },
        phases: {}
    };
    if (over) {
        if (over.gc) Object.assign(s.gc, over.gc);
        if (over.heap) Object.assign(s.heap, over.heap);
        if (over.frames) Object.assign(s.frames, over.frames);
        if (over.phases) s.phases = over.phases;
    }
    return s;
}

export function makePhase(over) {
    const p = { gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 } };
    if (over && over.gc) Object.assign(p.gc, over.gc);
    return p;
}
