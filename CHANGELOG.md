# Changelog

## 1.4.0

Batch 7: the frame lane. Five new public functions -- `measureFrames`,
`checkFrames`, `assertFrames`, `compareFrames`, `assertCompareFrames` --
gate the render-loop question the ops lane couldn't answer: how does
this behave inside a scheduled frame budget? Additive; zero behavior
change for existing v1.3.x callers.

### What's new

- `measureFrames(fn, opts)` -- async, drives a scheduler through
  `warmup + frames` ticks, one call per tick. Result includes
  `bytesPerFrame` (retained bytes/frame) with a `bytesPerFrameStable`
  flag, `majorsPerKFrame`, `minorsPerKFrame`, `maxPauseMsPerFrame`,
  `droppedFrames`, a `frameTimes` percentile distribution
  (`p50/p95/p99/max`), and `asyncResidual` -- bytes the heap grew past
  `gc.settle()`. Schema: `'lite-gc-frames/1'`.

- `opts.stabilize` -- forces a full GC at each steady boundary so
  `bytesPerFrame` is the retained live-set delta rather than the raw
  heapUsed climb. On by default when `globalThis.gc` is available
  (`--expose-gc`); `true` demands it (rejects otherwise); `false` opts
  out to the slope estimate.

- Scheduler abstraction with three modes and one escape hatch:
  - `'auto'` (default) prefers `requestAnimationFrame`, falls back to
    a self-correcting `setTimeout` polyfill with drift compensation.
  - `'raf'` -- forces raf, throws `RangeError` at setup if unavailable.
    No silent fallback: explicit intent honored.
  - `'polyfill'` -- forces the setTimeout pacer.
  - A function `(cb) => handle` -- deterministic schedulers for tests.

- Five new `VERDICT_MATRIX` rules: `maxBytesPerFrame`,
  `maxMajorsPerKFrame`, `maxMinorsPerKFrame`, `maxPauseMsPerFrame`,
  `maxDroppedFrames`. Four mirror the per-op rules' verifiability.
  The fifth, `maxDroppedFrames`, is the **first source-agnostic rule
  in the matrix** -- work-time is measured directly from
  `performance.now()`, no memory channel needed. Validates the matrix
  design generalizes without special cases.

- Delta rules for `compareFrames`: `maxExtraBytesPerFrame`,
  `maxExtraDroppedFrames`.

### `bytesPerFrame` design: GC-anchored live-set delta

The ops lane's two-point heap delta doesn't survive a 300-frame window,
and a raw-heap slope over the steady samples is worse: a per-frame
scheduler's own transient churn accumulates without tripping a GC drop,
so a *clean* workload reads a phantom ~1000-2000 B/frame while a cold
run can collapse a real leak to zero. Neither makes `maxBytesPerFrame`
trustworthy.

`measureFrames` therefore stabilizes by default (when `globalThis.gc`
is available): it forces a full GC at each steady boundary -- attributed
to a `'stabilize'` phase so steady kind-rules stay clean -- and reports
`bytesPerFrame` as the post-GC live-set delta across the window. Clean
workloads read ~0 (down to a small, machine-dependent V8 live-set jitter
floor), real leaks read their true retained rate, and the figure is
stable across cold and warm runs because both ends are live sets, not
raw heap. `bytesPerFrameStable:true` marks this path.

Without a forceable GC (a browser, or `stabilize:false`), it falls back
to a retention-aware slope over ~32 periodic samples (LSQ through
post-GC-drop anchors). Best-effort, flagged `bytesPerFrameStable:false`;
gate above its noise floor.

Exact `maxBytesPerFrame:0` is not physically achievable from heap
sampling -- the stabilized floor is jitter, not allocation. For tight
leak gating below that floor, use `compareFrames` /
`maxExtraBytesPerFrame`: a control-vs-candidate differential cancels the
apparatus floor, so clean-vs-clean nets to ~0 and a real leak stands out
at its true rate.

### Attribution scope

For a cooperative frame function (fully awaits its own work),
attribution is accurate. For fire-and-forget promise chains, V8's
async-context propagation can attribute allocations to whichever phase
is current when the perf_hooks callback delivers the GC event.
`asyncResidual` in the result gives a smoke signal for that case (bytes
still growing past settle). Full interleaved-async attribution is a
concurrency-lane concern for v1.5.0.

### Torture (G17.5)

New torture file: `test/torture/g17-5-frames.test.mjs`. Four-axis
discipline:
- **Axis A**: adversarial (throw propagation, async rejection, `raf`
  unavailable guard).
- **Axis B pin pair**: warmup allocation is quarantined out of the
  steady `bytesPerFrame` (the steady-start GC collects it before the
  baseline is read, so heavy-warmup steady still reads ~0); a real
  ~1.7 KB/frame steady leak reads clearly above the clean floor in a
  single stabilized run.
- **Axis C**: `measureFrames` induces zero *steady* majors on a noop
  workload -- validating that the stabilize GCs are attributed to the
  `'stabilize'` phase, not `'steady'`.
- **Axis D**: cold-run and warm-run produce the same verdict on
  `maxBytesPerFrame` (clean passes, leak fails, cold==warm -- the
  GC-timing invariant the estimator exists to hold) and on
  `maxDroppedFrames`; result-shape stability across cold/warm.

Plus one wall-clock smoke test for the real polyfill scheduler --
proves the code path executes and terminates within a bound, without
opening the door to timing-dependent assertions elsewhere.

### Full-suite tally

**376 tests, all pass** under `--expose-gc`. 333 baseline + 33 standard
frame + 10 torture frame.

## 1.3.1

Wave 1 CI hardening. One user-facing addition: `stabilize: true` on
`measureOps` and its convenience forms (`assertOps`, `compareOps`,
`assertCompareOps`). Zero behavior change for existing v1.3.0 callers who
don't opt in.

### The gap this closes

`assertCompareOps` is designed to be called in cold CI shards. But
"cold" plus "compare" plus per-op memory sampling has two failure modes
that can collapse a legitimate leak signal to zero:

1. JIT tier-up allocation churn inflates the control's `bytesPerOp`,
   narrowing the delta between control and candidate.
2. A one-off major GC mid-steady compacts `heapUsed` below the
   start-boundary sample. The reported delta goes non-positive; since
   `bytesPerOp` clamps negative to zero, the retained candidate's leak
   disappears from the report.

Neither is a bug in the primitive -- both are "bytesPerOp may be 0 if GC
ran," the library's documented contract. But that contract has an
uncomfortable gap for cold-CI callers, which is precisely where
`assertCompareOps` is designed to be called.

### `stabilize: true`

Opt-in on `MeasureOpsOptions`. When set:

- Forces a full GC (`globalThis.gc()`) at each steady-phase boundary,
  so `bytesPerOp` reflects the **surviving-allocation delta**
  (retention) rather than transient allocation.
- Adds a `stabilize` phase to `summary.phases` for shape stability.
- Requires `node --expose-gc`; throws `RangeError` at measurement time
  otherwise with actionable guidance (the error message names the
  `--expose-gc` flag explicitly).

Applied through the convenience forms via `opts` inheritance -- one
option, propagates to both measurements in `compareOps` /
`assertCompareOps`:

    assertCompareOps(
        control, candidate,
        { maxExtraBytesPerOp: 20 },
        { ops: 1000, warmup: 100, stabilize: true }
    );

### Honest limitation (documented)

The forced-GC events arrive via `perf_hooks` asynchronously, typically
after `measureOps` has returned. So the `summary.phases.stabilize.gc.*`
counters are unreliable and **users should not gate on them.** The
recommended pattern is: use `stabilize: true` for retention gating
(`maxBytesPerOp`, `maxExtraBytesPerOp`), and use `stabilize: false` for
GC-event-count gating (`maxMajorsPerKOp`, `maxPauseMsPerOp`). Both
are honest and correct on their own axes.

If demand appears for a stabilize path that also captures the forced-GC
events -- for combined byte + event-count gating -- that's an async
follow-up (`measureOpsAsync` or `settle:true`), a separate design pass.

### Rules matrix, source columns, phases

No change. `stabilize:true` doesn't add rules, doesn't add sources, and
doesn't change the shape of `summary.phases.steady`. The new
`summary.phases.stabilize` sub-summary is additive and only appears
when `stabilize:true`.

### Torture

`test/torture/g14-6-stabilize.test.mjs` -- 8 scenarios covering four
axes:

- **Axis A** (adversarial): guard fires before fn runs; strict-boolean
  gate (truthy `1`/`'x'`/`{}` don't accidentally enable); error message
  names `--expose-gc` explicitly.
- **Axis B** (signal-under-noise): 100 B/op retained leak survives
  stabilize's forced GC; transient allocation collapses below 50 B/op.
- **Axis C** (perturbation bound): stabilize on a noop workload stays
  under 5 B/op -- the mode adds no user-visible per-op cost.
- **Axis D** (self-consistency): **ecosystem pin** -- cold-run
  `assertCompareOps` + stabilize produces the same verdict as warm-run
  + stabilize. This is the invariant that makes stabilize worth
  existing. Also: shape-stability (`stabilize` phase existence tracks
  the opt-in in both directions).

### Compatibility

Fully additive. Existing v1.3.0 code -- including all baselines and
gates -- behaves byte-identically. `stabilize` is `false` by default;
runtimes without `--expose-gc` remain fully supported for anything not
explicitly opting in.

Node 20+ (unchanged). Chrome/browser: `stabilize:true` throws
`RangeError` since `globalThis.gc` is unavailable; use warmed-workload
measurement instead.

### Copyright

Zahary Shinikchiev. MIT.

## 1.3.0

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
