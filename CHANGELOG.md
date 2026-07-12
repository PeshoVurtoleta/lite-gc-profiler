# Changelog

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
