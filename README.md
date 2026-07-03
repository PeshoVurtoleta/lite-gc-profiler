# @zakkster/lite-gc-profiler

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-gc-profiler.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-gc-profiler)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-gc-profiler?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-gc-profiler)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-gc-profiler?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-gc-profiler)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-gc-profiler?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-gc-profiler)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE.txt)
[![tests](https://img.shields.io/badge/Tests-16_passing-3fb950)](#testing)
[![deps](https://img.shields.io/badge/dependencies-0-3fb950)](#install)
[![types](https://img.shields.io/badge/types-included-3178c6)](./index.d.ts)

A zero-dependency GC and heap profiler. Every other library in this ecosystem claims a
zero-GC hot path; this one is how you **prove** it. It counts garbage-collection events,
times the pauses, and fails a build when a full-heap collection happens where none should.

## The claim, made falsifiable

Run a pooled loop and a leaky loop through it and the difference is not subtle:

```
LEAKY  : count=26  minor=20  major=3  incremental=3  totalMs=537.4  maxMs=84.24   -> gate FAILS
POOLED : count=0   minor=0   major=0  incremental=0  totalMs=0.0    maxMs=0.00    -> gate PASSES
```

The pooled loop mutates one preallocated `Float64Array` in place and allocates nothing,
so V8 never collects. The leaky loop allocates a fresh array of objects per iteration and
pays for it in major collections and hundreds of milliseconds of pause. `test/02-gc-live`
asserts exactly this differential on every run.

## Sources

The profiler auto-detects what the runtime can tell it:

| Runtime | `source` | What it measures |
| --- | --- | --- |
| node | `'gc'` | **Precise.** `perf_hooks` `'gc'` events -- kind and pause duration, from V8 |
| Chrome | `'heap'` | **Heuristic.** `performance.memory` -- allocation rate, heap-drop collections |
| Firefox / Safari | `'none'` | No heap API; only the long-frame anomaly heuristic |

## Why `major` is the number that matters

Minor (Scavenge) collections of the young generation happen from ambient allocation even
in careful code. A **major** (Mark-Sweep-Compact) collection means the heap filled enough
to need a full pass -- the exact stall a 16 ms frame budget cannot absorb. So the default
gate is `{ maxMajor: 0 }`: any full-heap GC in the measured window is a failure.

## Install

```sh
npm i @zakkster/lite-gc-profiler
```

No dependencies. No peers.

## Node: precise GC

```js
import { GcProfiler, assertNoGc } from '@zakkster/lite-gc-profiler';

const gc = new GcProfiler().start();

runHotLoopForAWhile();

// GC entries are delivered asynchronously, so settle before reading.
await new Promise((r) => setTimeout(r, 50));

assertNoGc(gc.summary());   // throws GcBudgetError if any major GC happened
gc.stop();
```

`gc.summary().gc` carries `{ count, totalMs, maxMs, avgMs, p99Ms, minor, major, incremental, weakcb }`.

You can also feed node's own heap figure for allocation-rate tracking:

```js
gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
```

## Browser: heap + frames

In Chrome, `sampleHeap()` reads `performance.memory` for you. Call it once per frame,
and `markFrame(dt)` alongside it, to build allocation rate and flag long frames:

```js
const gc = new GcProfiler();
function frame(now) {
  const dt = now - last; last = now;
  // ... your render ...
  gc.sampleHeap(now);   // Chrome: auto-reads performance.memory
  gc.markFrame(dt);
  requestAnimationFrame(frame);
}
```

`summary().heap` carries `{ used, peak, allocBytes, allocRateBytesPerSec, gcDrops, freedBytes, ... }`;
`summary().frames` carries `{ count, long }`.

## Gate

```js
import { checkNoGc, assertNoGc } from '@zakkster/lite-gc-profiler';

const report = checkNoGc(gc.summary(), {
  maxMajor: 0,          // no full-heap collections (default)
  maxPauseMs: 4,        // no single pause over 4 ms
  maxAllocRate: 2 * 1024 * 1024   // <= 2 MB/s allocation (heap path)
});
// report -> { ok, violations: [{ metric, limit, actual, reason }], source }

assertNoGc(gc.summary());   // or throw on any violation
```

Rules: `maxMajor` (default 0), `maxMinor`, `maxPauseMs`, `maxTotalMs`, `maxAllocRate`.

## A note on cost

The GC observer receives node-allocated entry lists from the runtime, between frames.
The methods you call inside the frame -- `sampleHeap` and `markFrame` -- write into
preallocated fields and allocate nothing.

## Testing

```sh
npm test        # node --expose-gc --test
```

16 tests: deterministic event accounting and the gate, the live leaky-vs-pooled major-GC
differential, and the heap/frame heuristics driven by synthetic samples. The demo
(`demo/index.html`) shows the browser heap path live.

## License

MIT (c) Zahary Shinikchiev
