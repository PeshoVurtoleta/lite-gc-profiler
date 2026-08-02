// Proof that the committed report mocks in test/mocks/ are REAL reports, not
// decorative JSON: each one must round-trip through the actual consumer that
// eats its shape and yield the verdict its filename claims. If a report shape
// ever changes, this test goes red and the fixtures get regenerated
// (`node --expose-gc test/mocks/generate.mjs`) -- the repo, not the mock, wins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    formatConsole, formatJson, formatMarkdown,
    aggregateGc, checkAgainstBaseline, ratchetBaseline,
    checkAggregateReport
} from '../Gc.js';
import { loadMock, MOCK_NAMES } from './mocks/mocks.mjs';

const VERDICTS = new Set(['pass', 'fail', 'inconclusive']);

// A clean gc-source aggregate to check the baseline mock against.
function cleanSummary() {
    return {
        schema: 'lite-gc/1', source: 'gc', supported: true,
        gc: { count: 0, totalMs: 0, maxMs: 0, avgMs: 0, p99Ms: 0, minor: 0, major: 0, incremental: 0, weakcb: 0 },
        heap: { supported: true, used: 0, peak: 0, firstSample: 0, samples: 0, allocBytes: 0, allocRateBytesPerSec: 0, gcDrops: 0, freedBytes: 0 },
        frames: { count: 0, long: 0 }, phases: {}
    };
}

// ---------------------------------------------------------------------------
// Every mock file loads and is a non-null object.
// ---------------------------------------------------------------------------

test('every named mock loads as an object', () => {
    for (const name of MOCK_NAMES) {
        const m = loadMock(name);
        assert.equal(typeof m, 'object');
        assert.notEqual(m, null, name + ' loaded null');
    }
});

// ---------------------------------------------------------------------------
// The three gate-report mocks carry the verdict their filename claims, and
// survive every formatter with that verdict intact.
// ---------------------------------------------------------------------------

const BANNER = { pass: /PASS/, fail: /FAIL/, inconclusive: /INCONCLUSIVE/ };

for (const verdict of ['pass', 'fail', 'inconclusive']) {
    test('report-' + verdict + ' mock has verdict "' + verdict + '"', () => {
        assert.equal(loadMock('report-' + verdict).verdict, verdict);
    });

    test('report-' + verdict + ' mock survives formatConsole with the right banner', () => {
        const s = formatConsole(loadMock('report-' + verdict));
        assert.match(s, BANNER[verdict]);
    });

    test('report-' + verdict + ' mock round-trips through formatJson intact', () => {
        const env = JSON.parse(formatJson(loadMock('report-' + verdict)));
        assert.equal(env.schema, 'lite-gc-report/1');
        assert.equal(env.report.verdict, verdict,
            'formatJson must preserve the verdict inside its envelope');
    });

    test('report-' + verdict + ' mock survives formatMarkdown without throwing', () => {
        const md = formatMarkdown(loadMock('report-' + verdict));
        assert.equal(typeof md, 'string');
        assert.ok(md.length > 0);
    });
}

// ---------------------------------------------------------------------------
// The baseline mock is a usable committed floor: a clean run checks green
// against it, and ratcheting it with an equal aggregate tightens nothing.
// ---------------------------------------------------------------------------

test('baseline mock: a clean aggregate passes checkAgainstBaseline', () => {
    const rep = checkAgainstBaseline(aggregateGc([cleanSummary()]), loadMock('baseline'));
    assert.equal(rep.kind, 'baseline');
    assert.equal(rep.verdict, 'pass');
});

test('baseline mock: ratcheting against an equal aggregate holds (nothing tightened)', () => {
    const r = ratchetBaseline(loadMock('baseline'), aggregateGc([cleanSummary()]));
    assert.equal(r.ratcheted, false);
    assert.deepEqual(r.changed, []);
    assert.equal(r.baseline.schema, 'lite-gc-baseline/1');
});

// ---------------------------------------------------------------------------
// The aggregate mock is a real multi-context envelope a gate can consume.
// ---------------------------------------------------------------------------

test('aggregate-workers mock: shape + a passing byte gate', () => {
    const multi = loadMock('aggregate-workers');
    assert.equal(multi.schema, 'lite-gc-ops-multi/1');
    assert.equal(multi.kind, 'ops-multi');
    assert.equal(multi.contexts, multi.perContext.length);
    const rep = checkAggregateReport(multi, { maxBytesPerOp: 1 });
    assert.equal(VERDICTS.has(rep.verdict), true);
    assert.equal(rep.verdict, 'pass', 'zero-byte contexts must pass a 1-byte gate');
});

// ---------------------------------------------------------------------------
// The CLI mock is the `--format json` envelope: an outer report wrapper with a
// valid verdict inside. (Its numbers and generatedAt vary by host, so only the
// shape and verdict are asserted.)
// ---------------------------------------------------------------------------

test('cli-run mock: lite-gc-report/1 envelope wrapping a valid verdict', () => {
    const env = loadMock('cli-run');
    assert.equal(env.schema, 'lite-gc-report/1');
    assert.equal(typeof env.report, 'object');
    assert.equal(VERDICTS.has(env.report.verdict), true,
        'nested report.verdict must be one of the three states');
});
