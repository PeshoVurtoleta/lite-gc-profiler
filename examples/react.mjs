// Gating a React render for zero per-render retention.
//
//   node --expose-gc examples/react.mjs
//
// The question this answers: does re-rendering a component with new state
// retain anything per render? A render that allocates fresh objects it does not
// need makes reconciliation churn the heap on every keystroke.
//
// ZERO-DEP STAND-IN: this file ships no dependencies (suite law), so the
// `render`/`useState` below are a ~15-line hand-rolled stand-in for React's
// render + hook cycle. In a real project you delete them and drive the real
// component under test:
//
//   import { createElement } from 'react';
//   import TestRenderer from 'react-test-renderer';
//   const tick = (i) => TestRenderer.act(() => root.update(createElement(Row, { i })));
//
// ...then wrap `tick` in measureAllocs exactly as here. The COOKBOOK (Recipe 24)
// shows the real-React + Vitest form, including the `--expose-gc` note.

import { measureAllocs, checkAllocs } from '../Gc.js';

// --- hand-rolled React-shaped render (replace with react-test-renderer) ------
// A single preallocated vnode the component reuses -- the zero-retention shape.
// (React itself allocates elements; this stand-in isolates YOUR render body,
// which is the part your code controls and the part worth gating.)
const vnode = { type: 'div', props: { children: null } };
let hookState = 0;
function useState(initial) {
    if (hookState === 0) hookState = initial;
    return [hookState, (v) => { hookState = v; }];
}
function render(Component, props) { return Component(props); }
// -----------------------------------------------------------------------------

function Row(props) {
    const [, setSelected] = useState(0);
    setSelected(props.i & 1);          // state update, as on a real interaction
    vnode.props.children = props.i;    // write into the reused vnode, no new object
    return vnode;
}

// The hot path under gate: one render pass with fresh props -- the thing that
// fires on every parent update / state change.
const tick = (i) => { render(Row, { i }); };

const report = measureAllocs(tick, { iterations: 5_000, batches: 8 });
const gate = checkAllocs(report, { maxBytesPerCall: 0 });

// eslint-disable-next-line no-console
console.log('React render -- verdict:', gate.verdict,
    '| bytesPerCall floor:', report.bytesPerCall);
if (gate.verdict !== 'pass') {
    // eslint-disable-next-line no-console
    console.error('reason:', gate.violations || gate.reason);
    process.exit(1);
}
