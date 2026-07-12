// Standard-case tests for formatters introduced in v1.3.0 (G7).
// Adversarial cases (empty violations arrays, unknown kinds, missing checked
// maps) covered by the axis-A/D discipline through basic assertion here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    checkNoGc, compareGc, gateReps, checkAgainstBaseline,
    aggregateGc, createBaseline,
    formatConsole, formatJson, formatMarkdown, formatGithubAnnotations
} from '../Gc.js';

function makeSummary(source, over) {
    const s = {
        schema: 'lite-gc/1', source, supported: source !== 'none',
        gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, p99Ms: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 },
        heap: { supported: source !== 'none', used: 0, peak: 0, firstSample: 0, samples: 0, allocBytes: 0, allocRateBytesPerSec: 0, gcDrops: 0, freedBytes: 0 },
        frames: { count: 0, long: 0 }, phases: {}
    };
    if (over) { if (over.gc) Object.assign(s.gc, over.gc); if (over.heap) Object.assign(s.heap, over.heap); }
    return s;
}
const clean = () => makeSummary('gc');
const dirty = (major) => makeSummary('gc', { gc: { major, count: major, totalMs: major * 5, maxMs: 5 } });

// ---- kind field wiring ----

test('checkNoGc report carries kind:"gc"', () => {
    assert.equal(checkNoGc(clean()).kind, 'gc');
    assert.equal(checkNoGc(dirty(1), { maxMajor: 0 }).kind, 'gc');
});

test('compareGc report carries kind:"compare"', () => {
    assert.equal(compareGc(clean(), clean()).kind, 'compare');
    // Source mismatch path also
    assert.equal(compareGc(clean(), makeSummary('heap')).kind, 'compare');
});

test('gateReps report carries kind:"reps"', () => {
    assert.equal(gateReps([clean(), clean()], { maxMajor: 0 }).kind, 'reps');
    // Mixed-source inconclusive path
    assert.equal(gateReps([clean(), makeSummary('heap')], { maxMajor: 0 }).kind, 'reps');
});

test('checkAgainstBaseline report carries kind:"baseline"', () => {
    const baseline = createBaseline(aggregateGc([clean()]));
    assert.equal(checkAgainstBaseline(aggregateGc([clean()]), baseline).kind, 'baseline');
    // Invalid baseline path also
    assert.equal(checkAgainstBaseline(aggregateGc([clean()]), null).kind, 'baseline');
});

// ---- formatConsole ----

test('formatConsole: pass report shows verdict banner', () => {
    const s = formatConsole(checkNoGc(clean()));
    assert.match(s, /GC gate: PASS/);
    assert.match(s, /source=gc/);
});

test('formatConsole: fail report lists violations', () => {
    const s = formatConsole(checkNoGc(dirty(3), { maxMajor: 0 }));
    assert.match(s, /GC gate: FAIL/);
    assert.match(s, /Violations:/);
    assert.match(s, /gc\.major/);
});

test('formatConsole: inconclusive report lists unverifiable rules', () => {
    const s = formatConsole(checkNoGc(makeSummary('none'), { maxMajor: 0 }));
    assert.match(s, /GC gate: INCONCLUSIVE/);
    assert.match(s, /Unverifiable rules:/);
    assert.match(s, /maxMajor/);
});

test('formatConsole: differential shows control/candidate sources', () => {
    const s = formatConsole(compareGc(clean(), dirty(1), { maxExtraMajor: 0 }));
    assert.match(s, /differential/);
    assert.match(s, /control=gc/);
    assert.match(s, /candidate=gc/);
});

test('formatConsole: reps report shows applied policy per rule', () => {
    const reps = [clean(), clean(), clean()];
    const s = formatConsole(gateReps(reps, { maxMajor: 0, maxPauseMs: 4 }));
    assert.match(s, /reps=3/);
    assert.match(s, /maxMajor/);
    assert.match(s, /all-clean/);
    assert.match(s, /best-clean/);
});

test('formatConsole: baseline fingerprint-mismatch shows both fingerprints', () => {
    const agg = aggregateGc([clean()]);
    const baseline = createBaseline(agg);
    baseline.fingerprint = { node: 'v14.0.0', v8: '0.0.0', platform: 'other', arch: 'other', cpu: 'other' };
    const s = formatConsole(checkAgainstBaseline(agg, baseline));
    assert.match(s, /Baseline:/);
    assert.match(s, /Current:/);
    assert.match(s, /v14\.0\.0/);
});

// ---- formatJson ----

test('formatJson: wraps report in versioned envelope', () => {
    const out = formatJson(checkNoGc(clean()));
    const parsed = JSON.parse(out);
    assert.equal(parsed.schema, 'lite-gc-report/1');
    assert.equal(typeof parsed.version, 'string');
    assert.equal(typeof parsed.generatedAt, 'string');
    assert.equal(parsed.report.kind, 'gc');
    assert.equal(parsed.report.verdict, 'pass');
});

test('formatJson: round-trippable', () => {
    const rep = checkNoGc(dirty(2), { maxMajor: 0 });
    const parsed = JSON.parse(formatJson(rep));
    assert.equal(parsed.report.violations.length, rep.violations.length);
});

// ---- formatMarkdown ----

test('formatMarkdown: pass report has PASS in heading', () => {
    const s = formatMarkdown(checkNoGc(clean()));
    assert.match(s, /### GC gate: `PASS`/);
});

test('formatMarkdown: fail report renders violations table', () => {
    const s = formatMarkdown(checkNoGc(dirty(2), { maxMajor: 0 }));
    assert.match(s, /\*\*Violations\*\*/);
    assert.match(s, /\| metric \| reason \|/);
});

test('formatMarkdown: inconclusive report renders unverifiable list', () => {
    const s = formatMarkdown(checkNoGc(makeSummary('none'), { maxMajor: 0 }));
    assert.match(s, /Unverifiable rules/);
});

test('formatMarkdown: reps report renders Reps: line', () => {
    const s = formatMarkdown(gateReps([clean(), clean()], { maxMajor: 0 }));
    assert.match(s, /Reps: 2/);
});

test('formatMarkdown: baseline fingerprint-accepted shows audit line', () => {
    const agg = aggregateGc([clean()]);
    const baseline = createBaseline(agg);
    baseline.fingerprint = { node: 'v14.0.0', v8: '0.0.0', platform: 'other', arch: 'other', cpu: 'other' };
    const s = formatMarkdown(checkAgainstBaseline(agg, baseline, { acceptFingerprintMismatch: true }));
    assert.match(s, /Fingerprint mismatch accepted/);
});

// ---- formatGithubAnnotations ----

test('formatGithubAnnotations: pass emits ::notice::', () => {
    const s = formatGithubAnnotations(checkNoGc(clean()));
    assert.match(s, /^::notice /);
    assert.match(s, /gate passed/);
});

test('formatGithubAnnotations: fail emits one ::error:: per violation', () => {
    const rep = checkNoGc(dirty(2), { maxMajor: 0, maxPauseMs: 1 });
    const s = formatGithubAnnotations(rep);
    const errorLines = s.split('\n').filter((l) => l.startsWith('::error'));
    assert.equal(errorLines.length, rep.violations.length);
});

test('formatGithubAnnotations: inconclusive emits ::warning:: naming rules', () => {
    const s = formatGithubAnnotations(checkNoGc(makeSummary('none'), { maxMajor: 0 }));
    assert.match(s, /^::warning /);
    assert.match(s, /maxMajor/);
});

test('formatGithubAnnotations: inconclusive with reason includes reason', () => {
    const s = formatGithubAnnotations(compareGc(clean(), makeSummary('heap'), { maxExtraMajor: 0 }));
    assert.match(s, /::warning /);
    assert.match(s, /source_mismatch/);
});

// ---- all formatters accept all report shapes without throwing ----

test('all formatters accept all four report kinds without throwing', () => {
    const reports = [
        checkNoGc(clean()),
        compareGc(clean(), clean()),
        gateReps([clean(), clean()], { maxMajor: 0 }),
        checkAgainstBaseline(aggregateGc([clean()]), createBaseline(aggregateGc([clean()])))
    ];
    for (const rep of reports) {
        assert.equal(typeof formatConsole(rep), 'string');
        assert.equal(typeof formatJson(rep), 'string');
        assert.equal(typeof formatMarkdown(rep), 'string');
        assert.equal(typeof formatGithubAnnotations(rep), 'string');
    }
});
