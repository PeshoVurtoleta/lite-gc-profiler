# Changelog

All notable changes to `@zakkster/lite-gc-profiler` are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-07-02

Initial release. A zero-dependency GC and heap profiler.

### Added

- `GcProfiler(capacity, options)` with three auto-detected sources:
  - **node** -- precise GC events via `perf_hooks` `'gc'` PerformanceEntries (kind +
    pause duration).
  - **Chrome** -- `performance.memory` heap sampling (allocation rate, heap-drop
    collections).
  - **elsewhere** -- long-frame anomaly heuristic only.
- Per-kind tallies (minor / major / incremental / weakcb), pause `count`, `totalMs`,
  `maxMs`, `avgMs`, and a `p99Ms` over a preallocated window.
- `sampleHeap(now?, usedBytes?)` -- zero-allocation heap sampling; reads
  `performance.memory` in Chrome, accepts an explicit figure (e.g.
  `process.memoryUsage().heapUsed`) elsewhere.
- `markFrame(frameMs)` -- long-frame anomaly detection against a smoothed baseline.
- `record(kind, durationMs)` -- direct event injection for tests and custom sources.
- Budget gate: `checkNoGc` / `assertNoGc` / `GcBudgetError`, default `{ maxMajor: 0 }`,
  with `maxMinor`, `maxPauseMs`, `maxTotalMs`, and `maxAllocRate` rules.
- Kind constants `GC_MINOR`, `GC_MAJOR`, `GC_INCREMENTAL`, `GC_WEAKCB`.
- Full `index.d.ts` (typechecks under `nodenext` + `strict`). 16 tests under
  `node --expose-gc --test`, including a live leaky-vs-pooled major-GC differential.

### Notes

- The `'gc'` observer reads `entry.detail.kind` (the modern field) to avoid the
  deprecated `entry.kind` accessor.
- GC entries are delivered asynchronously; read `summary()` after a short settle when
  measuring a synchronous workload.
