# v1.4.0 migration notes

Batch 7: the frame lane. **Additive only** -- no breaking changes to
existing v1.3.x callers. Existing baselines, CI configurations, and
gate rules keep working byte-identically.

## What's new

Five new public functions: `measureFrames`, `checkFrames`,
`assertFrames`, `compareFrames`, `assertCompareFrames`. All the
`measure*` and convenience forms are `async` -- frames are inherently
async, driven by a scheduler. `checkFrames` is sync (gate a result
you already have).

Five new `VERDICT_MATRIX` rules: `maxBytesPerFrame`,
`maxMajorsPerKFrame`, `maxMinorsPerKFrame`, `maxPauseMsPerFrame`,
`maxDroppedFrames`. The last one is the first source-agnostic rule
in the matrix -- it gates on `source='none'`, which no rule did
before v1.4.0. If your code walks `VERDICT_MATRIX` and asserts every
rule is `'no'` on `'none'`, you'll need to add
`maxDroppedFrames` to a source-agnostic set:

```js
const SOURCE_AGNOSTIC_RULES = new Set(['maxDroppedFrames']);
for (const rule in VERDICT_MATRIX) {
    if (SOURCE_AGNOSTIC_RULES.has(rule)) {
        // 'yes' on every source
    } else {
        // 'no' on 'none'
    }
}
```

## When to reach for `measureFrames`

Use it whenever the question is "how does this behave inside a
render loop?" -- specifically:

- You want to gate `bytesPerFrame` retention slope over a sustained
  render window, not `bytesPerOp` on a hot-path call.
- You care about frame drops (work-time exceeding a budget), not
  per-op wall clock.
- You're comparing two implementations under sustained load, not
  isolated micro-benchmarks.

Use `measureOps` for the hot-path question ("what does one call
cost?"). The two lanes measure different things and their gates
compose freely.

## Attribution: cooperative vs fire-and-forget

For a frame function that fully awaits its own work, attribution is
accurate. For frame functions that spawn fire-and-forget promises
or timers, V8's async-context propagation can attribute allocations
to whichever phase is current when the perf_hooks GC callback
delivers -- not the frame that spawned the work. In practice this
matters when the workload interleaves async continuations across
frames.

The result includes `asyncResidual` -- bytes the heap grew *after*
`gc.settle()` returned. Non-zero means work outlived the measurement
window. Use it as a smoke signal: log it, or assert against it
directly.

Full interleaved-async attribution is a v1.5.0 concurrency-lane
concern.

## Scheduler selection

Default is `'auto'` -- uses `requestAnimationFrame` if the runtime
has one, otherwise a self-correcting `setTimeout` polyfill. Explicit
choices:

- `scheduler: 'raf'` throws `RangeError` at setup if raf is
  unavailable. No silent fallback: explicit intent is honored.
- `scheduler: 'polyfill'` forces the setTimeout pacer.
- `scheduler: (cb) => setTimeout(cb, 0)` -- the escape hatch for
  deterministic tests. 300 frames in ~150ms wall-clock instead of ~5s.

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
