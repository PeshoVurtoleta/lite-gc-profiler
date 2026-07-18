# @zakkster/lite-gc-profiler — Torture Test Plan

**Status:** 187 torture scenarios shipped across v1.1.0 through v1.5.2
(G3.5, G5.5, G10.5, G13.5, G14.5, G14.6, G17.5, G18.5, G20.5, G99.9,
G99.10). All axes represented. Plus 3 CLI integration scenarios
(`test/18-partial-report.test.mjs`) that live alongside the torture
suites for the G16.5 partial-report path.

Axes A-D are the original four (below). G20.5 added E-I for resource and
concurrency safety; G99.9 added J-S for hostile inputs, capacity cliffs,
baseline integrity and lifecycle; G99.10 added T-X for observation-window
integrity, the capacity ceiling, the retention floor, and deep teardown.
The letters are cumulative across the suite, not per-file.

Companion to `ROADMAP.md`. The G-numbers here slot into the roadmap's
batches -- the code lands in the same session as the subsystem it
tortures, so review happens once.

Directory layout on ship: `test/torture/` holds one file per G-slot plus
`harness.mjs`. The harness itself passes `maxMajor: 0` on its own
allocation pattern (verified in G3.5 axis-B perturbation bound test) --
the torturer does not allocate majors.

---

## Pass criteria (apply to every G-slot)

Four axes, in decreasing severity of what a bug here would mean:

**Axis A -- Adversarial inputs that MUST produce `inconclusive`.** Never
`pass`, never `fail`. A green verdict here is the worst possible bug in
this package: silent falsification of the falsifiability claim. Ranks
above every other correctness concern.

**Axis B -- Real signal buried in noise that MUST produce `fail`.** The
gate cannot be drowned by volume, drowned by clean adjacent windows, or
drowned by rep count.

**Axis C -- Clean signal under hostile conditions that MUST produce
`pass`.** The gate cannot be flake-prone against the machine.

**Axis D -- Self-consistency invariants across the API surface.**
`checkNoGc`, `compareGc`, `aggregateGc`, `checkAgainstBaseline` must
agree on any input where their scopes overlap.

Every G-slot below lists which axes it exercises and the scenario count
per axis.

---

## SHIPPED

### G3.5 -- Torture for Batch 1 (verdict integrity)

`test/torture/g3-5-verdicts.test.mjs` -- **18 scenarios**.

**Axis A (8)** inconclusive on adversarial input. Includes v1.0.0
silent hole (source: 'none' + maxMajor:0), kind rules on heap,
maxAllocRate without samples, phase rules referencing never-declared
phases, undeclared-phase-must-not-fabricate-fail trap, settle timeout
signals inconclusive posture.

**Axis B (4)** fail on real signal. Single major in otherwise clean
window, fail-beats-inconclusive precedence, steady-phase-not-shadowed,
multi-rule aggregation.

**Axis C (3)** pass under hostile conditions. Start/stop no phantom
majors, sibling PerformanceObserver no perturb, back-to-back settle.

**Axis D (2)** consistency invariants. `assertNoGc` throws iff verdict
!== 'pass' respecting `allowInconclusive`; verdict is pure function of
(summary, rules).

**Perturbation bound (1)** harness itself induces zero majors over 1000
iterations.

### G5.5 -- Torture for Batch 2 (differential + reps + baseline)

`test/torture/g5-5-reps.test.mjs` -- **17 scenarios**.

**Axis A (5)** source mismatch in compareGc, mixed sources in gateReps,
maxExtraAllocRate-needs-samples-both-sides, fingerprint mismatch.

**Axis B (5) -- #1 is the D4 policy pin**: single dirty rep among nine
clean under all-clean majors MUST fail. Also: best-clean pauses with
best rep dirty, harness-noise vs real-signal delta, baseline regression
current.median > baseline.max, fail-beats-inconclusive at rep scope.

**Axis C (4)** 2x pause variance passes, interleaving preserved across
gaps, same-machine baseline round-trip, rep policy override per-rule.

**Axis D (3)** `compareGc(pooled, x) == checkNoGc(x)` when control is
empty, aggregate verdict matches per-rep reasoning, baseline JSON
round-trip preserves verdict.

### G10.5 -- Torture for Batch 4 (attribution)

`test/torture/g10-5-attribution.test.mjs` -- **13 scenarios**.

**Axis A (4)** perRegion rule for never-entered region, kind rules on
'heap' at region scope, perRegion maxAllocRate always inconclusive in
Batch 4, undeclared-region rule must not fabricate fail.

**Axis B (4) -- #1 is the honesty enforcement**: GC during region B
charges B, not the allocator region A. This test makes the README
disclaimer true. Also: nested regions charge innermost, region+global
surface, fail-beats-inconclusive at region scope.

**Axis C (3)** high-frequency region churn no majors, long region names
work, explain sampling doesn't affect ordinary code paths.

**Axis D (2)** sum of per-region + unattributed = global; explain and
GcProfiler coexist without corruption.

### G13.5 -- Torture for Batch 5 (browser second source)

`test/torture/g13-5-browser.test.mjs` -- **11 scenarios**.

**Axis A (3)** source='uasm' + maxMajor:0 inconclusive (no event kinds
on uasm), source='uasm' + maxAllocRate with <2 samples inconclusive,
source='none' + maxAllocRate inconclusive (regression protection for
the silent-hole class as source enum grew).

**Axis B (3)** uasm growthRate over limit fails, **#2 is the D4 policy
pin on the uasm channel**: nine clean + one leaky uasm rep under
all-clean majors MUST fail, compareGc uasm-vs-uasm large delta fails
with delta metric naming the uasm channel not heap.

**Axis C (3)** clean uasm workload passes, **heap-source verdicts
unchanged after adding uasm column** (additive-changes-stay-additive
regression pin), uasm rep gate on clean reps passes.

**Axis D (2)** VERDICT_MATRIX exposes every source column for every
rule (missing columns silently degrade verdicts), baseline captured
from uasm reps round-trips through JSON preserving the uasm block.

**Not included** (moved to sibling `lite-scope-gc-probe` per D5): SPP
probe stream shape matches summary shape.

### G14.5 -- Torture for Batch 6 (per-op primitives)

`test/torture/g14-5-ops.test.mjs` -- **10 scenarios**.

**Axis A (3)** source='none' + maxBytesPerOp inconclusive (no memory
channel -- per-op analogue of the v1.0.0 silent hole); synthetic
source='heap' + maxMajorsPerKOp inconclusive (kind-per-op rules on heap);
compareOps source mismatch inconclusive.

**Axis B (3)** 10x bytes/op candidate vs clean control fails compareOps;
**complementary pin pair**: leaky steady must fail even when warmup is
clean (steady leak not shielded by phase boundary), and the mirror --
heavy warmup + clean steady MUST pass on strict steady rule. Together
these prove the phase() boundary in measureOps really quarantines
warmup allocations. If either half of the pair ever inverts, warmup and
steady have quietly merged in the gate math.

**Axis C (2)** identical noop workloads compare with delta 0 -> pass
(measureOps hot path has no allocation leak that would show as a delta);
**measureOps itself induces no majors on a noop workload** (per-op
harness perturbation bound -- if this fails, measureOps' own
closures/summary calls are allocating, contaminating every per-op
measurement).

**Axis D (2)** result shape stable across sources with bytesPerOp null
exactly when source='none' (not 0, which would silently claim zero
allocation on a memory-unaware runtime); compareOps verdict reasoning
matches per-metric manual computation on synthetic control/candidate
pairs with known deltas.

### G16.5 -- Partial-report integration (not axis-classified)

`test/18-partial-report.test.mjs` -- **3 scenarios**. Not axis-classified
because these test CLI + Register + child-process integration, not the
gate's truth-telling per se.

- Target calls `process.exit(0)` mid-work -> CLI emits exit code 2
  (inconclusive) with `reason: 'partial_report'`, NOT exit code 3
  (infrastructure error).
- Target calls `process.exit(1)` -> same downgrade; exit code 2 with
  the non-zero exit surfaced under `partial[0].exitCode`.
- Clean target (no `process.exit`) -> beforeExit writes complete report;
  the exit handler is a no-op. Regression protection for the
  additive-changes-stay-additive pin.

### G14.6 -- Torture for stabilize mode (v1.3.1)

`test/torture/g14-6-stabilize.test.mjs` -- **8 scenarios**. Retention vs
transient separation under `opts.stabilize`, and the `--expose-gc`
precondition failing loudly rather than silently degrading.

### G17.5 -- Torture for Batch 7 (per-frame primitives, v1.4.0)

`test/torture/g17-5-frames.test.mjs` -- **10 scenarios**. Scheduler
hostility (never-firing, double-firing, synchronous, throwing), dropped
frame accounting, and `maxDroppedFrames` as the first source-agnostic
rule in the matrix.

### G18.5 -- Torture for Batch 8 (serialized async ops, v1.5.0)

`test/torture/g18-5-ops-async.test.mjs` -- **8 scenarios**. Serialization
of async ops, `asyncResidual` as a post-settle growth detector, and
rejection paths releasing every resource they acquired.

### G20.5 -- Adversarial (v1.5.1)

`test/torture/g20-5-adversarial.test.mjs` -- **34 scenarios**. Every one
started as a successful attack. Introduced axes E-I:

**Axis E (5)** overlapping-measurement guard: concurrent and nested runs
rejected, guard released after throws and rejections, sequential runs
unaffected.

**Axis F (2)** capacity validated identically across all three lanes.

**Axis G (3)** transient garbage storms not misread as retention;
retained vs transient separable under storm conditions.

**Axis H (4)** scheduler hostility in the frames lane.

**Axis I (4)** minimum viable runs, warmup larger than the steady
window, mutated result objects rejected, very large op counts.

Axes A-D in this file cover the three closed routes to a false `'pass'`
(unknown rule key, NaN threshold, NaN metric) and the observer leak.

### G99.9 -- Extreme (v1.5.2)

`test/torture/g99-9-extreme.test.mjs` -- **41 scenarios**. Attack-first:
five defects found, four fail-open, all now pinned here. Introduced axes
J-S:

**Axis J (3)** hostile identifiers. A phase or region named `__proto__`
set the snapshot's prototype instead of creating a key -- its GC counts
were live but unreachable through `Object.keys`/`JSON.stringify`, so a
phase budget on it could never fire. Also pins `constructor`,
`toString`, empty/whitespace names, a 10k-character name, NUL/RTL/emoji,
and a user phase colliding with the reserved `unattributed` bucket.

**Axis K (4)** poisoned samples. One non-finite `sampleHeap()` reading
used to poison `_heapPrev` and zero `allocBytes` for the rest of the
window. Also backwards and frozen clocks.

**Axis L (5)** capacity cliffs. State integrity **at and after** all five
hard limits (32 phases, 1024 boundaries, 32 regions, 16 nesting, 2048
intervals), plus fractional capacities rounding into the ring.

**Axis M (2)** garbage zoo. 20+ allocation species -- string ropes,
typed arrays, DataViews, Map/Set/WeakMap, Symbols, RegExps, BigInts,
Errors, Proxies, generators, FinalizationRegistry -- with the invariant
that kind buckets sum to `gc.count`, and that every formatter plus a
JSON round trip survives the storm with an identical verdict.

**Axis N (3)** evil objects. A rules threshold implemented as a getter
returning a valid number to the guard and `Infinity` to the comparison;
frozen rules/opts; a thenable that throws on `then`.

**Axis O (7)** volume and durability. 10k reps through
`aggregateGc`/`gateReps`, a capacity-1 ring under 3000 forced
collections, dual concurrent observers agreeing on one event stream,
`stop()` as a hard cutoff, `settle()` timing out rather than
livelocking under a sustained storm, and the transient-vs-retained pair
in the ops lane.

**Axis P (7)** baseline integrity. Every route to a baseline that
verifies nothing yet reported `'pass'`: empty metric maps, missing
groups, an empty current aggregate, and non-finite `max` values (`NaN`
in memory, `null` once saved, strings when hand-edited). Includes the
counter-pins: partial poisoning still gates on surviving metrics, and a
real regression is still caught.

**Axis Q (2)** prototype-pollution inputs. `__proto__` payloads in rules
and summary objects must not mutate `Object.prototype` or fabricate a
verdict.

**Axis R (4)** lifecycle. `reset()` mid-region, restart without
double-counting, `summary()` idempotence, and the overlap error naming
the abandoned-run cause.

**Axis S (4)** cross-lane agreement on mismatched and degenerate inputs.

### G99.10 -- Deep (v1.5.2)

`test/torture/g99-10-deep.test.mjs` -- **17 scenarios**. Second
attack-first pass over the v1.5.2 hardening. Two defects found and
fixed; the rest of the file pins behaviour that held under attack.
Introduced axes T-X:

**Axis T (5)** observation-window integrity. Sync GC-heavy code queues
its 'gc' entries and node delivers the backlog to observers registered
later in the same turn; a profiler therefore inherited GC history it
never observed. Pins: a profiler started after six forced majors sees at
most one (spontaneous) event over an alloc-free window, never the
backlog; phase sums equal `gc.count` even with sync `measureOps` runs
earlier in the tick; `reset()` cannot be repopulated by pre-reset
entries; restart admits nothing from the stopped gap; the synthetic
`record()` API stays exempt from the floor. Assertions tolerate one
spontaneous V8-scheduled event inside the observed window -- the pinned
signature is the multi-major backlog, and V8 may legitimately run a step
of its own with a post-start timestamp.

**Axis U (3)** capacity ceiling. `new GcProfiler(2**30 + 1)` (and every
lane's `opts.capacity`) was an infinite-loop DoS via a 32-bit shift wrap
in `pow2`; below the wrap, large capacities were a resource bomb (1 GB
at 2**26, a 16 GB crash at 2**30). Pins: everything past
MAX_RING_CAPACITY throws `RangeError`, the boundary value itself is
usable, and -- because the defect was a hang -- the probes run in child
processes with a 5s timeout so a regression fails a test rather than
hanging CI.

**Axis V (2)** retention floor, two-sided. One `{a:i}` retained per op
(~40 B/op, V8 minimum object footprint) must fail a 16 B/op budget; a
genuinely zero-alloc op at 500k ops must read well under the same budget
and pass. The second pin documents measurement sizing: at 50k fast ops,
V8 self-noise amortizes to several bytes/op, which is not a defect --
size the run or use the differential lanes.

**Axis W (3)** deep teardown. Million-node linked list, 10k-deep closure
chain, 5k-deep prototype chain, 1k-deep nested Maps and 100k-deep nested
arrays built and dropped under five phases: kind buckets sum to count,
p99 <= max <= total, phase sums equal count, every formatter survives.
GC forced at all 16 region nesting depths: every depth sees its event.
A region interval spanning a stop()/start() gap exits cleanly and keeps
its pre-gap counts.

### Global torture invariants (applied via harness)

**Axis X (4)** the synthetic `record()` surface. It is the one entry
point where a caller hands the profiler a number the profiler did not
measure, and it accepted anything: `+durationMs || 0` turned NaN into a
silent 0 and let negatives and Infinity into the running totals. A
single negative duration produced maxMs > totalMs and a negative avgMs;
Infinity poisoned totalMs/avgMs to non-finite for every later read.
Finite, non-negative durations and finite startTimes are now enforced.

The harness under `test/torture/harness.mjs` provides
`assertAxisA/B/C/D` primitives so each G-slot file reads as a flat list
of scenarios and the axis intent stays visible at the call site. Axis A
labels a green verdict as "the worst possible bug" so future regressions
get triaged appropriately. `makeSummary` (v1.2.0) includes `uasm` and
`byRegion` blocks by default; hand-built summaries lacking newer blocks
are tolerated by `_extract` returning 0 for absent branches.

---

## Insertion order into roadmap

| Batch | Version | Roadmap G-slots | Torture slot | Scenarios |
| --- | --- | --- | --- | --- |
| 1 | v1.1.0 (shipped) | G1, G2, G3 | **G3.5** | 18 |
| 2 | v1.1.0 (shipped) | G4, G5, G6 | **G5.5** | 17 |
| 3 | v1.1.0 (shipped) | G7, G8, G9 | (packaging, no slot) | 0 |
| 4 | v1.1.0 (shipped) | G10, G11 | **G10.5** | 13 |
| 5 | v1.2.0 (shipped) | G12 (G13 in sibling) | **G13.5** | 11 |
| 6 | v1.3.0 (shipped) | G14, G15, G16, G16.5 | **G14.5** | 10 |
| 6b | v1.3.1 (shipped) | stabilize mode | **G14.6** | 8 |
| 7 | v1.4.0 (shipped) | G17, G18 | **G17.5** | 10 |
| 8 | v1.5.0 (shipped) | G19 | **G18.5** | 8 |
| 8b | v1.5.1 (shipped) | G20 | **G20.5** | 34 |
| 9 | v1.5.2 (shipped) | G99.9 | **G99.9** | 41 |
| 10 | v1.5.2 (shipped) | G99.10 | **G99.10** | 17 |

**Total shipped: 187 torture scenarios + 3 global invariants + 3 CLI
integration scenarios (G16.5).** Full suite: 517 tests.

---

## Not in scope

- **Fuzzing type-invalid rule inputs.** `{maxMajor: -1.5, maxPauseMs:
  "cat"}` is `Gc.d.ts`'s job.
- **Cross-runtime property tests.** Interesting but expensive; if the
  gate ever gets a `runtime-agnostic` mode that promises identical
  verdicts across node/Chrome/Firefox, revisit.
- **Chaos engineering against V8's GC scheduler.** Requires flags the
  users don't run under; would test V8, not the profiler.
- **Real browser calibration.** Heuristic false-positive/false-negative
  rates for `performance.memory` heap-drop detection belong in
  `demo/calibration.html` where numbers can be measured on real hardware.
  CI cannot exercise the real API.

---

## Four scenarios that guard the ecosystem

Preserve these religiously across all future refactors:

**G5.5 axis-B #1 -- The D4 policy pin (heap channel).** Nine clean reps,
one with a single major. Under D4-default `all-clean` for majors, the
gate MUST fail. If this ever passes, the default has silently become
`best-clean` or `median`, and every user "zero major" claim across the
ecosystem gets weaker.

**G10.5 axis-B #1 -- The honesty pin.** GC fires during region B, but was
caused by allocation in region A. Rule against B MUST fail; rule against
A MUST pass. If this ever passes with A failing instead, someone silently
changed attribution from firing-site to allocator, contradicting the
README disclaimer.

**G13.5 axis-B #2 -- The D4 policy pin (uasm channel).** Nine clean uasm
reps, one leaky. Under D4-default `all-clean`, the gate MUST fail. Same
logic as G5.5 but for the browser channel added in v1.2.0. If this
silently passes, the D4 discipline has been broken for uasm and every
uasm-based zero-alloc claim weakens.

**G14.5 axis-B pin pair -- The phase quarantine.** Two coupled scenarios
that together prove `measureOps`'s `phase()` boundary between warmup and
steady actually works:

- Clean warmup + leaky steady MUST fail on a strict `maxBytesPerOp`.
- Leaky warmup + clean steady MUST pass on the same rule.

If either half of the pair inverts, warmup and steady have quietly merged
in the per-op gate math. That would let anyone game a per-op gate by
front-loading allocation in warmup and reporting clean steady numbers --
undoing the entire falsifiability claim at the hot-path scale.

All four live in files that the ecosystem rollout script sanity-checks
before publishing each `@zakkster/lite-*` update.

