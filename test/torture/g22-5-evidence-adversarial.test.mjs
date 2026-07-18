// G22.5 -- adversarial pass over the evidence lane (v1.6.0).
//
// The narrator's whole job is to run when a gate has ALREADY failed, which
// makes its failure modes asymmetric: throwing replaces a useful failure
// report with a stack trace, and emitting a control character forges a line in
// whatever log is reading it. Both were reachable.
//
// Reachability note, so nobody over- or under-reads these pins: reports this
// library produces only carry names from its own fixed vocabulary, and the
// injection could NOT be reached through any public API -- the baseline
// comparator ignores metric keys it does not recognise. It is reachable by
// formatting a report built by hand or deserialized from another job, which
// the formatters accept by design. These are defence-in-depth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainReport, explainDiff, gateBadge } from '../../Explain.js';
import { formatGithubAnnotations, measureOps, checkOps } from '../../Gc.js';

const mk = (o) => ({
    schema: 'lite-gc-report/1', kind: 'ops', verdict: 'fail', source: 'gc',
    violations: [{ metric: 'bytesPerOp', actual: 500, limit: 20, reason: 'over budget' }],
    checked: { maxBytesPerOp: true },
    result: { schema: 'lite-gc-ops/1', ops: 100, bytesPerOp: 500 }, ...o
});

test('[axis Y] a newline in a report cannot forge a GitHub annotation', () => {
    // Workflow commands are newline-delimited: an unsanitized name produced two
    // ::error directives from one violation, the second fully report-controlled.
    // ::notice and ::add-mask:: are reachable the same way, so a forged line can
    // also make a failing run read as clean.
    const evil = mk({ violations: [{
        metric: 'bytesPerOp\n::error::FORGED', actual: 1, limit: 0,
        reason: 'r\n::notice::gate passed'
    }] });
    const gh = formatGithubAnnotations(evil);
    const directives = (gh.match(/^::(error|warning|notice|add-mask|set-output)/gm) || []).length;
    assert.equal(directives, 1, 'one violation must emit exactly one directive; got:\n' + gh);
    assert.ok(!/\n/.test(gh.trim()), 'no embedded newline may survive into a single annotation');
});

test('[axis Y] control characters are stripped from every narrated field', () => {
    const evil = mk({ violations: [{
        rule: 'maxBytesPerOp\n::error::A', metric: 'bytesPerOp\r::error::B',
        actual: 500, limit: 20, reason: 'over\n::error::C'
    }] });
    const out = explainReport(evil, { color: false });
    assert.ok(!/\x1b/.test(out), 'ANSI escapes must not pass through');
    for (const line of out.split('\n')) {
        assert.ok(!/^::/.test(line.trim()),
            'a report field forged a directive line: ' + JSON.stringify(line));
    }
});

test('[axis Y] an oversized name cannot flood the log', () => {
    const out = explainReport(mk({ violations: [{ metric: 'x'.repeat(500000), actual: 1, limit: 0, reason: 'r' }] }));
    assert.ok(out.length < 10000, 'narration grew to ' + out.length + ' chars from one name');
});

test('[axis Z] a malformed violation entry does not take the narrator down', () => {
    // It reported `Cannot read properties of null (reading 'rule')` -- a stack
    // trace where the developer needed the failure report.
    for (const bad of [null, undefined, 42, 'str', true]) {
        const out = explainReport(mk({ violations: [bad] }));
        assert.ok(out.length > 0, 'entry ' + String(bad) + ' produced no narration');
        assert.ok(/FAIL/.test(out), 'verdict lost for entry ' + String(bad));
    }
    assert.doesNotThrow(() => formatGithubAnnotations(mk({ violations: [null] })));
});

test('[axis Z] an overflowing ratio is dropped, not printed as Infinity', () => {
    // 1e308 against a limit of 1 reported "+Infinity% over limit".
    const out = explainReport(mk({ violations: [{ metric: 'm', actual: 1e308, limit: 1, reason: 'r' }] }));
    assert.ok(!/Infinity/.test(out), 'printed a percentage that is not a number:\n' + out);
    assert.ok(/1e\+308/.test(out), 'the actual value should still be shown');
});

test('[axis Z] a zero limit still suppresses the ratio', () => {
    const out = explainReport(mk({ violations: [{ metric: 'm', actual: 500, limit: 0, reason: 'r' }] }));
    assert.ok(!/NaN|Infinity/.test(out), 'division by a zero limit leaked:\n' + out);
    assert.ok(/delta/.test(out), 'the delta should stand in for the ratio');
});

test('[axis Z] an unverified rule does not blame a cause it has not established', () => {
    // Since v1.5.2 a rule also lands in `checked:false` when the METRIC was
    // non-finite -- the source is fine and blaming it misdirects the reader.
    const out = explainReport({
        schema: 'lite-gc-report/1', kind: 'ops', verdict: 'inconclusive', source: 'gc',
        violations: [], checked: { maxBytesPerOp: false },
        result: { schema: 'lite-gc-ops/1', ops: 100, bytesPerOp: NaN }
    });
    assert.ok(/not verified/.test(out), 'must say the rule was not verified:\n' + out);
    assert.ok(!/^\s*maxBytesPerOp -- source "gc" cannot verify this rule$/m.test(out),
        'must not assert the source as the sole cause');
});

test('[axis Z] hostile inputs are rejected, not narrated into nonsense', () => {
    for (const bad of [null, undefined, 'x', 42, true, []]) {
        assert.throws(() => explainReport(bad), TypeError, 'explainReport(' + String(bad) + ')');
        assert.throws(() => gateBadge(bad), TypeError, 'gateBadge(' + String(bad) + ')');
    }
    assert.throws(() => explainDiff(mk({}), null), TypeError);
    assert.throws(() => explainReport({ ...mk({}), verdict: 'banana' }), TypeError);
});

test('[axis Z] real reports are unaffected by the sanitising', () => {
    const sink = [];
    const r = measureOps((i) => { sink.push(new Array(64).fill(i)); return i; },
        { ops: 300, warmup: 30, stabilize: true });
    const rep = checkOps(r, { maxBytesPerOp: 20 });
    assert.equal(rep.verdict, 'fail');
    const out = explainReport(rep, { color: false });
    assert.ok(/bytesPerOp/.test(out) && /actual/.test(out) && /limit/.test(out));
    assert.equal((formatGithubAnnotations(rep).match(/^::error/gm) || []).length, 1);
});
