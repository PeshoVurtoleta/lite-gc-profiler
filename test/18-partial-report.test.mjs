// Integration test for G16.5 -- the process.exit partial-report path.
// Spawns the CLI against a target script that calls process.exit(0) mid-work
// and asserts the CLI:
//   1. Does not error out (exit 3) as if the harness were broken
//   2. Emits exit code 2 (inconclusive) instead
//   3. Surfaces reason='partial_report' in the emitted report

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const CLI = resolve(PKG_ROOT, 'bin/LiteGcGate.mjs');

test('G16.5: target that calls process.exit(0) produces a partial report + exit code 2', () => {
    // Build a small target script that does a bit of work then hard-exits.
    // The register preload's beforeExit hook is bypassed, but the exit hook
    // (v1.3.0) should still write a partial report.
    const dir = mkdtempSync(join(tmpdir(), 'lite-gc-g165-'));
    const target = join(dir, 'hard-exit.mjs');
    writeFileSync(target, [
        '// Target under gate: does trivial work then hard-exits.',
        'for (let i = 0; i < 100; i++) { /* noop */ }',
        'process.exit(0);',
        ''
    ].join('\n'));

    // Point --config at an empty rule set so the gate uses defaults and
    // doesn't hit any fail path unrelated to the partial marker.
    const cfg = join(dir, 'gc-gate.json');
    writeFileSync(cfg, JSON.stringify({ rules: { maxMajor: 0 } }));

    const res = spawnSync(process.execPath, [
        CLI, 'run', target,
        '--reps', '1',
        '--config', cfg,
        '--format', 'json'
    ], { encoding: 'utf8', cwd: PKG_ROOT });

    // Exit code MUST be 2 (inconclusive), NOT 3 (infrastructure error).
    assert.equal(res.status, 2,
        'CLI exit code must be 2 (inconclusive) for a partial-report path, not 3; stderr=' + res.stderr);

    // JSON report must be emitted and carry the partial marker (reason field).
    let envelope;
    try { envelope = JSON.parse(res.stdout); }
    catch (e) { assert.fail('CLI did not emit valid JSON on stdout; got: ' + res.stdout); }
    const report = envelope.report || envelope;              // formatJson wraps report in {schema, version, report}
    assert.equal(report.verdict, 'inconclusive');
    assert.equal(report.reason, 'partial_report');
    assert.ok(Array.isArray(report.partial), 'partial info array must be present');
    assert.equal(report.partial.length, 1);
    assert.equal(report.partial[0].reason, 'process_exit');
    assert.equal(report.partial[0].exitCode, 0);
});

test('G16.5: target with non-zero process.exit(1) is still inconclusive (not exit-3 infrastructure error)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lite-gc-g165-'));
    const target = join(dir, 'hard-exit-nz.mjs');
    writeFileSync(target, [
        'for (let i = 0; i < 100; i++) {}',
        'process.exit(1);',
        ''
    ].join('\n'));
    const cfg = join(dir, 'gc-gate.json');
    writeFileSync(cfg, JSON.stringify({ rules: { maxMajor: 0 } }));

    const res = spawnSync(process.execPath, [
        CLI, 'run', target,
        '--reps', '1', '--config', cfg, '--format', 'json'
    ], { encoding: 'utf8', cwd: PKG_ROOT });

    assert.equal(res.status, 2, 'non-zero process.exit still yields exit 2 when a partial report was written; stderr=' + res.stderr);
    const envelope = JSON.parse(res.stdout);
    const report = envelope.report || envelope;
    assert.equal(report.reason, 'partial_report');
    assert.equal(report.partial[0].exitCode, 1);
});

test('G16.5: clean target (no process.exit) still writes a complete report + normal verdict', () => {
    // Sanity check: the exit handler must be a NO-OP when beforeExit already
    // handled the report. This is the "additive change stays additive" pin
    // for the register preload.
    const dir = mkdtempSync(join(tmpdir(), 'lite-gc-g165-'));
    const target = join(dir, 'clean.mjs');
    writeFileSync(target, [
        'for (let i = 0; i < 100; i++) {}',
        // Falls off the end -> beforeExit runs, exit handler is a no-op
        ''
    ].join('\n'));
    const cfg = join(dir, 'gc-gate.json');
    writeFileSync(cfg, JSON.stringify({ rules: { maxMajor: 0 } }));

    const res = spawnSync(process.execPath, [
        CLI, 'run', target,
        '--reps', '1', '--config', cfg, '--format', 'json'
    ], { encoding: 'utf8', cwd: PKG_ROOT });

    // Should be pass (0) since a trivial for-loop won't trigger a major.
    assert.equal(res.status, 0, 'clean run must produce exit 0; stderr=' + res.stderr);
    const envelope = JSON.parse(res.stdout);
    const report = envelope.report || envelope;
    assert.equal(report.verdict, 'pass');
    assert.ok(!report.partial, 'clean run must NOT carry a partial marker');
    assert.ok(!report.reason || report.reason !== 'partial_report');
});
