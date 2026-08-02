// Gating Angular change detection for zero per-cycle retention.
//
//   node --expose-gc examples/angular.mjs
//
// The question this answers: does a change-detection cycle retain anything per
// tick? Angular runs detectChanges() constantly; a template binding that
// allocates per cycle multiplies straight into jank under zone.js.
//
// ZERO-DEP STAND-IN: this file ships no dependencies (suite law), so the
// component + `detectChanges` below are a ~12-line hand-rolled stand-in for
// Angular's change detector. In a real project you delete them and drive the
// real fixture under test:
//
//   import { TestBed } from '@angular/core/testing';
//   const fixture = TestBed.createComponent(RowComponent);
//   const tick = (i) => { fixture.componentInstance.i = i; fixture.detectChanges(); };
//
// ...then wrap `tick` in measureAllocs exactly as here. The COOKBOOK (Recipe 25)
// shows the real-Angular + Vitest form, including the signal-`effect` variant.

import { measureAllocs, checkAllocs } from '../Gc.js';

// --- hand-rolled Angular-shaped change detection (replace with TestBed) ------
// The component holds preallocated binding slots; detectChanges recomputes them
// in place -- the zero-retention shape a hot template should have.
class RowComponent {
    constructor() { this.i = 0; this.bindings = { text: '', flag: false }; }
    // The template's compiled update block: recompute bindings from inputs.
    detectChanges() {
        this.bindings.flag = (this.i & 1) === 0;
        this.bindings.text = 'row';          // constant, interned; no new string
    }
}
// -----------------------------------------------------------------------------

const component = new RowComponent();

// The hot path under gate: set an input and run one CD cycle -- the thing that
// fires on every zone turn / signal change.
const tick = (i) => { component.i = i; component.detectChanges(); };

const report = measureAllocs(tick, { iterations: 5_000, batches: 8 });
const gate = checkAllocs(report, { maxBytesPerCall: 0 });

// eslint-disable-next-line no-console
console.log('Angular change detection -- verdict:', gate.verdict,
    '| bytesPerCall floor:', report.bytesPerCall);
if (gate.verdict !== 'pass') {
    // eslint-disable-next-line no-console
    console.error('reason:', gate.violations || gate.reason);
    process.exit(1);
}
