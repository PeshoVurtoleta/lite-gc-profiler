# @zakkster/lite-gc-profiler

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-gc-profiler.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-gc-profiler)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-gc-profiler?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-gc-profiler)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-gc-profiler?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-gc-profiler)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-gc-profiler?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-gc-profiler)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE.txt)
[![deps](https://img.shields.io/badge/dependencies-0-3fb950)](#install)
[![types](https://img.shields.io/badge/types-included-3178c6)](./index.d.ts)


Zero-dependency GC and heap profiler. It exists to make the **zero-GC claim
falsifiable** rather than asserted.

- **node** → precise: perf_hooks `gc` entries (kind + pause duration).
- **Chrome** → heuristic: `performance.memory` heap sampling (alloc rate, drops).
- **others** → long-frame anomaly detection only (no heap API).

The observer receives node-allocated entry lists between frames; the per-frame
methods (`sampleHeap`, `markFrame`) allocate nothing.

Single-file ESM, no dependencies, MIT.

## The claim, made falsifiable

The zero-GC claim in a package's README should mean something. This library
gives it a testable gate: run your workload, ask if any major GC fired, get
back one of `'pass'`, `'fail'`, or `'inconclusive'`. On runtimes where the
question cannot be honestly answered, the gate refuses to lie.

## Sources

Which signal is live is either detected from the runtime, or overridden
explicitly via `new GcProfiler(cap, { source: ... })`:

- `'gc'` -- node (or any V8 runtime exposing `perf_hooks gc` entries). Precise
  event kinds and pause durations. Default on node.
- `'heap'` -- Chrome. Heuristic based on `performance.memory` heap-drop
  detection. Default on Chrome. Fast enough for per-frame sampling.
- `'uasm'` -- Chrome, opt-in. Accurate memory measurement via
  `performance.measureUserAgentSpecificMemory()`. Requires cross-origin
  isolation (COOP+COEP). Async and coarse; not for per-frame use.
  Never auto-selected -- cross-origin isolation is a deployment choice.
- `'none'` -- Firefox, Safari. Frame-anomaly detection only.

### Opting into `uasm`

```
const gc = new GcProfiler(256, { source: 'uasm' });

// Take a few measurements across the workload:
await gc.sampleUasm();
runHotLoop();
await gc.sampleUasm();
runHotLoop();
await gc.sampleUasm();

// Now summary.uasm.growthRate is bytes/sec across that window,
// and the gate can verify it:
assertNoGc(gc.summary(), { maxAllocRate: 1 * 1024 * 1024 });
```

Throws `RangeError` on construction if the API is unavailable or the page is
not cross-origin-isolated. `summary.uasm` is always present, whether or not
you opted in -- shape:

```
{ supported, bytes, peak, firstSample, samples, growthRate }
```

`growthRate` is 0 with a single sample; needs two points for a delta.

## Subpaths

| import | node | browser | intended use |
| --- | :---: | :---: | --- |
| `@zakkster/lite-gc-profiler` | yes | yes | main API |
| `@zakkster/lite-gc-profiler/register` | yes | no | preload for auto-attach |
| `@zakkster/lite-gc-profiler/test-helpers` | yes | no | node:test integration |
| `@zakkster/lite-gc-profiler/explain` | yes | no | allocator attribution |

Node-only subpaths are additive; the main API stays single-file and
browser-safe.

## Install

```
npm install @zakkster/lite-gc-profiler
```

## Node: precise GC

```js
import { GcProfiler, assertNoGc } from '@zakkster/lite-gc-profiler';

const gc = new GcProfiler().start();

runHotLoopForAWhile();

// GC entries are delivered asynchronously, so settle before reading.
await gc.settle();

// Strict by default: throws GcBudgetError on fail, GcInconclusiveError if
// the current source cannot verify a rule you set.
assertNoGc(gc.summary());
gc.stop();
```

## Phases: warmup vs steady state

`gc.phase(name)` marks a phase boundary. Everything from the call until the
next `phase()` call is attributed to that phase. Phases are linear -- no
nesting, no explicit exit. The default state before any `phase()` call is
unattributed (events count toward global stats but no phase).

```js
const gc = new GcProfiler().start();

gc.phase('warmup');
runWarmupPasses();                    // some collections are fine here

gc.phase('steady');
runMeasuredWorkload();                // this window must be clean

await gc.settle();

assertNoGc(gc.summary(), {
  phases: {
    warmup: { maxMajor: 1 },
    steady: { maxMajor: 0, maxMinor: 0 }
  }
});
gc.stop();
```

Phases make `maxMinor: 0` a usable claim: ambient allocation during warmup
no longer contaminates the steady-state verdict.

**Attribution uses each GC event's `startTime`, not the wall clock at record
time.** `PerformanceObserver` delivers entries asynchronously; the gate
buckets by when the event occurred.

Capacities: 32 unique phases, 1024 boundaries per window. Silent overflow
of a gating primitive would defeat the purpose, so both throw.

**Scope in v1.1.0:** phases attribute GC events only. `sampleHeap` and
`markFrame` remain global; per-phase `maxAllocRate` is inconclusive.

## Regions: attributing pauses to code paths

Phases are linear -- warmup, then steady. Regions nest -- you can be inside
`render` inside `frame` inside `session`. GC events attribute to the innermost
open region whose interval contains the event's `startTime`.

```js
const gc = new GcProfiler().start();
gc.enter('frame');
    gc.enter('input');
    processInput();
    gc.exit();
    gc.enter('render');
    render();
    gc.exit();
gc.exit();
await gc.settle();

assertNoGc(gc.summary(), {
  perRegion: {
    input:  { maxMajor: 0, maxPauseMs: 1 },
    render: { maxMajor: 0, maxPauseMs: 4 }
  }
});
gc.stop();
```

Rules follow the same three-state verdict semantics. A region referenced in
`perRegion` but never entered contributes `inconclusive`. A region-scoped
`maxAllocRate` is inconclusive in this release -- heap sampling is global,
per-region heap tracking is a future gate.

Capacities: 32 unique region names, 16 nesting depth, 2048 total intervals.
Throw on overflow.

### Firing-site vs allocator: what regions actually answer

Regions attribute events to **where the pause fired**, not to **who
allocated the garbage**. V8 collects when allocation debt crosses a
threshold; the debtor may be an earlier region.

Concrete case: `region A` allocates 30 MB, exits cleanly. `region B` opens,
does modest work, and V8's Mark-Sweep-Compact fires during B because the
threshold from A's allocations was finally crossed. The gate charges B.

That's not blame-shifting; it's a truthful answer to a different question.
"Which region incurs pauses" is what users perceive as slowness. "Which
region allocated the pressure" is the fix -- and that's what Explain mode
answers separately.

## Settling: deterministic measurement boundaries

`PerformanceObserver` delivers GC entries asynchronously, in batches, on the
runtime's schedule. Reading `summary()` immediately after work completes can
miss entries that fired but were not yet delivered. The v1.0.0 README worked
around this with `await new Promise((r) => setTimeout(r, 50))` -- an arbitrary
50 ms guess.

v1.1.0 replaces the guess with `gc.settle()`:

```js
const gc = new GcProfiler().start();
runWorkload();

const { drained, waited } = await gc.settle();
if (!drained) {
  // Downgrade any verdict to inconclusive -- the observer queue never quieted,
  // so summary() may be missing entries.
}
assertNoGc(gc.summary());
gc.stop();
```

Semantics: `settle()` polls a batch counter each macrotask; after N consecutive
quiet ticks it declares drained. On timeout it resolves with `drained: false`.

Options:
- `quietTicks` (default 2) -- consecutive quiet ticks required.
- `maxWaitMs` (default 200) -- hard timeout.

`settle()` is a no-op on `source: 'heap'` and `source: 'none'`, and on a
profiler that was never `.start()`ed. It resolves immediately with
`{ drained: true, waited: 0 }`.

The observer callback gained one integer increment (a batch counter) and
nothing else; hot-path allocation is unchanged from v1.0.0.

## Browser: heap + frames

```js
import { GcProfiler, assertNoGc } from '@zakkster/lite-gc-profiler';

const gc = new GcProfiler().start();

function frame(t) {
  gc.sampleHeap(t);          // performance.memory in Chrome; no-op elsewhere
  gc.markFrame(dt);          // frame duration for anomaly detection
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Later, gate on allocation rate:
assertNoGc(gc.summary(), { maxAllocRate: 2 * 1024 * 1024 });
```

## Gate

The gate returns a three-state verdict: `pass`, `fail`, or `inconclusive`.
An `inconclusive` verdict means the current source cannot verify one or more
of the rules you set -- it is not the same as `pass`, and by default it throws.
Falsifiability requires that a gate never be silently green when it could not
actually check what it was asked to check.

```js
import { checkNoGc, assertNoGc } from '@zakkster/lite-gc-profiler';

const report = checkNoGc(gc.summary(), {
  maxMajor: 0,                     // no full-heap collections (default)
  maxPauseMs: 4,                   // no single pause over 4 ms
  maxAllocRate: 2 * 1024 * 1024    // <= 2 MB/s allocation (heap path)
});
// report -> {
//   kind: 'gc',
//   verdict: 'pass' | 'fail' | 'inconclusive',
//   ok: boolean,                     // === verdict === 'pass'
//   violations: [...],
//   checked: { maxMajor: true, maxPauseMs: true, maxAllocRate: false },
//   checkedByPhase: {},
//   checkedByRegion: {},
//   source: 'gc' | 'heap' | 'none'
// }

assertNoGc(gc.summary());                                       // strict
assertNoGc(gc.summary(), rules, { allowInconclusive: true });   // permissive
```

Rules: `maxMajor` (default 0), `maxMinor`, `maxPauseMs`, `maxTotalMs`, `maxAllocRate`.

### Verifiability matrix

Which rules each source can actually verify:

| rule            | `gc` (node) | `heap` (Chrome) | `uasm` (Chrome, opt-in) | `none` (Firefox/Safari) |
| --------------- | :---------: | :-------------: | :---------------------: | :---------------------: |
| `maxMajor`      |     yes     |       no        |           no            |           no            |
| `maxMinor`      |     yes     |       no        |           no            |           no            |
| `maxPauseMs`    |     yes     |       no        |           no            |           no            |
| `maxTotalMs`    |     yes     |       no        |           no            |           no            |
| `maxAllocRate`  | needs heap  |   needs heap    |       needs uasm        |           no            |

"needs heap" means the rule is verifiable iff `summary.heap.samples >= 2`.
"needs uasm" means the rule is verifiable iff `summary.uasm.samples >= 2`
(computing a growth rate requires at least two measurements). Feed samples
with `gc.sampleHeap(now, process.memoryUsage().heapUsed)` in node, let the
browser path sample `performance.memory` automatically for `heap`, or call
`await gc.sampleUasm()` a few times per window for `uasm`.

The matrix is exported as `VERDICT_MATRIX` for tools that want to render it
or filter rules to the current source.

### Errors

- `GcBudgetError`         -- thrown from `assertNoGc` on `verdict: 'fail'`.
- `GcInconclusiveError`   -- thrown from `assertNoGc` on `verdict: 'inconclusive'`
  unless `{ allowInconclusive: true }`. Message names the unverifiable rules.

Both carry `.report` with the full report.

### Per-phase rules

Rules accept an optional `phases` map alongside global rules. Each phase's
rules are evaluated against `summary.phases[name].gc`:

```js
checkNoGc(gc.summary(), {
  maxMajor: 0,                                     // global rule
  phases: {
    warmup: { maxMajor: 1 },                       // relaxed for warmup
    steady: { maxMajor: 0, maxMinor: 0 }           // strict for steady
  }
});
```

A phase referenced in rules but never declared via `profiler.phase(name)` is
inconclusive. A phase declared but with no events verifies as pass.

The report grows a `checkedByPhase` map alongside `checked`.

## Differential: comparing against a control

Absolute gating fails when the harness itself allocates: any GC caused by
the harness gets charged to the candidate, and a real regression drowns in
the noise. `compareGc(control, candidate, rules)` gates on the delta
(candidate - control), not absolute numbers.

```js
import { compareGc, assertCompare } from '@zakkster/lite-gc-profiler';

async function measure(fn) {
  const gc = new GcProfiler().start();
  fn();
  await gc.settle();
  const s = gc.summary();
  gc.stop();
  return s;
}

const control = await measure(pooledNoop);       // harness noise baseline
const candidate = await measure(myCode);         // candidate under test

assertCompare(control, candidate, {
  maxExtraMajor: 0,             // no additional majors
  maxExtraPauseMs: 1,           // no additional pause > 1ms
  maxExtraAllocRate: 1024 * 1024   // at most 1 MB/s extra
});
```

Rules: `maxExtraMajor` (default 0), `maxExtraMinor`, `maxExtraPauseMs`,
`maxExtraTotalMs`, `maxExtraAllocRate`.

**Source mismatch is inconclusive.** If control and candidate come from
different sources (e.g. one node, one browser), the differential is
meaningless and the verdict is `inconclusive` with `reason:
'source_mismatch'`.

**Interleaving contract:** control and candidate should come from interleaved
reps to absorb machine-mood variance. Combine with `gateReps` (below) to
enforce it.

## Rep-aware gating: variance and policy

A single run says too little. Many runs say more, but only if you gate on
them coherently. `aggregateGc(summaries)` collects reps into a stats block
per metric; `gateReps(summaries, rules, options?)` applies rules under
per-rule policies.

```js
import { aggregateGc, gateReps, assertReps } from '@zakkster/lite-gc-profiler';

const reps = [];
for (let i = 0; i < 10; i++) {
  const gc = new GcProfiler().start();
  runMyCode();
  await gc.settle();
  reps.push(gc.summary());
  gc.stop();
}

assertReps(reps, {
  maxMajor: 0,          // strict: no rep may have a major
  maxPauseMs: 4         // strict: best rep proves 4ms is achievable
});
```

Policies:

- `'all-clean'` -- every rep must satisfy (aggregate uses max).
  For kind rules (majors, minors), a single dirty rep falsifies the claim.
- `'best-clean'` -- at least one rep must satisfy (aggregate uses min).
  For pauses and rates, the best rep proves the clean state is achievable;
  the rest is machine noise.
- `'median'` -- median across reps must satisfy.
- `'quorum-N'` -- at least N reps must individually satisfy.

Defaults:

| rule           | default policy   |
| -------------- | ---------------- |
| `maxMajor`     | `all-clean`      |
| `maxMinor`     | `all-clean`      |
| `maxPauseMs`   | `best-clean`     |
| `maxTotalMs`   | `best-clean`     |
| `maxAllocRate` | `best-clean`     |

Override per rule via `options.policy`:

```js
assertReps(reps, { maxMajor: 0, maxPauseMs: 4 }, {
  policy: {
    maxMajor: 'quorum-9',
    maxPauseMs: 'median'
  }
});
```

**Mixed sources across reps -> inconclusive** with `reason: 'mixed_sources'`.

## Baseline lock: guarding against silent regressions

CI ergonomics: capture a known-good aggregate once, commit it as JSON, gate
every future run against it.

```js
import { aggregateGc, createBaseline, checkAgainstBaseline } from '@zakkster/lite-gc-profiler';
import { readFileSync, writeFileSync } from 'node:fs';

// Once, on a green build:
const baseline = createBaseline(aggregateGc(reps));
writeFileSync('gc-baseline.json', JSON.stringify(baseline, null, 2));

// Every subsequent build:
const baseline = JSON.parse(readFileSync('gc-baseline.json', 'utf8'));
const current = aggregateGc(reps);
const report = checkAgainstBaseline(current, baseline);
if (report.verdict === 'fail') { /* regression */ }
if (report.verdict === 'inconclusive') { /* baseline unusable here */ }
```

`createBaseline` does not touch the filesystem; it returns a JSON-able
object. Users serialize and commit as they see fit.

**Regression semantics:** for each metric, `current.median > baseline.max`
is a regression. Rationale: allowing current to be as bad as the baseline's
worst absorbs run-to-run noise on the capture side; a current whose typical
value exceeds even the worst observed baseline is a real regression.

**Fingerprint check.** `createBaseline` captures a fingerprint of the
environment (node, v8, platform, arch, cpu). Comparing against a baseline
whose fingerprint differs from the current environment returns
`inconclusive` with `reason: 'fingerprint_mismatch'`.

Override the fingerprint check explicitly if needed:

```js
checkAgainstBaseline(current, baseline, { acceptFingerprintMismatch: true });
// The report body carries fingerprintMismatchAccepted: true as audit trail.
```

## CLI: lite-gc-gate

Zero-touch gating for any node script:

```
lite-gc-gate run <script> [options]
```

| flag | meaning |
| --- | --- |
| `--reps N` | Run N times and gate on the aggregate |
| `--config path` | Load rules and policy from JSON |
| `--format fmt` | `console` \| `json` \| `markdown` \| `github` (default console) |
| `--json path` | Also write the JSON envelope to this path |
| `--baseline path` | Check against a baseline JSON file |
| `--update-baseline` | Write current aggregate as new baseline |
| `--accept-fingerprint-mismatch` | Allow baseline comparison across fingerprints |
| `--allow-inconclusive` | Exit 2 instead of 1 on inconclusive |

Exit codes: `0` pass, `1` fail, `2` inconclusive, `3` infrastructure error.

The target script does not need to know about the profiler. The CLI spawns
node with the `./register` preload, which starts a `GcProfiler` at load,
settles on `beforeExit`, and writes the summary JSON to a temp path the CLI
then reads.

**Config file shape:**

```json
{
    "rules": { "maxMajor": 0, "maxPauseMs": 4 },
    "policy": { "maxMajor": "quorum-9" }
}
```

**Example: gate under 10 reps with GitHub Actions output:**

```
lite-gc-gate run bench/hot.mjs --reps 10 --config gc-gate.json --format github
```

**Example: capture a baseline once, gate against it thereafter:**

```
# Green build, once:
lite-gc-gate run bench/hot.mjs --reps 20 --baseline gc-baseline.json --update-baseline

# Every subsequent build:
lite-gc-gate run bench/hot.mjs --reps 20 --baseline gc-baseline.json --format github
```

**Limitation.** If the target script calls `process.exit()` explicitly, the
preload's `beforeExit` hook is skipped and no report is written. The CLI
reports "target did not write report" and exits 3. Refactor targets to
return from top-level rather than exiting eagerly.

## Test integration: node:test

The `./test-helpers` subpath exports `withGcGate`, a wrapper that turns the
start/settle/assert dance into a one-liner. On failure, the formatted
report is attached to the test's diagnostic output so CI logs show what the
gate saw next to the test name.

```js
import { test } from 'node:test';
import { withGcGate } from '@zakkster/lite-gc-profiler/test-helpers';

test('zero-alloc claim', async (t) => {
    await withGcGate(t, { maxMajor: 0 }, async (gc) => {
        runMyCode();
    });
});
```

With phases:

```js
test('warmup then steady', async (t) => {
    await withGcGate(t, {
        phases: {
            warmup: { maxMajor: 1 },
            steady: { maxMajor: 0, maxMinor: 0 }
        }
    }, async (gc) => {
        gc.phase('warmup');
        warmTheCache();
        gc.phase('steady');
        runMyCode();
    });
});
```

`measureGc` is the quieter form: returns the report instead of asserting.
Useful when the test wants to inspect the verdict rather than fail.

A canonical `test/99-gc-gate.mjs` template ships under `templates/GcGate.mjs`.
Every `@zakkster/lite-*` package that wants the Zero-GC badge copies this
verbatim, adjusting only the workload body and package import.

## Formatters

Four pure functions render any report into a target format. All accept the
report shape returned by `checkNoGc`, `compareGc`, `gateReps`, or
`checkAgainstBaseline`; dispatch is on the `kind` field.

- `formatConsole(report)` -- human-readable, aligned columns, ASCII-only.
  Suitable for stderr and CI job logs.
- `formatJson(report)` -- stable versioned envelope with schema tag and
  generation timestamp. Round-trippable.
- `formatMarkdown(report)` -- GitHub-flavored markdown, PR-comment ready.
- `formatGithubAnnotations(report)` -- GitHub Actions workflow annotations
  (`::error::` / `::warning::` / `::notice::`).

The CLI's `--format` flag picks one of these; nothing in the library forces
you to use the CLI though -- import the formatters directly in any tool.

## Explain mode: allocator attribution

When a gate fails, regions tell you where the pause fired. Explain mode
tells you which allocation stacks caused the pressure. It uses V8's
sampling heap profiler via `node:inspector`.

**STRICT OPT-IN.** Never active during a gated run. The sampler perturbs
the very thing measurement is trying to capture; running it inside a gate
would corrupt every zero-major claim in the same window.

```js
import { startExplainSampling, formatExplainConsole } from '@zakkster/lite-gc-profiler/explain';

const handle = startExplainSampling({ intervalBytes: 512 * 1024, topN: 10 });
await handle.started;

runTheCodeYouWantToExplain();

const result = await handle.stop();
process.stdout.write(formatExplainConsole(result) + '\n');
```

Output shape:

```
Top allocation stacks (interval=524288 bytes):
  allocateBucket         256.0 KB   file:///project/src/pool.js:42
  parseChunk             128.0 KB   file:///project/src/parse.js:17
  copyOnWrite             64.0 KB   file:///project/src/cow.js:81
  ...
```

The smaller `intervalBytes`, the more detail -- and the more perturbation.
Default is 512 KB.

Node-only. Browsers do not expose the inspector protocol.

## A note on cost: self-noise, measured

The observer receives node-allocated entry lists between GC events, and the
profiler's presence in a process is not zero-cost. We measured what it costs.

Setup: profiler started, primed for JIT warmup, `global.gc()` forced,
`settle()` awaited, `reset()` called. Then a 500 ms zero-allocation noop loop.
Measured on node.js under `--expose-gc`. Reproducible via
`node --expose-gc --test test/07-self-noise.mjs`.

Observed self-noise (range across dev hardware, five-run measurements):

| metric        | measured        | asserted ceiling   |
| ------------- | --------------- | ------------------ |
| major GCs     | 0               | 0 (hard)           |
| minor GCs     | 1-13            | 30                 |
| longest pause | 0.3-0.7 ms      | 5 ms               |
| total pause   | 0.4-1.5 ms      | (not asserted)     |
| p99 pause     | 0.3-0.7 ms      | (not asserted)     |
| heap growth   | 144 B - 770 KB  | 4 MB (sentinel)    |
| settle wait   | 2.5-4 ms        | (not asserted)     |

Zero majors is the strict invariant: a single self-induced major would poison
every user "zero-major" claim. The minor and pause ceilings are regression
sentinels -- generous enough to absorb the wide per-hardware variance in
scavenge frequency (a fast dev box may see 1-2 minors per 500 ms noop; a
slower CPU or busy system may see 10-15).

Heap growth is a regression sentinel only. It's noisy: most of the 144 B - 770 KB
range is V8 runtime state (JIT code cache, timer queue, ambient promise/
microtask allocation), not the profiler. The range is honest -- run-to-run
variance on real machines, published as measured rather than smoothed. A
tight per-profiler heap contribution number requires a differential against
a control run without the profiler; that measurement is available via
`compareGc`.

## Backwards compatibility with v1.0.0

Existing v1.0.0 code keeps working: `report.ok` still exists (as an alias
for `verdict === 'pass'`), `report.violations` is unchanged, and
`assertNoGc(summary)` still throws only `GcBudgetError` in the cases where
v1.0.0 threw it.

New in v1.1.0: `assertNoGc` may also throw `GcInconclusiveError`. If your
v1.0.0 code ran only on node with the default `{ maxMajor: 0 }` rule, this
cannot happen -- `source: 'gc'` verifies `maxMajor`. If your code ran a
browser gate with `maxMajor: 0`, that path was silently green in v1.0.0 and
now correctly fails; pass `{ allowInconclusive: true }` to restore the old
behavior, or scope rules to the source via `VERDICT_MATRIX`.

### File layout notes

The main source file was renamed from `index.js` to `Gc.js` in v1.1.0 to
match the ecosystem PascalCase convention. A back-compat shim is shipped
as `index.js` (and `index.d.ts`) that re-exports everything from `Gc.js`,
so any code that hard-coded `./index.js` in a relative path -- including
tests in the pre-v1.1.0 repo -- keeps working without modification.

Other renames (all relative paths inside the package, none affecting
`package.json` subpath names): `register.mjs` -> `Register.mjs`,
`test-helpers.js` -> `TestHelpers.js`, `explain.js` -> `Explain.js`,
`bin/lite-gc-gate.mjs` -> `bin/LiteGcGate.mjs`,
`templates/gc-gate.mjs` -> `templates/GcGate.mjs`.

**Do not move `templates/GcGate.mjs` into `test/`.** It's a template with
a `<PACKAGE_NAME>` placeholder that only compiles after being copied and
customized. If it gets picked up by the test runner from `test/`, it will
fail to import.

Test file naming: new tests in v1.1.0 follow the `NN-name.test.mjs`
convention so `node --test` discovers them automatically alongside the
v1.0.0 test files. Torture tests live at `test/torture/*.test.mjs` and
share `test/torture/harness.mjs` (a helper file, not a test).

## Testing

```
node --expose-gc --test test/*.mjs test/torture/*.mjs
```

240 tests, all passing on this hardware. Torture tests (48 scenarios across
four axes) enforce that adversarial inputs never silently pass, that real
signal in noise always fails, that clean signal under hostile conditions
always passes, and that self-consistency invariants hold across the API.

## License

MIT. Copyright (c) Zahary Shinikchiev.
