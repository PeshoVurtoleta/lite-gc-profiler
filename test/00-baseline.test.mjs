// Baseline sanity checks. Asserts the VERSION constant matches its expected
// value (bumped in three places per the ecosystem convention: this test, the
// VERSION const in index.js, and package.json) and that all named exports
// resolve. Runs first in the suite so version drift fails fast.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../Gc.js';

const EXPECTED_VERSION = '1.9.1';

test('VERSION constant matches expected release version', () => {
    assert.equal(api.VERSION, EXPECTED_VERSION,
        'VERSION drift: index.js says ' + api.VERSION + ', test expects ' + EXPECTED_VERSION
        + '. Bump both plus package.json in lockstep.');
});

test('all named exports resolve', () => {
    const required = [
        'VERSION',
        'GcProfiler',
        'checkNoGc', 'assertNoGc',
        'compareGc', 'assertCompare',
        'aggregateGc', 'gateReps', 'assertReps',
        'captureFingerprint', 'createBaseline',
        'checkAgainstBaseline', 'assertAgainstBaseline',
        'formatConsole', 'formatJson', 'formatMarkdown', 'formatGithubAnnotations',
        'GcBudgetError', 'GcInconclusiveError',
        'GC_DEFAULT_RULES', 'GC_DEFAULT_DIFFERENTIAL_RULES', 'REP_POLICY_DEFAULTS',
        'VERDICT_MATRIX',
        'GC_MINOR', 'GC_MAJOR', 'GC_INCREMENTAL', 'GC_WEAKCB'
    ];
    for (const name of required) {
        assert.ok(name in api, 'missing export: ' + name);
        assert.notEqual(api[name], undefined, 'export ' + name + ' is undefined');
    }
});

test('GcProfiler instantiates and exposes the expected surface', () => {
    const gc = new api.GcProfiler();
    assert.equal(typeof gc.start, 'function');
    assert.equal(typeof gc.stop, 'function');
    assert.equal(typeof gc.record, 'function');
    assert.equal(typeof gc.sampleHeap, 'function');
    assert.equal(typeof gc.markFrame, 'function');
    assert.equal(typeof gc.phase, 'function');
    assert.equal(typeof gc.settle, 'function');
    assert.equal(typeof gc.summary, 'function');
    assert.equal(typeof gc.reset, 'function');
    assert.equal(typeof gc.destroy, 'function');
});

test('VERDICT_MATRIX is a plain data table (no functions, no undefined cells)', () => {
    const sources = ['gc', 'heap', 'none'];
    const states = ['yes', 'no', 'needsHeap'];
    for (const rule in api.VERDICT_MATRIX) {
        const row = api.VERDICT_MATRIX[rule];
        for (const src of sources) {
            assert.ok(states.includes(row[src]),
                rule + '.' + src + ' has invalid state: ' + row[src]);
        }
    }
});
