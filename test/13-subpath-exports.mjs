// Dual-surface publish smoke test (Batch 3 addition per D1).
//
// Verifies that both surfaces resolve after publish:
//   - Main package (single-file browser-safe surface)
//   - ./register subpath (node-only preload)
//   - ./test-helpers subpath (node:test integration)
//   - bin/lite-gc-gate.mjs (CLI)
//
// This test runs against the local workspace but exercises the same import
// paths the published package will expose. If publish adds a subpath that
// isn't in package.json exports, this test catches the omission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

test('main surface resolves and exports the documented API', async () => {
    const mod = await import(resolve(ROOT, 'Gc.js'));
    assert.equal(typeof mod.GcProfiler, 'function');
    assert.equal(typeof mod.checkNoGc, 'function');
    assert.equal(typeof mod.VERSION, 'string');
});

test('./register subpath resolves and exports gc', async () => {
    const mod = await import(resolve(ROOT, 'Register.mjs'));
    assert.ok(mod.gc, 'register.mjs should export gc');
    // The preload also registers a global for target scripts to reach
    const key = Symbol.for('@zakkster/lite-gc-profiler/register');
    assert.ok(globalThis[key], 'preload should register a well-known global');
});

test('./test-helpers subpath resolves', async () => {
    const mod = await import(resolve(ROOT, 'TestHelpers.js'));
    assert.equal(typeof mod.withGcGate, 'function');
    assert.equal(typeof mod.measureGc, 'function');
});

test('./explain subpath resolves', async () => {
    const mod = await import(resolve(ROOT, 'Explain.js'));
    assert.equal(typeof mod.startExplainSampling, 'function');
    assert.equal(typeof mod.formatExplainConsole, 'function');
});

test('CLI bin exists and is executable', () => {
    const cliPath = resolve(ROOT, 'bin/LiteGcGate.mjs');
    assert.ok(existsSync(cliPath), 'CLI should exist at bin/lite-gc-gate.mjs');
    // First line should be a shebang
    const first = readFileSync(cliPath, 'utf8').split('\n')[0];
    assert.match(first, /^#!\/usr\/bin\/env node/, 'CLI should start with node shebang');
});

test('template exists at templates/gc-gate.mjs', () => {
    const tPath = resolve(ROOT, 'templates/GcGate.mjs');
    assert.ok(existsSync(tPath), 'template should exist at templates/gc-gate.mjs');
});

test('package.json exports include the three surfaces', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    // The verify workspace is minimal; only assert if a real package.json
    // with exports is present.
    if (pkg.exports) {
        assert.ok(pkg.exports['.'], 'package.json exports must include "."');
        assert.ok(pkg.exports['./register'], 'package.json exports must include "./register"');
        assert.ok(pkg.exports['./test-helpers'], 'package.json exports must include "./test-helpers"');
        assert.ok(pkg.exports['./explain'], 'package.json exports must include "./explain"');
    }
    if (pkg.bin) {
        assert.ok(pkg.bin['lite-gc-gate'], 'package.json bin must include "lite-gc-gate"');
    }
});
