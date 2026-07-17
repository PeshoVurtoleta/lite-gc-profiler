# Changelog

## 1.3.0

Test-stability patch, no runtime code changes. The v1.3.0 test suite had
fail-path scenarios that leaned on `new Uint8Array(N)` for heap growth
signal. That was fragile: `Uint8Array`'s N-byte backing buffer lands in
external ArrayBuffer memory, invisible to `process.memoryUsage().heapUsed`
-- only the ~80-byte wrapper counts. Exact wrapper size varies across V8
versions, and on Node 26 with Apple Silicon (M-series) V8 packs it tightly
enough that some tests fell below their fail thresholds and produced false
negatives.

Reported by Zahary on M4 Pro / Node 26 -- one test in
`test/17-measure-ops.test.mjs`:
`assertCompareOps: convenience form throws GcBudgetError on delta failure`.

### Fix

All fail-path tests in `test/17-measure-ops.test.mjs` and
`test/torture/g14-5-ops.test.mjs` now use plain object literals for their
allocation signal:

    { a: i, b: i * 2, c: i * 3, d: 'literal', e: i + 1, f: i - 1 }

Plain objects land fully in JS heap and show as ~100 bytes/op
deterministically across V8 versions. Thresholds recalibrated with 5-10x
safety margin above V8's residual noise floor.

The mirror pin test in G14.5 axis-B (heavy warmup + clean steady) got a
small semantic tightening: it now uses a best-of-5 pattern and asserts
`bytesPerOp < 100`, acknowledging that V8's incremental marker keeps
working through the warmup-allocated ~400KB during steady, adding ~20-100
bytes/op of pure V8 bookkeeping. The pin's real invariant -- that the
phase quarantine reduces warmup's ~2000-bytes/warmup-op contribution by
20x when it bleeds into steady -- is stated explicitly in the comment.

### No runtime changes

Every export, function, signature, and behavior is byte-identical to
v1.3.1. Only test files and a version string.

### Testing

    npm test

317 tests, 317 pass. 5-run stability check clean on the reference
sandbox. Should pass reliably on Node 22+ across major V8 builds.

## 1.3.1

Hardening patch. Closes one of two sharp edges the Fable-brainstormed
forward roadmap flagged for pre-Wave-1 (H2 stays as v1.3.1 material for
when uasm gating is first exercised on real Chrome hardware).

### H1 (adjusted) -- `measureOps` self-noise cancellation

`process.memoryUsage()` on node allocates a small object (~240 bytes)
per call. In v1.3.0 that allocation was folded into the steady-phase
delta at the end boundary, inflating `bytesPerOp` by ~240 / ops. Small
enough to be invisible on real workloads, large enough to fail a strict
`maxBytesPerOp: 0` gate on a legitimately clean workload at low ops
counts.

Fix: **paired-call cancellation**. At each phase boundary, take a
second `process.memoryUsage()` call immediately after the first. The
delta between the two approximates one call's own allocation cost --
consecutive calls hit the same code path with the same hidden class,
so their allocation costs match within a byte or two on stable V8.
Subtract to get the pre-sampling heap value. Clamped to a plausible
range (0..8192 bytes) so a mid-loop scavenge between the paired calls
falls back to the raw value gracefully rather than over-correcting.

Chrome/browser unaffected -- `performance.memory.usedJSHeapSize` is a
property read on a singleton, zero allocation, no cancellation needed.

### Noise-floor documentation

The paired-call fix eliminates the sampling infrastructure's own
allocation contribution, but V8 has its own residual noise from
loop-bookkeeping (feedback vectors, tier-up allocations, incremental
marking) -- roughly 500-1200 bytes per loop regardless of ops. That's
orthogonal to the sampling fix and can't be removed in userland.

Added noise-floor guidance to the `measureOps` JSDoc and the README
per-op section. Rule of thumb: strict `maxBytesPerOp: 0` gating wants
`ops >= 10_000` where V8's residual dilutes below 0.15 bytes/op.

### G14.5 axis-C scenario added

`test/torture/g14-5-ops.test.mjs` now includes an axis-C scenario that
pins both claims: (a) paired-call cancellation is active (regression
protection if the fix ever gets removed), (b) V8's residual noise
stays under 1 byte/op at 10K ops on the reference runtime. Multi-
attempt best-of, since V8 occasionally does incremental marking mid-
loop and spikes the delta for that specific run.

### Testing

    npm test

317 tests, 317 pass. Adds one G14.5 axis-C scenario; previous 316
unchanged.

### Non-fix note (deferred to future patch)

The forward-roadmap H1 also proposed a bounded-time reporting path
(replace O(N log N) sort with an is-sorted fast pass for the common
near-ordered case). Deferred: not exercised in v1.3.0's typical usage
patterns, and the sort cost at default `capacity: 256` is
sub-millisecond. Revisit if a Wave adopter hits the large-capacity
report-time cliff.

Batch 6 -- per-op primitives (`measureOps`, `assertOps`, `compareOps`) plus
the `process.exit` partial-report path in the CLI. This is the release that
turns the profiler from "gate a whole test run" into "gate a signal
notification, a keyed-selector call, a hot-loop tick" -- the shape reactive
framework benches have been hand-rolling for years.

Non-breaking. Additive throughout. Existing v1.2.0 code and baselines keep
working unchanged.

### G14 -- `measureOps(fn, opts)`

Sync-only in v1.3.0 (D7). Async per-op semantics are ambiguous because
microtasks interleave allocations across iterations; if real demand appears,
async support is a separate design in v1.4+.

    import { measureOps } from '@zakkster/lite-gc-profiler';

    const result = measureOps((i) => notify(i), { ops: 10_000, warmup: 500 });
    // -> { schema: 'lite-gc-ops/1', ops, warmupOps, elapsedMs, opsPerSec,
    //      bytesPerOp, source, summary }

Internals use the existing `phase()` machinery (G2) with two named phases,
`warmup` and `steady`. Warmup allocations are visible in `summary.phases.warmup`
but explicitly quarantined from steady-phase gating; `bytesPerOp` is derived
from the steady heap delta alone. On node the internal profiler samples via
`process.memoryUsage().heapUsed` at phase boundaries; on Chrome it reads
`performance.memory` through `sampleHeap()`. When source is `'none'`
(Firefox/Safari, or explicit opt-out), sampling is skipped and `bytesPerOp`
is `null`.

`fn(i)` signature (D8) matches alien-signals bench, js-reactivity-benchmark,
and the internal `@zakkster/lite-*` bench harnesses.

### G15 -- `assertOps(fn, rules, opts)` + `checkOps(result, rules)`

Four rule names, verifiability documented in `VERDICT_MATRIX`:

    maxBytesPerOp     -- needs a memory channel; verifiable when heap or uasm has samples
    maxMajorsPerKOp   -- source='gc' only (Node V8 event kinds)
    maxMinorsPerKOp   -- source='gc' only
    maxPauseMsPerOp   -- source='gc' only

`assertOps` throws `GcBudgetError` on fail, `GcInconclusiveError` on
inconclusive (unless `opts.allowInconclusive`). Rule scope is per-op only
(D10) -- throughput (`opsPerSec`) is reported but never gated, keeping
this package in the "prove zero-GC per op" lane. Benchmark harnesses
have opinions on throughput; the gate stays neutral.

### G16 -- `compareOps(control, candidate, rules)`

Primitive form (D9): two `measureOps` results, one report. Same shape as
`compareGc` -- source mismatch yields inconclusive with
`reason: 'source_mismatch'`. Convenience form
`compareOps(controlFn, candidateFn, rules, opts)` calls `measureOps` twice
internally with matched opts, then compares. `assertCompareOps` throws in
the same way as `assertOps`.

Delta rule names mirror `maxExtra*` on `compareGc`:

    maxExtraBytesPerOp
    maxExtraMajorsPerKOp
    maxExtraMinorsPerKOp
    maxExtraPauseMsPerOp

### G16.5 -- CLI partial-report path

Register preload now installs a `process.on('exit')` sync handler alongside
the existing `beforeExit` async one. If the target calls `process.exit()`,
the exit handler writes a partial report:

    { schema: 'lite-gc-partial/1', complete: false, reason: 'process_exit',
      exitCode, partialSummary, capturedAt }

CLI reads that schema, downgrades verdict to `inconclusive` with
`reason: 'partial_report'`, and emits exit code 2 (inconclusive) instead of
exit code 3 (infrastructure error). Before v1.3.0, a hard `process.exit()`
from an integrated script was indistinguishable from a broken harness at CI.

### G14.5 torture

10 scenarios in `test/torture/g14-5-ops.test.mjs`. Axis A (3): `source='none'`
+ `maxBytesPerOp` inconclusive; `source='heap'` kind-per-op-rules inconclusive;
compareOps source mismatch inconclusive. Axis B (3): 10x bytes/op candidate
fails compareOps; leaky steady is not shielded by clean warmup; **complementary
pin** -- heavy warmup + clean steady MUST pass strict steady rule (proves
`phase()` boundary really quarantines warmup). Axis C (2): identical noop
workloads compare with delta 0; measureOps itself induces no majors on a noop
workload (per-op harness perturbation bound). Axis D (2): result shape stable
across sources with `bytesPerOp` null when un-derivable; compareOps verdict
matches per-metric manual computation.

Plus 3 CLI integration scenarios in `test/18-partial-report.test.mjs`:
`process.exit(0)` yields exit 2 + partial reason; `process.exit(1)` also
yields exit 2 (not exit 3); clean run without any `process.exit` writes a
complete report with no partial marker (additive-changes-stay-additive pin
for the register preload).

### Testing

    npm test

316 tests, 316 pass. Adds 29 standard-case per-op tests, 10 G14.5 torture
scenarios, 3 G16.5 CLI integration scenarios; previous 274 unchanged.

### File additions

* `test/17-measure-ops.test.mjs`
* `test/torture/g14-5-ops.test.mjs`
* `test/18-partial-report.test.mjs`

## 1.2.0

Batch 5 -- the browser second source. Chrome now has a precise-when-you-can-
afford-it alternative to the fast-but-heuristic `performance.memory` channel,
and the verdict matrix grows a `uasm` column so gates on that channel stay
honest about what they can and can't verify.

Non-breaking. Additive throughout: new profiler option, new async method,
new summary block, new source column. Everything else is unchanged.

### G12 -- `uasm` source

New source `'uasm'` backed by `performance.measureUserAgentSpecificMemory()`.
Opt-in via constructor -- never silently auto-selected, because cross-origin
isolation (COOP+COEP) is a deployment choice the library can't make for you.

    const gc = new GcProfiler(256, { source: 'uasm' });
    // ...
    await gc.sampleUasm();       // take a measurement; typically a few per window

The API:

* **`sampleUasm(now?)`** returns a Promise resolving to `{ supported, bytes? }`.
  Coarse and slow -- never call per-frame. On runtimes without the API or
  without cross-origin isolation, resolves to `{ supported: false }` and records
  nothing.
* **`summary.uasm`** is always present, shape:

      { supported, bytes, peak, firstSample, samples, growthRate }

  `supported: false` and zeros when the API is unavailable or unused.
  `growthRate` is bytes/sec across the sampled window; 0 with a single sample.
* **`VERDICT_MATRIX.maxAllocRate.uasm === 'needsUasm'`** -- verifiable iff
  `summary.uasm.samples >= 2`. Kind/pause rules are `no` on uasm (no event kinds
  exposed), matching `heap`. A `maxMajor:0` rule on a uasm-only summary is
  correctly inconclusive, not falsely green.
* **`compareGc` and `gateReps` follow the source.** A `source: 'uasm'`
  candidate/aggregate reads `uasm.growthRate` for alloc-rate rules;
  `heap`/`gc` sources still read `heap.allocRateBytesPerSec`. Cross-source
  comparisons (e.g. uasm vs heap) remain inconclusive with
  `reason: 'source_mismatch'`.
* **`aggregateGc` and `createBaseline`** now include a `uasm` block alongside
  `gc` and `heap`. Baseline files for uasm-gated packages round-trip cleanly
  through JSON.

Constructor validation:

    new GcProfiler(256, { source: 'uasm' });     // throws if API missing / not COOP+COEP
    new GcProfiler(256, { source: 'bogus' });    // throws RangeError

### G13.5 torture

11 scenarios in `test/torture/g13-5-browser.test.mjs` -- axis-A
inconclusive traps (kind rule on uasm, <2 samples, no memory channel),
axis-B fail traps (uasm growth over limit, D4 policy pin on uasm,
compareGc delta on uasm channel), axis-C pass traps (clean uasm, heap
regression protection, uasm rep-gate best-clean), axis-D invariants
(matrix columns exhaustive, baseline round-trip preserves uasm).

Real browser calibration (heuristic false-positive/false-negative rates
for the existing heap-drop detector) is intentionally NOT automated in
CI -- it belongs in `demo/calibration.html` where the numbers can be
measured on real hardware.

### G13 (SPP probe + HUD scene) -- **NOT in this release**

The SPP probe adapter for the `@zakkster/lite-scope` streams lives in a
sibling package, `@zakkster/lite-scope-gc-probe`, per the D5 decision.
It's not part of lite-gc-profiler's surface.

### Testing

    npm test

274 tests, 274 pass. Adds 23 standard-case uasm tests
(`test/16-uasm.test.mjs`) and 11 G13.5 torture scenarios; previous 240
tests unchanged.

### File additions

* `test/16-uasm.test.mjs`
* `test/torture/g13-5-browser.test.mjs`

## 1.1.0

The big one. This release turns the profiler from "a way to observe GC" into
"a way to make zero-GC claims falsifiable, verifiably, in CI." Structured as
four coherent expansions:

  1. **Verdict integrity** -- the gate no longer lies when it can't answer.
  2. **Differential and rep-aware gating** -- deltas, aggregates, baselines.
  3. **CI harness** -- formatters, CLI, node:test helper.
  4. **Attribution** -- regions and explain mode.

No breaking changes to v1.0.0 code: `report.ok` and `report.violations` are
preserved; `assertNoGc(summary, rules)` still throws only `GcBudgetError` on
the paths where v1.0.0 threw it.

### File-naming convention

Package internals renamed to PascalCase (`Gc.js`, `Register.mjs`,
`TestHelpers.js`, `Explain.js`, `bin/LiteGcGate.mjs`,
`templates/GcGate.mjs`) to match the ecosystem convention. Public subpath
names in `package.json` exports are unchanged.

### Verdict integrity

- Three-state verdict on `checkNoGc`: `'pass' | 'fail' | 'inconclusive'`.
  `report.ok` retained as an alias for `verdict === 'pass'`.
- `checked: { [ruleName]: boolean }` on the report: for every rule the
  caller set, whether the current source could actually verify it.
- `GcInconclusiveError`, thrown by `assertNoGc` on `inconclusive` by default.
  `assertNoGc(summary, rules, { allowInconclusive: true })` restores the
  v1.0.0 acceptance of untestable claims.
- `VERDICT_MATRIX` exported as data (rule x source -> `'yes' | 'no' | 'needsHeap'`).
- **Fixed silent hole:** Firefox / Safari (`source: 'none'`) with
  `maxMajor: 0` used to return `ok: true` because no rules could be
  evaluated. Now returns `inconclusive`.
- `gc.phase(name)` marks a linear phase boundary. Phases attribute GC events
  to their bucket by `startTime` (not wall-clock at record time -- the async
  observer forces us to bucket correctly). Rules gain per-phase form:
  `{ phases: { warmup: { maxMajor: 1 }, steady: { maxMajor: 0 } } }`. Report
  grows `checkedByPhase`.
- `gc.settle(options?)` returns `Promise<{drained, waited}>`. Replaces the
  v1.0.0 README's `await setTimeout(50)` guess. Written with an explicit
  `Promise` constructor (not `async/await`) to keep allocation transparent.
- `test/07-self-noise.mjs` measures and publishes the profiler's own
  footprint. Zero majors is a hard invariant.
- `VERSION` const exported from `Gc.js`; bumped in three places per the
  ecosystem convention (const, test assertion, package.json).

### Differential and rep-aware gating

- `compareGc(control, candidate, rules?)` and `assertCompare(...)` --
  gate on `candidate - control` deltas rather than absolutes. Source
  mismatch -> inconclusive with `reason: 'source_mismatch'`.
- Rules: `maxExtraMajor` (default 0), `maxExtraMinor`, `maxExtraPauseMs`,
  `maxExtraTotalMs`, `maxExtraAllocRate`.
- `aggregateGc(summaries)` returns per-metric `{min, median, max, all}`.
- `gateReps(summaries, rules, options?)` and `assertReps(...)` -- rep-aware
  gating with per-rule policies:
    - `'all-clean'` (default for `maxMajor`, `maxMinor`)
    - `'best-clean'` (default for `maxPauseMs`, `maxTotalMs`, `maxAllocRate`)
    - `'median'`
    - `'quorum-N'`
- `REP_POLICY_DEFAULTS` exported.
- `captureFingerprint()` -- environment: node, v8, platform, arch, cpu.
- `createBaseline(aggregate)` -- JSON-able baseline. No file I/O in core;
  users serialize with `JSON.stringify` and commit as they see fit.
- `checkAgainstBaseline(current, baseline, options?)` and
  `assertAgainstBaseline(...)`. Regression semantic: `current.median >
  baseline.max` per metric.
- Fingerprint mismatch -> inconclusive with `reason: 'fingerprint_mismatch'`
  by default. Override with `{ acceptFingerprintMismatch: true }`; report
  carries `fingerprintMismatchAccepted: true` as audit trail.

### CI harness

- `formatConsole`, `formatJson`, `formatMarkdown`, `formatGithubAnnotations`
  -- pure functions rendering any of the four report shapes. Dispatch on
  the new `kind: 'gc' | 'compare' | 'reps' | 'baseline'` field.
- New subpath `./register` (node-only): auto-attaches a `GcProfiler` at
  module load, dumps summary on `beforeExit` to a temp path.
- New subpath `./test-helpers` (node-only): `withGcGate(t, rules, fn)`
  wraps a node:test body in start/settle/assert; `measureGc(t, fn, opts)`
  returns the report without asserting.
- CLI: `lite-gc-gate run <script>` with `--reps`, `--config`, `--format`,
  `--json`, `--baseline`, `--update-baseline`,
  `--accept-fingerprint-mismatch`, `--allow-inconclusive`. Exit codes:
  0 pass, 1 fail, 2 inconclusive, 3 infrastructure error.
- Canonical `templates/GcGate.mjs` for the ecosystem rollout.
- Publish smoke test verifies all subpaths resolve.

### Attribution

- `gc.enter(name)` / `gc.exit()` -- nesting regions. Attribution by
  `startTime` walks intervals backward to find innermost containing.
- `summary.byRegion[name].gc` mirrors the phase-snapshot shape.
  `unattributed` bucket appears only when events fell outside all region
  intervals during a region-active window.
- Rules gain `perRegion: { [name]: GcRulesBase }`. Report gains
  `checkedByRegion` (parallel to `checkedByPhase`).
- **Attribution is firing-site, not allocator.** A pause during region B
  charges B, even if the allocation debt was accumulated in region A. This
  is documented in the README and enforced by a torture scenario -- a
  regression there means the disclaimer has been silently broken.
- Capacities: 32 regions, 16 nesting, 2048 intervals. Throw on overflow.
- New subpath `./explain` (node-only): `startExplainSampling(options?)` /
  `formatExplainConsole(result)`. Uses `node:inspector` heap sampling to
  answer the allocator question that region attribution deliberately
  doesn't. STRICT OPT-IN -- perturbs measurement, never runs inside a
  gated run.

### Types added

- `GcVerdict`, `GcRuleName`, `GcVerifiability`, `AssertNoGcOptions`
- `PhaseGcStat`, `PhaseSnapshot`, `SettleOptions`, `SettleResult`
- `GcDifferentialRules`, `GcDifferentialResult`, `GcDifferentialRuleName`
- `GcStatsBlock`, `GcAggregate`, `GcRepPolicy`, `GcRepGateResult`, `GateRepsOptions`
- `GcFingerprint`, `GcBaseline`, `GcBaselineResult`, `CheckAgainstBaselineOptions`
- `GcReport`, `GcReportKind`
- `ExplainOptions`, `ExplainStack`, `ExplainResult`, `ExplainHandle`

### Tests

240 tests, all passing under `node --expose-gc`. Includes 48 torture
scenarios (18 verdict-integrity, 17 rep/differential/baseline, 13
attribution) enforcing:

- **Axis A** (must produce `inconclusive`) is never silently green.
- **Axis B** (must produce `fail`) pins the D4 policy (all-clean for
  majors) and the honesty pin (firing-site attribution) that guard the
  ecosystem's zero-major claims.
- **Axis C** (must produce `pass`) covers 2x pause variance, hostile
  sibling observers, and high-frequency region churn.
- **Axis D** (self-consistency) enforces `compareGc(pooled, x)` matching
  `checkNoGc(x)` when control is empty, verdict purity, JSON round-trip
  preservation, and region accounting sums.

### Notes and limitations

- No breaking changes to v1.0.0 code. Existing usage stays valid.
- Baseline strictness (`current.median > baseline.max`) is intentionally
  strict on sub-millisecond metrics. Capture baselines with `--reps 20+`
  to widen the max envelope if run-to-run variance flakes the gate.
- The CLI's register preload uses `beforeExit`, which does not fire if
  the target calls `process.exit()` explicitly. Refactor eager-exit
  targets.
- Self-noise numbers (five-run ranges across dev hardware): 0 majors,
  1-13 minors, 0.3-0.7 ms longest pause, 144 B - 770 KB heap growth,
  2.5-4 ms settle. Minor GC frequency and heap growth vary widely by
  machine; ceilings loosened to regression sentinels (max 30 minors,
  5 ms pause, 4 MB heap growth).
- Per-region and per-phase heap accounting is not tracked in this
  release; `maxAllocRate` at either scope is inconclusive.

## 1.0.0

Initial release. `GcProfiler` (start/stop/sampleHeap/markFrame/summary),
`checkNoGc` / `assertNoGc`, rules `maxMajor` (default 0), `maxMinor`,
`maxPauseMs`, `maxTotalMs`, `maxAllocRate`; sources `gc` (node),
`heap` (Chrome), `none` (Firefox, Safari); 16 tests; leaky-vs-pooled
differential asserted in `test/02-gc-live`.
