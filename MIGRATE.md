# v1.3.1 migration notes

Hardening patch; **no breaking changes.** Existing v1.3.0 code, baselines,
and CI configurations keep working byte-identically.

## What changed

One new option: `stabilize: boolean` on `MeasureOpsOptions`. Default
`false`; opt in per call. When true, forces a full GC at each
steady-phase boundary so `bytesPerOp` reflects surviving-allocation
delta (retention) rather than transient allocation. Applies to
`measureOps`, `assertOps`, `compareOps`, `assertCompareOps` via the
existing `opts` inheritance.

Also new: `summary.phases.stabilize` sub-summary block, present only
when `stabilize: true` was passed.

## No API changes for existing callers

If you don't pass `stabilize: true`, nothing changes. Same function
signatures, same result shapes, same event attribution, same
verdict/matrix behavior. Baselines captured under v1.3.0 stay valid
against v1.3.1 without regeneration.

## When to opt in

- Cold CI shards where `assertCompareOps` is the first workload to
  run in the process. See README "Cold CI" section.
- Any zero-allocation claim where you care about **retention** rather
  than transient churn ("my signal notification retains zero bytes"
  is a stronger claim than "my signal notification allocated zero
  transiently").

## When NOT to opt in

- Warmed workloads that already produce deterministic bytes/op.
- Browsers or sandboxed CI where `--expose-gc` isn't available;
  `stabilize:true` throws `RangeError` at measurement time in those
  environments.
- GC-event-count gating (`maxMajorsPerKOp`, `maxPauseMsPerOp`). The
  forced-GC events arrive asynchronously via `perf_hooks` and typically
  after `measureOps` returns; the `summary.phases.stabilize.gc.*`
  counters are unreliable and should not be gated on. Recommended:
  use `stabilize:true` for `maxBytesPerOp` gating, `stabilize:false`
  for event-count gating. Both are honest on their own axes.

## Required runtime flag

`stabilize:true` requires `node --expose-gc`. Without it, the option
throws `RangeError` at measurement time with actionable guidance --
the error names `--expose-gc` explicitly so CI configurers know the
exact fix. If your existing CI shard already runs with `--expose-gc`
(the recommended setup for anything using this profiler), no change
needed.

## No matrix growth

No new rules in `VERDICT_MATRIX`; no new source columns; no changes to
existing rule verifiability. `stabilize` is a mode on the measurement
harness, not a new gate axis. Existing baselines and gate configs
continue to apply.

## Copyright

Zahary Shinikchiev. MIT.
