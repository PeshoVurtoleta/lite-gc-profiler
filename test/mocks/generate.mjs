// Regenerates the canonical report mocks in this folder from the REAL Gc.js
// API. Run intentionally, never by the test runner:
//
//   node --expose-gc test/mocks/generate.mjs
//
// The four hand-built reports (pass/fail/inconclusive/baseline/aggregate) are
// built from all-zero summaries, so they are byte-stable across machines and
// runs. cli-run.json is a snapshot of a real measured `lite-gc-gate --json`
// run: its numbers vary by host, so the mock test asserts only its SHAPE and
// verdict, never exact values. The point of these fixtures is a fixed,
// documented example of every report the library emits -- and a guard that the
// formatters/baseline/aggregate consumers keep accepting them (repo wins: if a
// shape changes, regenerate).

import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import {
    checkNoGc, aggregateGc, createBaseline, aggregateWorkerReports
} from '../../Gc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..', '..');

// A fully-populated lite-gc/1 summary, all zero unless overridden. Mirrors the
// hand-built summaries the formatter/verdict tests use so the mocks match the
// exact production shape.
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

const write = (name, obj) => {
    writeFileSync(join(HERE, name), JSON.stringify(obj, null, 2) + '\n');
    // eslint-disable-next-line no-console
    console.log('wrote', name);
};

// --- 1. PASS: a clean gc-source summary against a real (nonempty) rule set ---
write('report-pass.json',
    checkNoGc(makeSummary('gc'), { maxMajor: 0, maxMinor: 0, maxPauseMs: 4 }));

// --- 2. FAIL: a major-GC violation the gate can PROVE (source='gc') ---------
write('report-fail.json',
    checkNoGc(makeSummary('gc', { gc: { major: 3, count: 3, totalMs: 15, maxMs: 5 } }),
        { maxMajor: 0 }));

// --- 3. INCONCLUSIVE: source='none' cannot verify a kind rule ---------------
// The canonical fail-closed third state: a rule the source cannot resolve
// routes to inconclusive, never a silent pass.
write('report-inconclusive.json',
    checkNoGc(makeSummary('none'), { maxMajor: 0 }));

// --- 4. BASELINE: createBaseline over an aggregate of clean summaries -------
write('baseline.json', createBaseline(aggregateGc([makeSummary('gc'), makeSummary('gc')])));

// --- 5. AGGREGATE: aggregateWorkerReports over lite-gc-ops/1 contexts -------
const opsReport = (ops, majors, minors, pause, bytes) => ({
    schema: 'lite-gc-ops/1', ops, source: 'gc', bytesPerOp: bytes,
    bytesPerOpStable: true, majorsPerKOp: majors, minorsPerKOp: minors,
    maxPauseMsPerOp: pause
});
write('aggregate-workers.json',
    aggregateWorkerReports([opsReport(1000, 0, 4, 0.2, 0), opsReport(3000, 0, 2, 0.1, 0)]));

// --- 6. CLI --json: a real measured run against the CLEAN fixture -----------
const CLI = resolve(PKG_ROOT, 'bin/LiteGcGate.mjs');
const CLEAN = resolve(HERE, '..', 'fixtures/TargetClean.mjs');
const res = spawnSync(process.execPath, [CLI, 'run', CLEAN, '--format', 'json'],
    { encoding: 'utf8', cwd: PKG_ROOT });
const parsed = JSON.parse(res.stdout);
write('cli-run.json', parsed);

// eslint-disable-next-line no-console
console.log('\ncli verdict:', parsed.verdict, '| exit', res.status);
