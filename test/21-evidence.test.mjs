// Standard-case tests for the evidence-lane formatters introduced in Batch 9
// (v1.6.0, G21/G22): explainReport, explainDiff, gateBadge. Adversarial cases
// live in test/torture/g21-5-evidence.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    measureOps, checkOps, compareOps,
    measureFrames, checkFrames,
    measureOpsAsync, checkOpsAsync
} from '../Gc.js';
import { explainReport, explainDiff, gateBadge } from '../Explain.js';

const noop = (i) => i | 0;
const fastSched = (cb) => setTimeout(cb, 0);

// -----------------------------------------------------------------------------
// explainReport -- pass/fail/inconclusive across the three lanes
// -----------------------------------------------------------------------------

test('explainReport: sync ops pass renders header + verified count', () => {
    const r = measureOps(noop, { ops: 200, warmup: 40, stabilize: true });
    const rep = checkOps(r, { maxBytesPerOp: 512 });
    const out = explainReport(rep);
    assert.match(out, /gc-gate:\s+PASS\s+--\s+ops/);
    assert.match(out, /verified/);
});

test('explainReport: sync ops fail names the rule and shows actual/limit/delta', () => {
    const sink = [];
    const leak = measureOps((i) => { sink.push(new Array(64).fill(i)); },
        { ops: 200, warmup: 40, stabilize: true });
    const rep = checkOps(leak, { maxBytesPerOp: 50 });
    assert.equal(rep.verdict, 'fail');
    const out = explainReport(rep);
    assert.match(out, /gc-gate:\s+FAIL\s+--\s+ops/);
    assert.match(out, /Violations \(1\):/);
    assert.match(out, /bytesPerOp/);
    assert.match(out, /actual:/);
    assert.match(out, /limit:\s+50/);
    // Delta annotation with sign + percent-over
    assert.match(out, /\+\d/);
});

test('explainReport: source=none produces INCONCLUSIVE with a Cannot verify block', () => {
    const r = measureOps(noop, { ops: 100, source: 'none' });
    const rep = checkOps(r, { maxBytesPerOp: 5 });
    assert.equal(rep.verdict, 'inconclusive');
    const out = explainReport(rep);
    assert.match(out, /INCONCLUSIVE/);
    assert.match(out, /Cannot verify/);
    assert.match(out, /source "none"/);
});

test('explainReport: frames pass includes Run block with source and stabilized flag', async () => {
    const r = await measureFrames(noop, { frames: 60, warmup: 10, scheduler: fastSched });
    const rep = checkFrames(r, { maxDroppedFrames: 30 });
    const out = explainReport(rep);
    assert.match(out, /gc-gate:\s+PASS\s+--\s+frames/);
    assert.match(out, /Run:/);
    assert.match(out, /frames:\s+60/);
    assert.match(out, /source:\s+gc/);
    // Under --expose-gc (test script sets it), stabilize defaults on.
    assert.match(out, /stabilized:\s+yes/);
});

test('explainReport: ops-async pass includes stabilized:yes on --expose-gc', async () => {
    const r = await measureOpsAsync(async (i) => i | 0, { ops: 100, warmup: 20 });
    const rep = checkOpsAsync(r, { maxBytesPerOp: 512 });
    const out = explainReport(rep);
    assert.match(out, /gc-gate:\s+PASS\s+--\s+ops-async/);
    assert.match(out, /stabilized:\s+yes/);
});

test('explainReport: compare report emits a Comparison block with control/candidate metrics', () => {
    // Two identical noop workloads -- passes on a comfortable delta rule.
    const rep = compareOps(noop, noop, { maxExtraBytesPerOp: 1024 },
        { ops: 200, warmup: 40, stabilize: true });
    const out = explainReport(rep);
    assert.match(out, /Comparison:/);
    // At least one metric printed in the control=/candidate= shape.
    assert.match(out, /control=.*candidate=/);
});

test('explainReport: colour option emits ANSI escapes when true, none when false', () => {
    const r = measureOps(noop, { ops: 100, warmup: 20, stabilize: true });
    const rep = checkOps(r, { maxBytesPerOp: 1024 });
    const bare = explainReport(rep, { colour: false });
    const coloured = explainReport(rep, { colour: true });
    // Default false -- no ANSI in the plain output.
    assert.ok(!bare.includes('\x1b['), 'no ANSI when colour=false');
    // Colour=true -- at least one ANSI escape in the verdict tag.
    assert.ok(coloured.includes('\x1b['), 'ANSI present when colour=true');
});

test('explainReport: maxViolations caps the list and appends an overflow line', () => {
    // Synthesize a fake fail report with many violations. This exercises the
    // formatter's cap logic without needing a workload that violates 20 rules.
    const rep = {
        schema: 'lite-gc-report/1',
        kind: 'ops',
        verdict: 'fail',
        source: 'gc',
        checked: { maxBytesPerOp: true },
        violations: []
    };
    for (let i = 0; i < 20; i++) {
        rep.violations.push({ rule: 'maxBytesPerOp', metric: 'bytesPerOp', actual: 100 + i, limit: 50 });
    }
    const out = explainReport(rep, { maxViolations: 5 });
    assert.match(out, /Violations \(20\):/);
    assert.match(out, /and 15 more/);
});

// -----------------------------------------------------------------------------
// explainReport -- input validation
// -----------------------------------------------------------------------------

test('explainReport: rejects non-report inputs with a TypeError', () => {
    assert.throws(() => explainReport(null), TypeError);
    assert.throws(() => explainReport(undefined), TypeError);
    assert.throws(() => explainReport(42), TypeError);
    assert.throws(() => explainReport('not a report'), TypeError);
    assert.throws(() => explainReport({}), TypeError);                    // no verdict
    assert.throws(() => explainReport({ verdict: 'weird' }), TypeError);  // bad verdict value
});

test('explainReport: accepts reports without an explicit schema tag (legacy shape)', () => {
    // Older check* paths emit reports without schema:'lite-gc-report/1' -- the
    // formatter must still handle them so baselines on disk keep rendering.
    const legacy = {
        kind: 'ops',
        verdict: 'pass',
        source: 'gc',
        checked: {},
        violations: []
    };
    const out = explainReport(legacy);
    assert.match(out, /PASS/);
});

test('explainReport: rejects an unknown schema value', () => {
    assert.throws(() => explainReport({
        schema: 'lite-gc-report/999',
        verdict: 'pass',
        violations: [],
        checked: {}
    }), TypeError);
});

// -----------------------------------------------------------------------------
// explainDiff
// -----------------------------------------------------------------------------

test('explainDiff: names control + candidate verdicts and per-metric deltas', () => {
    const clean = measureOps(noop, { ops: 200, warmup: 40, stabilize: true });
    const cleanRep = checkOps(clean, { maxBytesPerOp: 1024 });
    const sink = [];
    const leaky = measureOps((i) => { sink.push(new Array(64).fill(i)); },
        { ops: 200, warmup: 40, stabilize: true });
    const leakyRep = checkOps(leaky, { maxBytesPerOp: 1024 });
    const out = explainDiff(cleanRep, leakyRep);
    assert.match(out, /Control:\s+PASS/);
    // leaky may pass or fail vs 1024 threshold; assert the verdict tag is one of them.
    assert.match(out, /Candidate:\s+(PASS|FAIL|INCONCLUSIVE)/);
});

test('explainDiff: kind mismatch is surfaced in the header, not thrown', () => {
    const ops = measureOps(noop, { ops: 100, warmup: 20, stabilize: true });
    const opsRep = checkOps(ops, { maxBytesPerOp: 1024 });
    const asyncR = { schema: 'lite-gc-report/1', kind: 'ops-async', verdict: 'pass',
                     source: 'gc', violations: [], checked: {},
                     result: { source: 'gc', bytesPerOp: 3 } };
    const out = explainDiff(opsRep, asyncR);
    assert.match(out, /kind mismatch/);
});

test('explainDiff: both arguments validated as reports', () => {
    const ok = { kind: 'ops', verdict: 'pass', violations: [], checked: {} };
    assert.throws(() => explainDiff(null, ok), TypeError);
    assert.throws(() => explainDiff(ok, null), TypeError);
});

// -----------------------------------------------------------------------------
// gateBadge -- three formats
// -----------------------------------------------------------------------------

test('gateBadge: text format returns "label: message" for pass and fail', () => {
    const passR = { verdict: 'pass', violations: [], checked: {} };
    const failR = { verdict: 'fail', violations: [{ rule: 'x', actual: 1, limit: 0 }], checked: {} };
    assert.equal(gateBadge(passR, { format: 'text' }), 'gc gate: pass');
    assert.equal(gateBadge(failR, { format: 'text' }), 'gc gate: fail (1)');
});

test('gateBadge: text format default is text (no opts.format)', () => {
    const passR = { verdict: 'pass', violations: [], checked: {} };
    assert.equal(gateBadge(passR), 'gc gate: pass');
});

test('gateBadge: shields-json format returns valid endpoint schema', () => {
    const failR = { verdict: 'fail', violations: [{ rule: 'x', actual: 1, limit: 0 }, { rule: 'y', actual: 5, limit: 1 }],
                    checked: {} };
    const json = gateBadge(failR, { format: 'shields-json' });
    const parsed = JSON.parse(json);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.label, 'gc gate');
    assert.equal(parsed.message, 'fail (2)');
    assert.equal(parsed.color, 'red');
});

test('gateBadge: shields colours match the verdict (pass green, fail red, inconclusive yellow)', () => {
    const p = JSON.parse(gateBadge({ verdict: 'pass', violations: [], checked: {} }, { format: 'shields-json' }));
    const f = JSON.parse(gateBadge({ verdict: 'fail', violations: [], checked: {} }, { format: 'shields-json' }));
    const i = JSON.parse(gateBadge({ verdict: 'inconclusive', violations: [], checked: {} }, { format: 'shields-json' }));
    assert.equal(p.color, 'brightgreen');
    assert.equal(f.color, 'red');
    assert.equal(i.color, 'yellow');
});

test('gateBadge: svg format returns a valid-shaped SVG string', () => {
    const passR = { verdict: 'pass', violations: [], checked: {} };
    const svg = gateBadge(passR, { format: 'svg' });
    assert.match(svg, /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /<\/svg>$/);
    // Must contain the label and message text.
    assert.ok(svg.includes('gc gate'), 'svg must include the label text');
    assert.ok(svg.includes('pass'), 'svg must include the verdict text');
});

test('gateBadge: custom label is passed through in all formats', () => {
    const rep = { verdict: 'pass', violations: [], checked: {} };
    assert.equal(gateBadge(rep, { format: 'text', label: 'my-lib' }), 'my-lib: pass');
    const json = JSON.parse(gateBadge(rep, { format: 'shields-json', label: 'my-lib' }));
    assert.equal(json.label, 'my-lib');
});

test('gateBadge: unknown format throws RangeError', () => {
    const rep = { verdict: 'pass', violations: [], checked: {} };
    assert.throws(() => gateBadge(rep, { format: 'markdown' }), RangeError);
});

test('gateBadge: rejects non-report inputs', () => {
    assert.throws(() => gateBadge(null), TypeError);
    assert.throws(() => gateBadge({}), TypeError);
});
