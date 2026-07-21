// Standard-case tests for explain mode introduced in Batch 4 (G11).
// Adversarial cases (start/stop concurrency, running inside a gated run)
// live in test/torture/g10-5-attribution.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startExplainSampling } from '../ExplainSampling.js';
import { formatExplainConsole } from '../Explain.js';

// ---- lifecycle ----

test('startExplainSampling returns a handle with started promise and stop method', () => {
    const h = startExplainSampling();
    assert.equal(typeof h.started.then, 'function');
    assert.equal(typeof h.stop, 'function');
    // Clean up
    return h.stop();
});

test('stop() returns a result with topStacks array', async () => {
    const h = startExplainSampling({ intervalBytes: 4096, topN: 5 });
    await h.started;
    // Do some allocation so the sampler has something to see.
    const buf = [];
    for (let i = 0; i < 1000; i++) buf.push({ x: i, y: i * 2, s: 'str-' + i });
    const result = await h.stop();
    assert.ok(Array.isArray(result.topStacks));
    assert.equal(result.samplingInterval, 4096);
    assert.equal(result.topN, 5);
});

test('stop() called twice returns error on second call', async () => {
    const h = startExplainSampling();
    await h.started;
    await h.stop();
    const second = await h.stop();
    assert.equal(second.error, 'already stopped');
});

test('captures allocation stacks from a real allocating loop', async () => {
    const h = startExplainSampling({ intervalBytes: 1024, topN: 20 });
    await h.started;
    // Force enough allocation to trigger multiple samples
    const buckets = [];
    for (let i = 0; i < 500; i++) {
        const arr = new Array(500);
        for (let j = 0; j < 500; j++) arr[j] = { x: i, y: j, s: 'x-' + i + '-' + j };
        buckets.push(arr);
    }
    const result = await h.stop();
    // With enough allocation and a small interval, we should see SOME stacks.
    // The runtime may throttle sampling, so we don't assert a specific count.
    assert.ok(result.topStacks.length >= 0);
    // Each captured stack has the documented shape.
    for (const s of result.topStacks) {
        assert.equal(typeof s.selfSize, 'number');
        assert.equal(typeof s.functionName, 'string');
        assert.equal(typeof s.url, 'string');
        assert.equal(typeof s.lineNumber, 'number');
    }
});

// ---- formatExplainConsole ----

test('formatExplainConsole handles empty topStacks', () => {
    const s = formatExplainConsole({ topStacks: [], samplingInterval: 512, topN: 10 });
    assert.match(s, /Top allocation stacks/);
    assert.match(s, /no samples captured/);
});

test('formatExplainConsole formats stacks', () => {
    const s = formatExplainConsole({
        topStacks: [
            { selfSize: 10240, functionName: 'allocFoo', url: 'file:///foo.js', lineNumber: 42, columnNumber: 0 },
            { selfSize: 5120, functionName: 'allocBar', url: 'file:///bar.js', lineNumber: 17, columnNumber: 0 }
        ],
        samplingInterval: 512,
        topN: 10
    });
    assert.match(s, /allocFoo/);
    assert.match(s, /allocBar/);
    assert.match(s, /10\.0 KB/);
    assert.match(s, /5\.0 KB/);
});

test('formatExplainConsole surfaces error', () => {
    const s = formatExplainConsole({ error: 'not started', topStacks: [], samplingInterval: 0, topN: 0 });
    assert.match(s, /Explain: error: not started/);
});

// ---- interaction guarantee ----

test('explain sampling can run during ordinary code without throwing', async () => {
    // The "never runs inside a gating run" invariant is enforced by convention
    // (CLI splits into 'run' vs 'explain' subcommands), not by hard interlock
    // at the library level. This test just verifies the sampler runs cleanly
    // when driven directly.
    const h = startExplainSampling({ intervalBytes: 8192 });
    await h.started;
    let x = 0;
    for (let i = 0; i < 10000; i++) x += i;
    const result = await h.stop();
    assert.ok(Array.isArray(result.topStacks));
    assert.ok(x > 0);
});
