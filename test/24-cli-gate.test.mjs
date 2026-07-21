// CLI surface coverage: every exit code and every argument branch of
// bin/LiteGcGate.mjs, plus the two Register.mjs write-failure catches the
// CLI can never reach on its own (it always hands the target a writable
// report path).
//
// Motivation: the v1.9.0 coverage gate (>=95% lines / functions). At
// v1.8.0 the CLI sat at 74% lines / 38% branch -- the usage paths, the
// non-console formatters, the --json side channel, the multi-rep gate,
// the whole baseline flow and the infrastructure-error exits were pinned
// by nothing. A gate whose own gatekeeper is untested is the fail-open
// shape TORTURE.md exists to kill.
//
// Exit-code contract under test:
//   0 -- pass, 1 -- fail, 2 -- inconclusive, 3 -- infrastructure error

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const CLI = resolve(PKG_ROOT, 'bin/LiteGcGate.mjs');
const REGISTER = resolve(PKG_ROOT, 'Register.mjs');
const CLEAN = resolve(HERE, 'fixtures/TargetClean.mjs');
const DIRTY = resolve(HERE, 'fixtures/TargetDirty.mjs');
const TRUNCATED = resolve(HERE, 'fixtures/TargetTruncatedReport.mjs');

function cli(args, opts) {
    return spawnSync(process.execPath, [CLI].concat(args),
        Object.assign({ encoding: 'utf8', cwd: PKG_ROOT }, opts));
}

// ---------------------------------------------------------------------------
// Usage / argument-parsing errors: all exit 3, all name the offence.
// ---------------------------------------------------------------------------

test('CLI: no arguments -> exit 3 with usage text', () => {
    const res = cli([]);
    assert.equal(res.status, 3);
    assert.match(res.stderr, /first argument must be "run"/);
    assert.match(res.stderr, /Usage: lite-gc-gate run/);
});

test('CLI: "run" without a script path -> exit 3', () => {
    const res = cli(['run']);
    assert.equal(res.status, 3);
    assert.match(res.stderr, /missing <script> path/);
});

test('CLI: unknown argument -> exit 3 naming the argument', () => {
    const res = cli(['run', CLEAN, '--frobnicate']);
    assert.equal(res.status, 3);
    assert.match(res.stderr, /unknown arg: --frobnicate/);
});

test('CLI: non-positive --reps -> exit 3', () => {
    const res = cli(['run', CLEAN, '--reps', '0']);
    assert.equal(res.status, 3);
    assert.match(res.stderr, /--reps must be positive/);
});

test('CLI: non-numeric --reps -> exit 3', () => {
    const res = cli(['run', CLEAN, '--reps', 'many']);
    assert.equal(res.status, 3);
    assert.match(res.stderr, /--reps must be positive/);
});

test('CLI: script path that does not exist -> exit 3', () => {
    const res = cli(['run', join(HERE, 'fixtures/NoSuchTarget.mjs')]);
    assert.equal(res.status, 3);
    assert.match(res.stderr, /script not found/);
});

test('CLI: unreadable --config -> exit 3', () => {
    const res = cli(['run', CLEAN, '--config', join(HERE, 'fixtures/no-such-config.json')]);
    assert.equal(res.status, 3);
    assert.match(res.stderr, /failed to load config/);
});

test('CLI: --config that is not JSON -> exit 3', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lite-gc-g24cli-'));
    const cfg = join(dir, 'broken.json');
    writeFileSync(cfg, '{ rules: not json');
    const res = cli(['run', CLEAN, '--config', cfg]);
    assert.equal(res.status, 3);
    assert.match(res.stderr, /failed to load config/);
});

// ---------------------------------------------------------------------------
// Verdict exits: pass=0 on the clean fixture, fail=1 on the dirty one.
// ---------------------------------------------------------------------------

function writeConfig(dir, rules) {
    const cfg = join(dir, 'gc-gate.json');
    writeFileSync(cfg, JSON.stringify({ rules }));
    return cfg;
}

test('CLI: clean target under generous rules -> exit 0, markdown format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lite-gc-g24cli-'));
    const cfg = writeConfig(dir, { maxMajor: 8 });
    const res = cli(['run', CLEAN, '--config', cfg, '--format', 'markdown']);
    assert.equal(res.status, 0, 'expected pass; stderr=' + res.stderr + ' stdout=' + res.stdout);
    assert.match(res.stdout, /^### /, 'markdown formatter emits a ### heading');
    assert.match(res.stdout, /`PASS`/);
});

test('CLI: dirty target under maxMajor 0 -> exit 1, github annotations on stdout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lite-gc-g24cli-'));
    const cfg = writeConfig(dir, { maxMajor: 0 });
    const res = cli(['run', DIRTY, '--config', cfg, '--format', 'github']);
    assert.equal(res.status, 1, 'expected fail; stderr=' + res.stderr + ' stdout=' + res.stdout);
    assert.match(res.stdout, /::error title=lite-gc-profiler::/);
});

test('CLI: default console format still reports the verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lite-gc-g24cli-'));
    const cfg = writeConfig(dir, { maxMajor: 8 });
    const res = cli(['run', CLEAN, '--config', cfg]);
    assert.equal(res.status, 0, 'stderr=' + res.stderr);
    assert.match(res.stdout.toLowerCase(), /pass/);
});

test('CLI: --reps 2 routes through the multi-rep gate and still exits 0 on clean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lite-gc-g24cli-'));
    const cfg = writeConfig(dir, { maxMajor: 8 });
    const res = cli(['run', CLEAN, '--reps', '2', '--config', cfg, '--format', 'json']);
    assert.equal(res.status, 0, 'stderr=' + res.stderr + ' stdout=' + res.stdout);
    const envelope = JSON.parse(res.stdout);
    const report = envelope.report || envelope;
    assert.equal(report.kind, 'reps', 'two reps must gate via gateReps, not checkNoGc');
    assert.equal(report.reps, 2);
});

// ---------------------------------------------------------------------------
// --json side channel: written on success, warns without changing the
// verdict when the path is unwritable.
// ---------------------------------------------------------------------------

test('CLI: --json writes a parseable envelope next to the stdout report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lite-gc-g24cli-'));
    const cfg = writeConfig(dir, { maxMajor: 8 });
    const out = join(dir, 'report.json');
    const res = cli(['run', CLEAN, '--config', cfg, '--json', out]);
    assert.equal(res.status, 0, 'stderr=' + res.stderr);
    assert.ok(existsSync(out), '--json file must exist');
    const envelope = JSON.parse(readFileSync(out, 'utf8'));
    const report = envelope.report || envelope;
    assert.equal(report.verdict, 'pass');
});

test('CLI: unwritable --json path warns on stderr but the verdict exit wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lite-gc-g24cli-'));
    const cfg = writeConfig(dir, { maxMajor: 8 });
    const out = join(dir, 'no-such-subdir', 'report.json');
    const res = cli(['run', CLEAN, '--config', cfg, '--json', out]);
    assert.equal(res.status, 0, 'a broken side channel must not fail a passing gate');
    assert.match(res.stderr, /--json write failed/);
});

// ---------------------------------------------------------------------------
// Baseline flow: write, check, corrupt-load, write-failure.
// ---------------------------------------------------------------------------

test('CLI: --update-baseline writes the file and exits 0; a rerun against it passes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lite-gc-g24cli-'));
    const baselinePath = join(dir, 'baseline.json');

    const wrote = cli(['run', CLEAN, '--baseline', baselinePath, '--update-baseline']);
    assert.equal(wrote.status, 0, 'stderr=' + wrote.stderr);
    assert.match(wrote.stdout, /baseline written to/);
    assert.ok(existsSync(baselinePath));
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    assert.match(String(baseline.schema), /baseline/, 'baseline JSON must carry its schema tag');
    assert.ok(baseline.fingerprint, 'baseline JSON must carry a fingerprint');
    assert.ok(baseline.gc, 'baseline JSON must carry the gc stats map');

    // Deterministic check leg: this test pins the CLI's load-and-compare
    // path, not machine stability. Under full-suite parallelism a 1-rep
    // baseline max is routinely crossed by scheduler noise (which is the
    // library working as designed, and this test flaking as designed).
    // Inflate every max so current.median > baseline.max is impossible;
    // the fingerprint stays as captured, so the comparison is exercised
    // for real rather than short-circuiting inconclusive.
    for (const block of [baseline.gc, baseline.heap, baseline.uasm]) {
        if (!block) continue;
        for (const k in block) { block[k].max = 1e12; block[k].min = 0; }
    }
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));

    const checked = cli(['run', CLEAN, '--baseline', baselinePath, '--format', 'json']);
    assert.equal(checked.status, 0,
        'clean target vs its own baseline must pass; stderr=' + checked.stderr + ' stdout=' + checked.stdout);
    const envelope = JSON.parse(checked.stdout);
    const report = envelope.report || envelope;
    assert.equal(report.verdict, 'pass');
});

test('CLI: corrupt baseline file -> exit 3', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lite-gc-g24cli-'));
    const baselinePath = join(dir, 'baseline.json');
    writeFileSync(baselinePath, 'not json at all');
    const res = cli(['run', CLEAN, '--baseline', baselinePath]);
    assert.equal(res.status, 3);
    assert.match(res.stderr, /failed to load baseline/);
});

test('CLI: --update-baseline to an unwritable path -> exit 3', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lite-gc-g24cli-'));
    const baselinePath = join(dir, 'no-such-subdir', 'baseline.json');
    const res = cli(['run', CLEAN, '--baseline', baselinePath, '--update-baseline']);
    assert.equal(res.status, 3);
    assert.match(res.stderr, /baseline write failed/);
});

// ---------------------------------------------------------------------------
// Infrastructure error: a target killed hard enough that not even the
// Register exit hook runs leaves no report -> exit 3, not a fake verdict.
// ---------------------------------------------------------------------------

test('CLI: SIGKILLed target leaves no report -> exit 3 infrastructure error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lite-gc-g24cli-'));
    const target = join(dir, 'sigkill.mjs');
    writeFileSync(target, [
        '// Target under gate: kills itself before any exit hook can run.',
        "process.kill(process.pid, 'SIGKILL');",
        ''
    ].join('\n'));
    const res = cli(['run', target]);
    assert.equal(res.status, 3, 'no report may never become a verdict; stdout=' + res.stdout);
    assert.match(res.stderr, /did not write a report/);
});

// ---------------------------------------------------------------------------
// Register.mjs write-failure catches. The CLI always supplies a writable
// report path, so these two stderr lanes are reachable only by driving the
// register preload directly with a doomed LITE_GC_GATE_REPORT_PATH.
// ---------------------------------------------------------------------------

function runRegistered(evalSrc, reportPath) {
    return spawnSync(process.execPath, [
        '--expose-gc',
        '--import', 'data:text/javascript,import ' + JSON.stringify('file://' + REGISTER),
        '-e', evalSrc
    ], {
        encoding: 'utf8',
        cwd: PKG_ROOT,
        env: Object.assign({}, process.env, { LITE_GC_GATE_REPORT_PATH: reportPath })
    });
}

test('Register: unwritable report path surfaces on stderr without failing the target', () => {
    const doomed = join(tmpdir(), 'lite-gc-no-such-dir-' + Date.now(), 'report.json');
    const res = runRegistered('for (let i = 0; i < 1000; i++) {}', doomed);
    assert.equal(res.status, 0, 'report-write failure must never fail the target itself');
    assert.match(res.stderr, /failed to write report to/);
});

test('Register: unwritable report path on the hard-exit lane surfaces the partial-write failure', () => {
    const doomed = join(tmpdir(), 'lite-gc-no-such-dir-' + Date.now(), 'report.json');
    const res = runRegistered('process.exit(0)', doomed);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /failed to write partial report on exit/);
});

test('Register: process.exit with no report path stays silent and does not fail the target', () => {
    // The exit-lane guard: with no LITE_GC_GATE_REPORT_PATH there is nowhere to
    // write, so the handler must return before touching the filesystem. Cheap
    // to get wrong -- an unguarded writeFileSync(undefined, ...) would throw
    // inside a process.exit handler, turning a clean exit into a crash in
    // anyone who preloads the register hook during development, which the
    // module header explicitly invites.
    const res = spawnSync(process.execPath, [
        '--expose-gc',
        '--import', 'data:text/javascript,import ' + JSON.stringify('file://' + REGISTER),
        '-e', 'process.exit(0)'
    ], {
        encoding: 'utf8',
        cwd: PKG_ROOT,
        env: (() => { const e = Object.assign({}, process.env); delete e.LITE_GC_GATE_REPORT_PATH; return e; })()
    });
    assert.equal(res.status, 0, 'the target must exit cleanly');
    assert.equal(res.stderr, '', 'nothing to write is not an error and must not be reported as one');
});

// ---------------------------------------------------------------------------
// A report file that exists but is not JSON.
//
// The gate reads its verdict from a file the target process wrote. If that file
// is truncated, half-flushed, or clobbered by something else, JSON.parse throws.
// The pin is that this becomes an INFRASTRUCTURE error naming the parse failure
// -- not a crash, and emphatically not a clean pass. A gate that treats an
// unreadable report as "nothing to complain about" is the fail-open shape this
// whole suite exists to prevent.
// ---------------------------------------------------------------------------

test('CLI: a truncated report file is an infrastructure error, never a pass', () => {
    // The target exits 0 having written a half-flushed report -- the shape a
    // process killed mid-write leaves behind.
    const r = cli(['run', TRUNCATED]);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.notEqual(r.status, 0, 'an unreadable report must not exit 0');
    assert.match(out, /could not parse report/i,
        'the failure must name the parse rather than surfacing a raw stack; got: ' + out.slice(0, 200));
    assert.doesNotMatch(out, /\bPASS\b/, 'an unparseable report must never narrate a pass');
});
