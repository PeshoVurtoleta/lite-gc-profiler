# GCForge

The viewer for this library's reports. Drop a `gc.json` on it and read your run.

One static page. No build step, no runtime dependency the library takes on, no
server, no accounts, no telemetry. It never runs a profiler, never needs
`--expose-gc`, and never asks for your code — it reads an artifact the library
already emits.

Everything stays in the browser. Reports carry workload names, and none of them
leave the tab.

```
npx serve viewer
```

`viewer/` is excluded from `files[]`, like `demo/` — it is never in the tarball.
Publish the folder to Pages unchanged.

Two libraries arrive through an import map:

```json
{
  "@zakkster/lite-signal":  "https://esm.sh/@zakkster/lite-signal@1.4.0",
  "@zakkster/lite-virtual": "https://esm.sh/@zakkster/lite-virtual@1.1.0"
}
```

The import is dynamic and never awaited on the render path, so a blocked CDN,
an offline laptop, or `file://` costs nothing: the page renders immediately with
bounded tables and says why they are bounded. If the modules land afterwards the
view upgrades itself.

## The two laws

Each enforced at exactly one point, so neither can drift:

1. **Inconclusive never looks like pass.** Its own colour *and* its own hatch
   texture, so it survives desaturation, greyscale printing, and colour vision
   deficiency. An inconclusive run with an empty violations table says so in
   words rather than showing a clean table.

2. **Null never looks like zero.** Every numeric passes through
   `classifyMetric`; there is deliberately no path that renders a bare number.
   Absent or non-finite renders as *not measured*, hatched and italic. A delta
   against an unmeasured value is *not comparable*, because it is unknowable
   rather than zero.

A third rule earns its place beside them: **a malformed field is never rendered
as an absent one.** `violations` arriving as an object used to produce "None
recorded." under a FAIL verdict — a clean-looking table that was really a read
failure. `checked` arriving as an array produced rules literally named `0` and
`1`. Both are now named in a panel above the verdict, because silently absorbing
a shape error is the same lie as a null shown as zero.

## What it reads

| Schema | What it is |
| --- | --- |
| `lite-gc-report/1` | the `formatJson` envelope, and every gate report inside it |
| `lite-gc/1` | a written profiler summary |
| `lite-gc-partial/1` | a partial capture, when the target called `process.exit()` |
| `lite-gc-baseline/1` | a baseline lock, and a `ratchetBaseline` result |
| `lite-gc-ops/1`, `lite-gc-frames/1`, `lite-gc-ops-async/1` | measurements |
| `lite-gc-ops-multi/1`, `lite-gc-frames-multi/1` | multi-context aggregates |
| `lite-gc-allocs/1` | a `measureAllocs` result, with G27 allocation sites |

Every `kind` the library emits is labelled, including `checkAllocs`. Anything
else is refused by name — the viewer says what it found rather than guessing a
renderer, matching the library's own fail-closed manners.

## Panels

- **Overview** — verdict, malformed-shape complaints, the gate's own `reasons`,
  violations, the `checked` map including per-phase and per-region scopes,
  multi-context aggregate with per-context breakdown, per-call allocation with
  its per-batch bytes, ratchet outcome, GC and heap totals.
- **Attribution** — per-phase and per-region GC attribution segmented by
  collection kind, with the `unattributed` bucket called out.
- **Frames** — frame-time percentiles against the 16.7 ms budget, retention,
  the `bytesPerFrameStable` provenance badge, `asyncResidual`.
- **Compare** — drop a report on each side; deltas labelled with the `maxExtra*`
  rule the differential gate would use.
- **Raw** — the source document.

### Allocation sites, and why they look different

G27 sites are the only named, per-line data the library emits, and they are the
one thing here that **must not** read as a measurement. The library's rule is
that attribution never gates: sampling is probabilistic, `bytesPerCall` comes
from the heap-delta estimator alone, and a workload the sampler saw allocate
megabytes still passes `maxBytesPerCall: 0` if it retains nothing.

So the block is set apart — dashed rule, hatched ground, an `advisory` chip, and
percentages held to one decimal because three would assert a precision the
sampler does not have. When the sampler did not run, the panel says that is not
evidence nothing allocated, and names the reason.

## Sharing

**Copy shareable link** deflates the report into the URL fragment. Fragments are
never sent to a server, so the no-upload promise holds while a report becomes
linkable in a PR comment. Past ~60 KB encoded it falls back to copying the JSON
and says why.

## Large reports

A 734 KB gate with 5,000 violations took **5.1 s** of layout before any of this;
the tab was locked. It now renders **every row in 125 ms with ~204 DOM nodes**.

- `@zakkster/lite-virtual` windows tables past 300 rows — a measured,
  slot-recycled list, so a wrapped `reason` still lays out correctly and row
  5,000 is reachable.
- `table-layout: fixed` with explicit column widths. Auto layout measures every
  cell to size columns; at 25,000 cells that pass *is* the cost. 2.8x on its own.
- Raw shows a head and tail past ~44 KB. Copy JSON is unaffected.

Both renderers run one `spec.write(i, cells)`, so law 2 cannot hold in the table
and lapse in the grid. Without windowing, tables bound at `ROW_CAP` and the note
names the reason, the true total, and where the rest is.

For scale: an 8 MB / 40,000-context report costs 26 ms to parse and 43 ms to
render. Nothing is scheduled across frames because nothing needs it, and
`JSON.parse` is one synchronous call no `requestAnimationFrame` would break up.

## Tests

```
node viewer/test/core.test.mjs      # 57 assertions, pure logic, 20 real fixtures
python3 viewer/test/render.py       # 47 assertions, headless Chromium
python3 viewer/test/probe.py        # survey: every artifact + 17 hostile documents

node viewer/test/mirror.mjs         # pull the pinned modules from npm
python3 -m http.server 8793 --directory viewer/test/mirror &
python3 viewer/test/virt.py         # 17 assertions, both windowing paths
```

Fixtures are **real library output**, generated by running the library next
door — `node --expose-gc viewer/test/genfixtures.mjs`. They include a failing
gate with per-phase and per-region violations, an aggregate whose dilution guard
produced three nulls, a partial capture, a ratchet, and an attributed
`measureAllocs` run with named sites.

The core logic is extracted verbatim from the shipped `index.html` by the test
harness, so the tests exercise the file that ships.

```
node --expose-gc viewer/test/probe-lib.mjs   # survey: 39 degenerate inputs to the library
```

Both probes are surveys, not gates: they print what each input does. `probe.py`
is worth running because a new schema shows up as `REFUSE` the day it lands;
`probe-lib.mjs` because it separates inputs that throw from inputs that return
something confident and wrong.

## Notes for the library

Findings from rendering the envelope, which is the point of building the viewer
next to it.

**G27 attribution never ran in the shipped package.** `_loadInspector()` reaches
for `require` and then a `module` global; in a real ESM file neither exists, so
`req` is `null` — and `typeof null === 'object'`, which is why it reads as
working under casual inspection. This package is `"type": "module"`, so that was
the only path. Every `{ attribute: true }` call returned
`{ available: false, reason: 'no_inspector' }` on machines where
`node:inspector` loads fine. `G27-inspector-loader.patch` switches to
`process.getBuiltinModule('node:inspector')` — synchronous, ESM-safe, and still
guarded for the browser. With it applied, `measureAllocs` reports real sites
(`makeNode` at `Pool.js:3`, 23.1% of sampled bytes). The 22 tests in
`test/31-attribution.test.mjs` and 17 torture scenarios pass before *and* after,
because every substantive assertion sits behind
`if (!r.attribution.available) return;` — they skipped vacuously on exactly the
machines where the feature was dead. Worth an unguarded assertion that Node
attribution is available, so the suite can fail if this regresses.

**A never-started profiler gates green.** `new GcProfiler().summary()` returns a
summary whose `gc` block is byte-identical to one from a profiler that ran and
legitimately saw nothing — `count: 0`, `major: 0`, `supported: true`, and no
field anywhere distinguishing the two. `checkNoGc` on it returns
`verdict: 'pass'` with `checked: {maxMajor: true, maxPauseMs: true, maxTotalMs: true}`:
all three rules marked verified, on a profiler that never observed anything.
Forget `.start()` and you get a green zero-GC gate. This is the fail-open the
library's whole philosophy exists to prevent — zero collections because nothing
was watched reads identically to zero collections because the code is clean. A
`observed: false` (or a duration) on the summary, routed to `inconclusive`,
would close it.

**`formatGithubAnnotations` reports "gate passed" for a document with no
verdict.** Passing a summary emits
`::notice title=lite-gc-profiler::gate passed on source=gc`. In CI that is a
green notice for something that was never gated. Its two sibling formatters
throw a `TypeError` on the same input — loud and safe. This one claims success
quietly, which is the one outcome the three-verdict discipline forbids.

**`assertNoEscapes` never throws on a degenerate report.** `null`, `undefined`,
`{}` and `{escapes: null}` all pass silently. "Absence is advisory, never a
pass" is the documented rule, but an assertion that accepts a missing report is
fail-open: a `settle()` that returned nothing useful reads as clean.

**`ratchetBaseline` with its arguments swapped returns the aggregate as the
baseline.** It detects the misuse — `reason: 'invalid_baseline'`, `ratcheted:
false` — but `result.baseline === currentAggregate`, so the caller is handed a
wrongly-typed object under the right key. Returning the old baseline unchanged
(as the same-reference no-op path already does) would be safer.

**`formatJson` validates nothing.** `stop()` returns `this` for chaining, so
`formatJson(profiler.stop())` produced a 180 KB dump of private state
(`_regionIntervalEnterTime`, `_boundaryPhases`, …) inside a valid
`lite-gc-report/1` envelope. The envelope asserts it is a report; the body is
engine internals. A shape check would cost nothing. `formatMarkdown` also does
`report.verdict.toUpperCase()` unguarded, which throws on any non-gate document.

**Argument orders are inverted between neighbours.**
`checkAgainstBaseline(current, baseline)` and `ratchetBaseline(baseline, current)`
take the same two objects in opposite orders. Swapped, `checkAgainstBaseline`
returns `inconclusive` rather than throwing — the safe direction, but silent.

**Error quality is uneven.** `aggregateGc(summary)` throws a named
`TypeError: aggregateGc: summaries must be an array`; `aggregateGc([null])`
throws `Cannot read properties of null (reading 'source')` from inside V8. The
first tells you what to fix.

**A `kind:'gc'` gate embeds no summary.** It carries `checkedByPhase` and
`checkedByRegion` but not `phases`/`byRegion`, so the richest gate lane is the
one that cannot show attribution. The panel explains this rather than drawing an
empty chart.

**Violations arrive in four shapes now.**
`{metric,limit,actual,reason}` on gc/reps/compare/ops, `{rule,metric,actual,limit}`
on frames/ops-async/aggregates, `{metric,baselineMax,currentMedian,reason}` on
baseline, and `{rule,metric,limit,actual,reason}` on `checkAllocs`.
`normaliseViolations` absorbs all four.

**Region violations are namespaced under `phases.`** — a region rule surfaces as
`phases.byRegion.particles.gc.major`. Reads like the phase prefix was copied.

**`reasons[]` exists only on `checkAllocs`.** It is where an inconclusive
allocs gate explains itself, and it has no counterpart on the other lanes, which
carry the same explanation inside violation `reason` strings.

## Licence

MIT © 2026 Zahary Shinikchiev
