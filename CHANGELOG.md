# Changelog

## 1.8.0

Batch 11: multi-context frame aggregation (G23). Three new functions --
`aggregateFrameReports`, `checkAggregateFramesReport`,
`assertAggregateFramesReport` -- extend v1.7.0's multi-context story to
the render-loop lane. Additive; zero behaviour change for existing
v1.7.x callers.

### What's new

- `aggregateFrameReports(reports, opts?)` -- weighted aggregation of
  per-context frames results into a single `'lite-gc-frames-multi/1'`
  report. Frames-weighted rates for `bytesPerFrame` /
  `majorsPerKFrame` / `minorsPerKFrame`; MAX across contexts for
  `maxPauseMsPerFrame`; SUM across contexts for `droppedFrames` and
  `asyncResidual`; logical AND with provenance for
  `bytesPerFrameStable`.

- `checkAggregateFramesReport(multi, rules)` -- gate the aggregate
  against the same rule vocabulary as `checkFrames`
  (`maxBytesPerFrame`, `maxMajorsPerKFrame`, `maxMinorsPerKFrame`,
  `maxPauseMsPerFrame`, `maxDroppedFrames`). Mixed-source aggregates
  return `inconclusive` with `reason: 'source_mismatch'`.

- `assertAggregateFramesReport(reports, rules, opts?)` -- convenience
  form throwing `GcBudgetError` on fail or `GcInconclusiveError` on
  inconclusive.

### One field deliberately not carried into the aggregate

`frameTimes` (`p50`/`p95`/`p99`/`max`) is present on each per-context
report and preserved in `perContext[i]`, but the aggregate does NOT
include it. A system-wide percentile cannot be reconstructed from
per-context summary percentiles -- computing a global p95 requires
every frame's work-time, not four contexts' p95s. The aggregate could
invent a max-of-p95s or an average-of-p95s but neither would be a real
percentile; it would be a number that reads plausible on the dashboard
and lies on the gate. If a workload needs distribution stats, gate
`maxDroppedFrames` on the aggregate and hold each context's
`frameTimes` separately for inspection.

### Dilution guard applied from day one

The v1.7.1 hardening pass on the ops aggregator (G23.5 adversarial)
closed a class of bug where a missing or non-finite rate metric on one
context got silently averaged as zero, letting an unmeasurable context
read the whole system cleaner than reality. That discipline is
applied to the frames aggregator from day one: a missing or
non-finite `majorsPerKFrame`, `minorsPerKFrame`, `maxPauseMsPerFrame`,
or `droppedFrames` on ANY context marks the aggregate metric as `null`,
which routes to `inconclusive` at gate time. Silently averaging a
missing metric as zero is the failure mode we refuse.

`asyncResidual` is the one exception: missing counts as zero because it
is a smoke signal (bytes past `settle()`), not a gated metric. A lane
that does not track it contributes no residual by definition.

### Torture (G24.5)

New torture file: `test/torture/g24-5-frames-multi.test.mjs`. Five axes:

- **Axis AA -- dilution**: an unmeasurable context cannot dilute a
  sibling's real numbers; the browser-lane case (source='heap', no
  majors) still yields null, not zero; fully-populated inputs still
  aggregate as weighted numbers.
- **Axis AB -- stability provenance**: mixed present/absent yields
  false, all-absent stays true (legacy lane), one false anywhere
  degrades.
- **Axis AC -- adversarial inputs**: NaN/Infinity never yields pass,
  lying getter observed once, order-independent, does not mutate
  inputs, mixed sources refuse to fabricate a verdict, genuine
  over-budget still fails cleanly.
- **Axis AD -- frames-specific**: `frameTimes` absent from aggregate
  but preserved in `perContext`; `droppedFrames` sums (not averages);
  `asyncResidual` sums.
- **Axis R -- real cross-context round-trip**: two Node
  `worker_threads` workers each running `measureFrames` with a
  fast-sched polyfill scheduler, results shipped back via
  `postMessage`, aggregate on main. Pins that the frames result shape
  (with `frameTimes` and nested summary tree) survives structured
  clone and that the aggregator handles genuine cross-context frame
  results.

### Full-suite tally

**655 tests, all pass** under `--expose-gc`. 601 carried from v1.7.0 + 28
standard aggregate-frames + 18 torture aggregate-frames.

### Hardening of the new lane

The frames aggregation lane carries the v1.7.0 dilution lesson correctly:
unknown propagates as unknown through the frames-weighted rates AND through
the `droppedFrames` SUM, so an unmeasurable context can neither dilute a rate
nor vanish from a total. Cross-lane confusion is caught at the boundary
(a frames report handed to `aggregateWorkerReports` throws naming the missing
`ops` field), rule typos throw, overflow and mixed sources go inconclusive,
inputs are never mutated, and a lying getter is read exactly once.

One gap, in the single metric where the rule did not hold:

- **A corrupt `asyncResidual` reading was folded in as zero.** Absence
  legitimately counts as zero -- a lane that does not track residual has none,
  and this is a smoke signal rather than a gated metric, so absence should not
  poison the total. But a PRESENT non-finite value is a broken reading, not an
  absent one, and summing it as zero made the aggregate under-report exactly
  when something was wrong: one context with `NaN` residual beside one
  reporting 1000 summed to 1000 and read as if nothing were unaccounted for.
  Absence still counts as zero; corruption now yields `null`.
  `AggregatedFramesMetrics.asyncResidual` is `number | null`.

Pinned by `test/torture/g24-6-frames-multi-adversarial.test.mjs`
(8 scenarios, axes AD-AE). Suite: 647 -> 655.

### Cookbook

Rebuilt from 10 recipes to 19, graded across four tiers, and extended to cover
what the last three releases added. Public-API coverage went from 24 of 53
exports to 42. New: a Recipe 0 that measures before it gates, the frames gate
lane, both multi-context aggregation lanes (v1.7.0 ops and v1.8.0 frames, the
latter previously unmentioned anywhere in the cookbook), the four CI
formatters plus `explainDiff`, the repetition-policy lane, and a Pro tier on
portable thresholds, triaging `inconclusive`, and differential gating. Every
code sample was executed against this build.

## 1.7.0

Batch 10: multi-context aggregation (G22). Three new functions --
`aggregateWorkerReports`, `checkAggregateReport`, `assertAggregateReport`
-- extend the ops rule vocabulary across worker heaps. Additive; zero
behaviour change for existing v1.6.x callers.

### The problem this closes

Every measurement lane before this batch measures ONE shared heap in ONE
context. That's what the v1.5.1 "overlapping measurements throw"
hardening enforces -- all lanes share one heap. But a real workload
distributed across N Node worker_threads or N browser Web Workers is N
heaps, N GC observers, N `PerformanceObserver`s. A gate that measures
only the main thread misses everything the workers retain.

### What's new

- `aggregateWorkerReports(reports, opts?)` -- weighted aggregation of
  per-context ops results into a single `'lite-gc-ops-multi/1'` report.
  `bytesPerOp` is `(total bytes) / (total ops)` -- ops-weighted, so a
  1-op context with a huge rate cannot swamp a 1M-op context with a
  tiny rate. `bytesPerOpStable` is logical AND -- one unstable context
  degrades the aggregate. `maxPauseMsPerOp` is MAX -- the worst pause
  anywhere in the system. Mixed sources yield `source: 'mixed'`.

- `checkAggregateReport(multi, rules)` -- gate the aggregate against the
  same rule vocabulary as `checkOps` (`maxBytesPerOp`, `maxMajorsPerKOp`,
  `maxMinorsPerKOp`, `maxPauseMsPerOp`). Mixed-source aggregates return
  `inconclusive` with `reason: 'source_mismatch'`. The v1.5.1
  fail-closed hardening applies here too -- unknown rule keys throw,
  non-finite thresholds throw, non-finite aggregate metrics route to
  inconclusive.

- `assertAggregateReport(reports, rules, opts?)` -- convenience form
  that throws `GcBudgetError` on fail or `GcInconclusiveError` on
  inconclusive.

### What this batch does NOT include

Pure aggregation only. The user brings their own workers. No convenience
`measureOpsAcrossWorkers` primitive that owns worker spawning -- the
worker-spawning API differs meaningfully between runtimes (Node
`worker_threads` vs browser `new Worker(URL.createObjectURL(new Blob(...)))`)
and a portable convenience wrapper cannot faithfully own both. The
README documents both patterns with runnable examples.

`@zakkster/lite-worker` is the recommended browser-side transport (its
`frameChannel` is the zero-GC ping-pong ring that pairs cleanly with
`measureFrames`); it is **not** a hard dependency of
lite-gc-profiler -- `globalThis.Worker` is undefined in Node, so a
runtime-agnostic import would fail in the exact place CI gates run.

### Torture (G22.5)

New torture file: `test/torture/g22-5-multi.test.mjs`. Five axes:

- **Axis A**: adversarial (NaN/Infinity in per-context bytesPerOp,
  getters that lie between reads, prototype-injected properties). The
  read-once discipline: each metric is captured into a local before the
  finiteness check, so a lying getter is observed exactly once. Caught
  a real bug during build -- initial impl read `r.bytesPerOp` three
  times; fixed.
- **Axis B**: weight-imbalance (1-op context alongside 1M-op context;
  the weighted average must equal `total_bytes / total_ops`, not a
  naive mean).
- **Axis C**: no perturbation -- aggregating 1000 reports 10 times inside
  a live `GcProfiler` window induces no majors.
- **Axis D**: identical input yields byte-identical aggregate on repeat
  calls.
- **Axis R**: real Node `worker_threads` round-trip. Spawns two workers,
  each runs `measureOps` on its own heap, ships results back via
  `postMessage`, aggregates on main. Pins that the ops result shape
  survives structured clone and that the aggregator handles genuine
  cross-context inputs -- not just synthetic POJOs.

### Full-suite tally

**601 tests, all pass** under `--expose-gc`. 558 carried from v1.6.0 + 23
standard aggregate + 8 torture aggregate.

### Hardening of the aggregation lane

The new lane got the same attack-first pass as the rest of the package, before
release. Two defects, both fail-open, both found by asking the question this
package always asks: what does it report when it cannot measure?

- **An unmeasurable context diluted the aggregate toward clean.** A context's
  `ops` count is added to `totalOps` unconditionally, but a missing or
  non-finite `majorsPerKOp` / `minorsPerKOp` / `maxPauseMsPerOp` was skipped in
  the numerator -- so the broken context sat in the denominator contributing
  zero. Measured: one context with `NaN` minorsPerKOp beside one clean context
  at 1.0 aggregated to **0.5**, and a `NaN` majorsPerKOp aggregated to **0
  majors with a passing verdict**. `bytesPerOp` already had the right
  discipline (unknown propagates as `null`); its three siblings now do too, and
  a gate on an unknown metric returns `inconclusive` instead of green.

  The sharpest case is the most ordinary one: `measureOps` results carry no GC
  rates at all -- the synchronous lane cannot observe GC events, as the README
  has always said -- so aggregating them reported a fabricated clean GC profile
  that `maxMajorsPerKOp: 0` passed. `AggregatedOpsMetrics.majorsPerKOp`,
  `minorsPerKOp` and `maxPauseMsPerOp` are now `number | null`.

- **A mixed stability set claimed stability.** `bytesPerOpStable` treated an
  absent flag as `true`. In an all-legacy set that is right -- there is nothing
  to degrade -- but when one context reports the flag and another omits it,
  absence is unknown provenance, and claiming `true` asserts what the aggregate
  cannot show.

Also carried forward: the evidence-lane hardening from v1.6.0
(`formatGithubAnnotations` control-character sanitising, narrator robustness),
which this branch predated. Pinned by
`test/torture/g23-5-aggregate-adversarial.test.mjs` (11 scenarios, axes AA-AC)
and `g22-5-evidence-adversarial.test.mjs` (9 scenarios). Suite: 589 -> 601.

## 1.6.0

Batch 9: the evidence lane (G21/G22). Three new functions under the
existing `./explain` subpath -- `explainReport`, `explainDiff`, and
`gateBadge` -- close the loop between "gate failed in CI" and "developer
sees why in the log." Additive; zero behaviour change for existing
v1.5.x callers.

### What's new

- `explainReport(report, opts?)` -- narrate any gate report as a
  human-readable multi-line string. Handles the four report families
  emitted across the library (whole-window `check`, per-op `checkOps`,
  per-frame `checkFrames`, per-op-async `checkOpsAsync`, plus all their
  compare variants) with a unified layout: verdict header, violations
  block naming rule / actual / limit / delta and percent-over, Cannot
  verify block for inconclusive verdicts, per-metric Comparison block
  for compare reports, Run footer with source and stabilize flags, and
  Hints when the report carries evidence for actionable advice
  (`asyncResidual > 0`, `bytesPerFrameStable: false`,
  `bytesPerOpStable: false`, `reason: 'source_mismatch'`).

- `explainDiff(controlReport, candidateReport, opts?)` -- narrate two
  INDEPENDENT gate reports as a compare-style diff, for the case where
  the caller ran two separate `check*` calls (e.g. against distinct
  baselines) without going through `compare*`. A kind mismatch is
  surfaced in the header, not thrown.

- `gateBadge(report, opts?)` -- produce a status marker for the report
  in one of three formats: `'text'` (e.g. `"gc gate: fail (2)"`),
  `'shields-json'` (the shields.io endpoint schema for a live badge),
  or `'svg'` (a self-contained ~1 KB shields-style SVG for direct README
  embedding). Colours are brightgreen / red / yellow for
  pass / fail / inconclusive.

Everything under the same `./explain` subpath as `startExplainSampling`
-- these are pure formatters that pair with the existing allocator-side
attribution primitive when a gate fails.

### Discipline: pure formatters, no perturbation

Every function in the evidence lane is a read-only pass over a gate
report. No measurement, no `PerformanceObserver`, no
`process.memoryUsage`, no allocation on any hot path -- pinned by axis-C
in the G21.5 torture, which runs the formatters inside a live
`GcProfiler` window and asserts that no majors were induced.

### Report-shape flexibility

`explainReport` accepts reports without an explicit `schema:'lite-gc-report/1'`
tag. The newer frames / ops-async paths emit that tag; the older sync-ops
and reps-aware paths predate it and only carry `kind`. The formatter
duck-types on the `verdict` field so baseline reports on disk keep
rendering. Reports with an unknown schema value are still rejected.

Two violation shapes are also accepted: the newer `{ rule, metric, actual, limit }`
and the legacy `{ metric, actual, limit, reason }`. `rule` is preferred
for the header when present; `reason` is preferred for the human-readable
"means:" line when present.

### Demo update

`demo/index.html` now includes a formal-gate panel below the live scope:
a Run gate button that invokes `assertFrames({ maxBytesPerFrame: 512 })`
on the currently-selected mode (Pooled / Leaky), renders the resulting
`gateBadge` SVG inline, and displays the `explainReport` narrative in a
pre-formatted block. Same primitive a README would embed; same output a
CI job would log.

### Torture (G21.5)

New torture file: `test/torture/g21-5-evidence.test.mjs`. Four-axis
discipline adapted for a pure-formatter lane:

- **Axis A**: adversarial (NaN/Infinity in actual/limit, 100 000-violation
  reports, HTML-and-ANSI-tainted rule strings, verdict:pass with stale
  violations, missing optional fields).
- **Axis B**: real-fail reports must name the rule and include actual/limit
  numerals; compare reports must include both control and candidate
  metrics in the Comparison block (delta alone is unactionable).
- **Axis C**: no perturbation -- the formatters run inside a live
  `GcProfiler` window without inducing majors on their own workload.
- **Axis D**: identical report input yields byte-identical output;
  minimal-report shape (verdict-only) still produces structured output.

### Full-suite tally

**549 tests, all pass** under `--expose-gc`. 517 baseline (v1.5.2) + 22
standard evidence + 10 torture evidence.

## 1.5.2

Adversarial hardening, two passes (G99.9 + G99.10). Zero new public API.
Seven defects found by attack-first torture over what v1.5.1 had already
hardened: five on the verdict surfaces v1.5.1 did not reach -- the phase and
region snapshots, the heap sampler, the `checkNoGc` threshold path and the
baseline comparator -- then two more on a second pass over that work, an
infinite-loop DoS in capacity handling and an observation-window hole that
let a profiler inherit GC history it never watched. All seven are closed and
pinned by `test/torture/g99-9-extreme.test.mjs` (41 scenarios) and
`test/torture/g99-10-deep.test.mjs` (17 scenarios, axes T-X).
Suite: 459 -> 517.

v1.5.1 closed three routes to a false `'pass'` on the *rules* surface. Four of
the five G99.9 defects are the same class on other surfaces. The two G99.10
defects are different: one is a denial of service, and the other fails
*closed* -- it made a zero-GC gate blame your code for the previous
workload's garbage.

Also verified and pinned: the retention floor (the smallest per-op leak
`measureOps` convicts, and the zero-alloc workload it must not), and full
accounting integrity while million-node lists, 10k-deep closure chains,
5k-deep prototype chains, nested Maps and nested arrays are torn down under
phases, with GC forced at all 16 region depths.

### What can change what you observe

Two things, both detailed below:

- a ring capacity above the new `MAX_RING_CAPACITY` ceiling now throws
  `RangeError`, where it previously hung the process or silently allocated a
  gigabyte-scale ring;
- your GC numbers no longer include events that began before the profiler
  started, so a gate that was failing on the *previous* workload's garbage
  will now pass. If a gate starts passing after this upgrade, it was wrong
  before.

Nothing else is: every other fix is observable only on input that previously
produced a wrong answer. In particular `summary.phases` and
`summary.byRegion` keep their exact shape -- prototype, property access,
iteration, spreads, `JSON.stringify`, `deepStrictEqual` against an object
literal, and the `Record<string, PhaseSnapshot>` type are all unchanged.

### The gate now fails closed (continued)

- **A phase or region named `__proto__` no longer vanishes from the summary.**
  Both snapshots were built with `{}` and populated via `out[name] = ...`, so
  the name `__proto__` set the object's prototype instead of creating an own
  property. The GC events were counted globally but were unreachable through
  `Object.keys`, `JSON.stringify`, or any per-phase rule -- a phase budget on
  that phase could never fire. Both snapshots now define their keys with
  `Object.defineProperty`, which creates an own property for every name --
  including `__proto__` -- without touching the object's prototype. A
  null-prototype object would also close the hole, but it would change the
  shape consumers already rely on: `deepStrictEqual(phases, {})` would break,
  and `phases.hasOwnProperty(...)`, `String(phases)` and `` `${phases}` ``
  would all throw `TypeError` -- a crash in an ordinary logging path, traded
  for a bug most consumers would never hit. `constructor`, `toString`, and
  every other `Object.prototype` member were already safe (the intern tables
  are `Map`s); only `__proto__` was special.

- **A non-finite heap sample no longer zeroes subsequent allocation
  accounting.** `sampleHeap()` computed `used - _heapPrev` and then assigned
  `_heapPrev = used` unconditionally. One `NaN` reading -- a mocked or failing
  `performance.memory`, a partial measurement -- poisoned `_heapPrev`, so the
  *next* real sample computed `real - NaN = NaN`, accrued nothing, and left
  `allocBytes` at `0`. Measured: the same 60 MB of growth reported
  `allocBytes: 59_999_000` and `verdict: 'fail'` when clean, versus
  `allocBytes: 0` and `verdict: 'pass'` with `checked: {maxAllocRate: true}`
  when one `NaN` sample sat in the middle. Non-finite samples are now dropped
  without advancing `_heapPrev`, so growth bracketing the glitch is still
  measured against the last valid reading.

- **`checkNoGc` thresholds are read exactly once and must be finite.**
  `_evalRules` read each threshold twice -- once for the `!== undefined` guard,
  once for the comparison -- so a rules object with a getter could return `0`
  to the guard and `Infinity` to the comparison and gate nothing. Separately,
  `checkNoGc` never called `_validateRules` (that landed only on the ops and
  frames lanes in v1.5.1), so `checkNoGc(s, { maxMajor: NaN })` was green too.
  Each threshold is now snapshotted into a local and requires
  `_isFiniteMetric`; non-finite thresholds yield `inconclusive` with
  `checked: {rule: false}` rather than `pass`.

- **`checkAgainstBaseline` no longer certifies a baseline that verifies
  nothing.** Two independent routes:

  1. The metric loop skipped any pair missing from either side (`continue`),
     then set `verdict = violations.length ? 'fail' : 'pass'`. A baseline with
     no comparable metrics -- truncated file, schema drift, hand-edited JSON,
     empty aggregate -- compared *nothing* and returned `'pass'` with
     `checked: {}`.
  2. A non-finite baseline `max` made `median > max` false for every input, so
     all 11 metrics reported `checked: true` while enforcing nothing. Note
     `JSON.stringify(NaN)` is `null`, so a *saved* baseline delivers `null` and
     a hand-edited one can deliver a string; all three behaved identically.

  A comparison now counts only when both comparands are finite, and a report
  with nothing verified is `'inconclusive'` with
  `reason: 'no_comparable_metrics'`. Partially poisoned baselines still gate on
  the metrics that survive, and real regressions are still caught.

### Diagnostics

- **The overlapping-measurement error now names the abandoned-run cause.** The
  guard releases only when a run settles, so a frame scheduler that never fires
  its callback -- or an async op whose promise never resolves -- holds it for
  the life of the process, and every later measurement failed with "await each
  measurement before starting the next", which misdiagnoses a caller who did.
  The message now explains this, and explains why there is deliberately no
  timeout release: an abandoned run keeps allocating into the same heap, so
  releasing the guard would resume the cross-contamination it exists to
  prevent. Fix the run that never finished.

### Confirmed correct under attack (no change)

Recorded so they are not re-litigated. Transient churn reads `bytesPerOp ~ 0`
and *passes* a tight budget -- `bytesPerOp` measures surviving allocation, and
flagging transient garbage as retention would be a false `fail`, equally
corrosive. Also verified: reentrant and synchronous frame schedulers,
throwing/rejecting workloads releasing the guard, 2M op counts, capacity-1
rings, 3000 forced collections, dual concurrent observers, `settle()` under a
sustained storm, mixed-source `compareGc`/`gateReps`, `__proto__` payloads in
rules and summary objects (no `Object.prototype` pollution), and all five hard
capacity limits at and past the cliff.

### An infinite-loop DoS in capacity handling

`pow2` rounded the ring capacity up with `p <<= 1`. The shift coerces to
32-bit: at 2**31 it wrapped negative, then to 0, and the loop spun
forever. `new GcProfiler(2**30 + 1)` -- and any larger capacity, through
every measure lane, since `_validateCapacity` accepted any positive
integer -- hung the process in an uninterruptible loop before any
allocation. Below the wrap it was a resource bomb instead: 2**26 silently
allocated a 1 GB ring, and 2**30 crashed the process attempting 16 GB.

Two changes, same policy as MAX_PHASES (throw loudly at the boundary):

- `pow2` now doubles with float multiply, which is exact for powers of
  two up to 2**53 and cannot wrap.
- Capacity has a hard ceiling, `MAX_RING_CAPACITY` (2**24 = 16,777,216
  slots; the ring costs 16 bytes/slot, so the ceiling is already 256 MB
  -- two orders of magnitude past the documented 8-256 range). The
  GcProfiler constructor and every lane's `opts.capacity` throw
  `RangeError` past it. The pins run in child processes with a timeout,
  so a regression here fails a test instead of hanging CI.

### start() and reset() are now hard cutoffs

Sync GC-heavy code blocks the event loop, so its 'gc' entries sit in the
perf_hooks dispatch queue -- and node delivers that backlog to an
observer registered *later in the same turn*. A profiler started after a
sync workload therefore inherited the workload's GC history:

- a zero-GC gate over genuinely quiet code **falsely failed** (measured:
  a profiler started right after six forced majors reported them all
  against an alloc-free window);
- phase sums diverged from `gc.count`, because the pre-start entries
  were counted globally but predate the first phase boundary
  (measured: sum 12 vs count 15 with three `measureOps` runs earlier in
  the same tick);
- `reset()` had the matching hole: queued pre-reset entries repopulated
  the counters it had just cleared;
- restarting after `stop()` could admit entries from the stopped gap.

The observer now records an observation floor at `start()` (and advances
it at `reset()`), and drops entries whose `startTime` precedes it -- one
compare per entry in the batched observer callback, not in a hot body.
An entry that *began* before `start()` is excluded even if it finished
after: observation covers events that began under observation. The
synthetic `record()` API is deliberately not subject to the floor; tests
inject events with arbitrary timestamps.

This is a behaviour change in the fail-closed direction: numbers that
previously included another workload's backlog no longer do. If a gate
of yours starts passing after this upgrade, it was previously blaming
your code for GC it did not cause.

### The synthetic `record()` surface validates its input

`GcProfiler.record(kind, durationMs, startTime)` coerced with
`+durationMs || 0`, which silently turned `NaN` into `0` and let negative and
infinite values through into the running totals. A single
`record(GC_MAJOR, -100)` produced `totalMs: -95` next to `maxMs: 5` -- so
`maxMs > totalMs`, `avgMs` went negative, and a `maxTotalMs` rule compared
against a negative total passes anything. `Infinity` was quieter and worse: it
poisoned `totalMs` and `avgMs` to non-finite for every subsequent read of that
profiler, not just the bad entry.

Both now throw `RangeError`, as does a non-finite `startTime`. This is a test
surface, so garbage-in would be a defensible policy -- except that the garbage
is indistinguishable from a real reading by the time a gate sees it. Pinned by
axis X in `g99-10-deep`. All 45 existing `record()` call sites were already
valid and are unaffected.

### Verified under attack (no change)

The retention floor is real and two-sided: one `{a:i}` retained per op
reads ~40 B/op and fails a 16 B/op budget; a genuinely zero-alloc op at
500k ops reads well under 1 B/op and passes the same budget. (At 50k
fast ops, V8 self-noise amortizes to several bytes/op -- size runs
accordingly, or use the differential lanes.) Accounting invariants
(kind buckets sum to count, p99 <= max <= total, phase sums equal
count, all four formatters) hold through deep-structure teardown storms
and GC forced at every one of the 16 region nesting depths. Region
intervals stay coherent across a stop()/start() gap. The v1.5.2
`_defineSnapshotKey` fix holds under builtin-shadowing phase names
(`toString`, `valueOf`, `hasOwnProperty`, `__proto__`, `constructor`)
including per-phase rules and all formatters; `String(summary.phases)`
throws only when a phase is literally named `toString`, which is
inherent to own keys on a plain-prototype object and does not affect
the library's own paths.

## 1.5.1

Adversarial hardening (G20). Zero new public API, zero behaviour change for
correct callers; three closed routes to a false `'pass'`, one observer-leak
fix, one overlap guard, one option unified across lanes.

### The gate now fails closed

An adversarial review of the gate surface found three independent routes to a
false `'pass'`. For a CI budget gate this is the worst possible failure mode:
the build stays green while the invariant it guards is already broken. All
three are closed, and all three are pinned by `test/torture/g20-5-adversarial`.

- **Unknown rule keys are now rejected** (`TypeError`) instead of silently
  matching nothing. `checkOps(r, { maxBytesPerOP: 20 })` -- a capitalisation
  slip -- previously returned `verdict: 'pass'` with `checked: {}` against a
  workload leaking ~590 B/op. The error names the offending key and suggests
  the intended rule. This applies to every gate entry point: `checkOps`,
  `checkFrames`, `checkOpsAsync`, `compareOps`, `compareFrames`,
  `compareOpsAsync`. A rule a lane does not implement is also rejected, so
  `compareFrames` no longer accepts plausible-looking rules it never reads.

- **Non-finite thresholds are now rejected** (`RangeError`). A `NaN` limit
  compared false against every metric, so the gate passed everything -- while
  reporting `checked: {rule: true}`, i.e. claiming to have enforced it. A
  non-numeric limit (`'20'`, `[20]`, `true`) was worse: it coerced through the
  comparison and then reached `limit.toFixed(3)` in the violation formatter,
  throwing an internal `TypeError` on exactly the runs where the gate should
  have reported a failure.

- **Non-finite metrics now yield `'inconclusive'`, never `'pass'`.** A run
  whose clock or heap source produced `NaN`/`Infinity` compared false the same
  way and gated green. `null` (not measured) already routed to inconclusive;
  non-finite now joins it.

### Resource and concurrency safety

- **A throwing workload no longer leaks the profiler's `PerformanceObserver`.**
  The ops-lane measurement was not wrapped in `try`/`finally`, so an aborted
  run never reached `gc.stop()`. Growth was linear -- measured at ~6 KB per
  aborted run, ~9.4 MB over 1600 -- and the orphaned observers kept attributing
  GC events, inflating later measurements in the same process. `stop()` is
  idempotent, so the happy path is unchanged.

- **Overlapping measurements are now rejected** rather than silently
  contaminated. Every lane measures one shared heap: a clean workload and a
  leaking one run under `Promise.all` reported 2224 and 2332 B/frame -- the
  clean run absorbed the leak and the two became indistinguishable, with no
  warning. Nested and concurrent runs throw/reject; the guard is released on
  settle, including after a throw, so an aborted run cannot wedge the process.

- **`opts.capacity` is validated consistently** across all three lanes. The
  same option previously had three behaviours: `measureOps` used
  `capacity || 256` (`0` and `NaN` silently became 256, `1.5` produced a
  fractional ring), the async lanes used `capacity | 0` (`NaN` and `Infinity`
  silently became a capacity of **zero**), and `-1` threw. All lanes now
  require a positive integer.

### Documented: sync `measureOps` cannot observe GC events

`PerformanceObserver` delivers on event-loop turns. A synchronous
`measureOps` loop never yields, so `result.summary.phases.steady.gc.major`
and `.minor` read zero even under heavy churn -- the events happened, but
the observer's callback queue never got a turn to fire before `stop()`.
This is why the ops lane exposes only `bytesPerOp` (memory-source, no
observer turn required) and no event-based rules -- the rules would be
unenforceable on their own primitive. The async lanes (`measureOpsAsync`,
`measureFrames`) do observe events correctly because every `await` yields
the event loop back to the observer's delivery queue.

The zeros in `summary.phases.steady.gc` on a sync ops run are honest --
"the observer saw nothing," not "the workload was clean" -- and the README
now spells this out where it wasn't before.

### Migration

Rule sets that were already correct are unaffected -- the existing 425-test
suite passed unchanged, then grew to 442 with the new torture. Callers relying
on unknown keys being ignored, or on a non-numeric threshold being tolerated,
will now get an immediate error naming the problem. That is the intended
outcome: those gates were not enforcing anything.

## 1.5.0

Batch 8: serialized async ops (G19). Five new public functions --
`measureOpsAsync`, `checkOpsAsync`, `assertOpsAsync`, `compareOpsAsync`,
`assertCompareOpsAsync` -- extend the ops-lane question ("what does one
call cost?") to async workloads: signal setters that batch to microtasks,
Preact-Signals reactions, Svelte 5 rune ticks, effects committed on a
scheduler. Additive; zero behavior change for existing v1.4.x callers.

### What's new

- `measureOpsAsync(fn, opts)` -- async, awaits `fn(i)` fully before
  advancing to `i+1`. No overlap under this primitive. Result includes
  `bytesPerOp`, `bytesPerOpStable`, `majorsPerKOp`, `minorsPerKOp`,
  `maxPauseMsPerOp`, `asyncResidual` (bytes heap grew past `settle()`),
  `elapsedMs`, `opsPerSec`. Schema: `'lite-gc-ops-async/1'`.

- `stabilize` defaults ON when `globalThis.gc` is available
  (node `--expose-gc`). Same argument as v1.4.0 frames: the primitive is
  already async, already calls `settle()`, and the marginal cost of two
  forced GCs at steady boundaries buys a compacted-live-set delta that's
  dramatically more trustworthy than a raw two-point delta. Attributed
  to a `'stabilize'` phase so steady-phase kind rules stay clean.
  `stabilize: true` without `--expose-gc` throws `RangeError` at setup.

- No new `VERDICT_MATRIX` rows. Same rule vocabulary as `measureOps`:
  `maxBytesPerOp`, `maxMajorsPerKOp`, `maxMinorsPerKOp`,
  `maxPauseMsPerOp`. Delta rules for compare: `maxExtraBytesPerOp`,
  `maxExtraMajorsPerKOp`, `maxExtraMinorsPerKOp`, `maxExtraPauseMsPerOp`.

- `asyncResidual` measured on raw heapUsed BEFORE any forced end-GC, so
  a stabilize collection cannot mask fire-and-forget work outliving the
  ops window. (Same lesson applied consistently across frames and ops-async.)

### What's out of scope

Interleaved-async attribution across ops (Fable's D12 -- op N's
spawned work colliding with op N+K's synchronous work) is deferred to
G20 workers in v1.6.0+. `asyncResidual` is the smoke detector until
then. If your workload is cooperative (fully awaits its own work before
returning), attribution is accurate today.

### Torture (G18.5)

New torture file: `test/torture/g18-5-ops-async.test.mjs`. Four-axis
discipline with the portability lessons from v1.4.0's M4 Pro corrections
baked in from the start:

- **Axis A**: adversarial (sync throw propagation, async rejection,
  `stabilize:true` without `--expose-gc` guard).
- **Axis B pin pair**: warmup allocation quarantined out of steady
  `bytesPerOp` (steady-start forced GC evicts warmup residue); a real
  steady leak reads many times the measured clean floor -- in a SINGLE
  stabilized run, no best-of-attempts. Both pins use `Array(1024).fill(i)`
  as the portable typed-slot payload and assert relative to the measured
  floor, not against absolute byte thresholds.
- **Axis C**: `measureOpsAsync` induces zero majors on a noop async
  workload over 1000 ops.
- **Axis D**: cold-run and warm-run produce identical verdicts on
  `maxBytesPerOp` for both clean AND leaky workloads; result shape
  stability across cold/warm.

### Full-suite tally

**404 tests, all pass** under `--expose-gc` in ~12 seconds. 371 baseline
(v1.4.0) + 24 standard async ops + 8 torture async ops + 1 verdict-matrix
verification.

## 1.4.0

Batch 7: the frame lane. Five new public functions -- `measureFrames`,
`checkFrames`, `assertFrames`, `compareFrames`, `assertCompareFrames` --
gate the render-loop question the ops lane couldn't answer: how does
this behave inside a scheduled frame budget? Additive; zero behavior
change for existing v1.3.x callers.

### What's new

- `measureFrames(fn, opts)` -- async, drives a scheduler through
  `warmup + frames` ticks, one call per tick. Result includes
  `bytesPerFrame` (retention slope), `majorsPerKFrame`,
  `minorsPerKFrame`, `maxPauseMsPerFrame`, `droppedFrames`, a
  `frameTimes` percentile distribution (`p50/p95/p99/max`), and
  `asyncResidual` -- bytes the heap grew past `gc.settle()`.
  Schema: `'lite-gc-frames/1'`.

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

### `bytesPerFrame` design: retention slope, not two-point delta

The ops lane's two-point heap delta doesn't survive a 300-frame window.
V8 runs minor GCs mid-window, dropping `heapUsed` sharply between
samples, and a two-point delta collapses under those drops.

The frame lane samples the heap periodically (~32 samples across
steady), detects drops (a sample less than 0.8x the previous marks a
GC), and fits an LSQ slope through the post-drop anchor points --
tracking retention accumulating across GC boundaries. Zero on
transient-only workloads; positive on real leaks.

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
- **Axis B pin pair**: `bytesPerFrame` invariant to warmup allocation
  intensity (LSQ slope isolates steady-phase growth from warmup
  residue); a leaky steady workload must show through the noise floor
  above 2500 B/frame.
- **Axis C**: `measureFrames` induces zero majors on a noop workload.
- **Axis D**: cold-run and warm-run produce the same verdict on
  `maxDroppedFrames`; result-shape stability across cold/warm.

Plus one wall-clock smoke test for the real polyfill scheduler --
proves the code path executes and terminates within a bound, without
opening the door to timing-dependent assertions elsewhere.

### Full-suite tally

**371 tests, all pass** under `--expose-gc` in ~7.7 seconds. 333
baseline + 29 standard frame + 9 torture frame.

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
