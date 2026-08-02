# Framework integration examples

Runnable, zero-dependency examples of gating a reactive hot path in the three
big frameworks. Each prints a `pass` verdict and exits 0:

```bash
node --expose-gc examples/vue.mjs
node --expose-gc examples/react.mjs
node --expose-gc examples/angular.mjs
```

| File | Gates | Real-framework recipe |
| --- | --- | --- |
| [`vue.mjs`](vue.mjs) | a Vue reactivity **effect** re-run | COOKBOOK Recipe 23 |
| [`react.mjs`](react.mjs) | a React component **render** | COOKBOOK Recipe 24 |
| [`angular.mjs`](angular.mjs) | an Angular **change-detection** cycle | COOKBOOK Recipe 25 |

## Why hand-rolled stand-ins

`@zakkster/lite-gc-profiler` ships **zero runtime dependencies** by law, so these
examples cannot `import` Vue, React, or Angular. Each file instead contains a
~12-line hand-rolled stand-in for that framework's reactive primitive
(`ref`/`effect`, a render + `useState`, a `detectChanges` cycle), clearly
marked, with the one-line swap to the real import shown in a comment at the top.

The stand-in is not a toy: it isolates **your** reactive code -- the effect body,
the render body, the template update block -- which is the part you control and
the part worth gating. Swapping in the real framework changes what *drives* the
tick, not what `measureAllocs` measures.

## The pattern, in one line

All three examples are the same shape:

```js
const tick = (i) => { /* trigger one reactive update */ };
const report = measureAllocs(tick, { iterations: 5_000, batches: 8 });
const gate = checkAllocs(report, { maxBytesPerCall: 0 });   // 0 = retains nothing
```

`measureAllocs` requires `--expose-gc` (it forces a collection at each batch
boundary to measure *retained* bytes). Your test runner already passes it:
`node --expose-gc --test ...`, and Vitest via `poolOptions`. See the COOKBOOK
recipes for the real-framework + test-runner wiring.

These files are examples only -- they are not part of the published package and
are not run by the test suite.
