// Gating a Vue reactivity effect for zero per-tick retention.
//
//   node --expose-gc examples/vue.mjs
//
// The question this answers: when a reactive dependency changes and Vue re-runs
// an effect, does that re-run retain anything? A reactive node that quietly
// allocates per tick turns a 60fps component into a GC generator.
//
// ZERO-DEP STAND-IN: this file ships no dependencies (suite law), so `ref` and
// `effect` below are a ~12-line hand-rolled stand-in for Vue's reactivity. In a
// real project you delete them and import the real thing:
//
//   import { ref, effect } from 'vue';          // or '@vue/reactivity'
//
// ...then wrap the same effect trigger in measureAllocs exactly as here. The
// COOKBOOK (Recipe 23) shows the real-Vue + Vitest form.

import { measureAllocs, checkAllocs } from '../Gc.js';

// --- hand-rolled Vue-shaped reactivity (replace with `import ... from 'vue'`) -
let ACTIVE = null;
function ref(initial) {
    let value = initial;
    const subs = new Set();
    return {
        get value() { if (ACTIVE) subs.add(ACTIVE); return value; },
        set value(v) { value = v; for (const run of subs) run(); }
    };
}
function effect(fn) { const run = () => { ACTIVE = run; try { fn(); } finally { ACTIVE = null; } }; run(); return run; }
// -----------------------------------------------------------------------------

// A component's derived state: a preallocated output slot the effect writes
// into. No allocation per tick -- this is the pooled, zero-retention shape.
const count = ref(0);
const view = { label: '', total: 0 };          // reused across every effect run

effect(() => {
    // Reads count.value (registers the dependency), recomputes into `view`.
    view.total = count.value * 2;
    view.label = 'items';                       // constant, interned; no new string
});

// The hot path under gate: mutate the reactive source, which re-runs the effect.
// This is one "reactive tick" -- the thing that fires on every state change.
const tick = (i) => { count.value = i; };

const report = measureAllocs(tick, { iterations: 5_000, batches: 8 });
const gate = checkAllocs(report, { maxBytesPerCall: 0 });

// eslint-disable-next-line no-console
console.log('Vue reactive tick -- verdict:', gate.verdict,
    '| bytesPerCall floor:', report.bytesPerCall);
if (gate.verdict !== 'pass') {
    // eslint-disable-next-line no-console
    console.error('reason:', gate.violations || gate.reason);
    process.exit(1);
}
