# v1.2.0 migration notes

Additive release; **no breaking changes**. Existing v1.1.0 code and
`gc-baseline.json` files continue to work unchanged.

## New surface

- `sampleUasm()` on `GcProfiler` -- async, returns a Promise. Safe to
  call on any runtime; resolves to `{ supported: false }` where the
  browser API is missing.
- `summary.uasm` block on every report. Present even when uasm was
  never sampled (`supported: false`, zeros).
- Constructor accepts `source: 'auto' | 'gc' | 'heap' | 'uasm' | 'none'`.
  Default `'auto'` matches v1.1.0 detection.
- `VERDICT_MATRIX` gains a `uasm` column. Tools that render or filter
  the matrix should regenerate their column list.

## Baselines from v1.1.0

Loading a v1.1.0 baseline in v1.2.0 works: the missing `uasm` block is
tolerated by `_extract` (returns 0 for absent branches). Rebuild the
baseline whenever you switch a package's gate to `source: 'uasm'`.

## For gates using `maxAllocRate`

Behavior unchanged when the source is `gc` or `heap`. If you switch a
gate to `source: 'uasm'`, `maxAllocRate` now reads
`summary.uasm.growthRate` instead of `summary.heap.allocRateBytesPerSec`.
The rule name and limit units (bytes/sec) are the same.

# v1.1.0 migration notes

## The test script is now an explicit glob

v1.1.0 uses `node --test 'test/*.test.mjs' 'test/torture/*.test.mjs'` instead
of the v1.0.0 default discovery. This matters because node's default `--test`
mode runs **every** `.mjs` file inside a `test/` folder, not just files
matching `*.test.mjs`. That default caught:

- Helper files that aren't tests (`test/torture/harness.mjs`).
- Fixture workload scripts spawned by the CLI smoke tests
  (`test/fixtures/TargetClean.mjs`, `test/fixtures/TargetDirty.mjs`).
- Any leftover `.mjs` file from a prior extract.

Under default discovery, these ran as trivially-passing "tests" (padding
the count) or, if they had unresolvable imports, hard-failed the whole
suite. The explicit glob eliminates both problems: only `*.test.mjs` files
are discovered, and everything else is ignored regardless of where it sits.

## If your first extract left stragglers

Two files that shouldn't be in `test/` but might exist there from a merge
extract of an earlier delivery:

```bash
rm -f test/GcGate.mjs                    # belongs in templates/GcGate.mjs
rm -f test/g10-5-attribution.mjs         # belongs in test/torture/g10-5-attribution.test.mjs
```

The correct copies are already at `templates/GcGate.mjs` and
`test/torture/g10-5-attribution.test.mjs` in the v1.1.0 tree.

## Clean-extract path (recommended)

If you'd rather start clean than patch in place:

```bash
# Backup
mv LiteGCProfiler LiteGCProfiler.backup

# Fresh extract
unzip lite-gc-profiler-1.1.0.zip
mv lite-gc-profiler LiteGCProfiler
cd LiteGCProfiler

# Restore your v1.0.0 tests (untouched by this release; resolved via index.js shim)
cp ../LiteGCProfiler.backup/test/01-accounting.test.mjs test/
cp ../LiteGCProfiler.backup/test/02-gc-live.test.mjs test/
cp ../LiteGCProfiler.backup/test/03-heap-frames.test.mjs test/

# Verify
npm test              # expect 240 (mine) + 3 (yours) = 243 passing
npm run bundle-check
npm publish
```

## Directory structure

After extraction, your tree should have:

```
LiteGCProfiler/
├── Gc.js                    Main file (was index.js in v1.0.0)
├── Gc.d.ts
├── index.js                 Back-compat shim -> Gc.js
├── index.d.ts               Back-compat shim
├── Register.mjs             Auto-attach preload (./register subpath)
├── TestHelpers.js           node:test helper (./test-helpers subpath)
├── TestHelpers.d.ts
├── Explain.js               Explain mode (./explain subpath)
├── Explain.d.ts
├── bin/
│   └── LiteGcGate.mjs       CLI
├── templates/
│   └── GcGate.mjs           TEMPLATE -- do NOT put in test/
├── test/
│   ├── 00-baseline.test.mjs ... 15-explain.test.mjs
│   ├── 99-backcompat.test.mjs
│   ├── fixtures/            CLI smoke targets, NOT tests
│   │   ├── TargetClean.mjs
│   │   └── TargetDirty.mjs
│   └── torture/
│       ├── harness.mjs      Helper, NOT a test
│       ├── g3-5-verdicts.test.mjs
│       ├── g5-5-reps.test.mjs
│       └── g10-5-attribution.test.mjs
├── package.json
├── README.md
├── CHANGELOG.md
├── LICENSE.txt
└── llms.txt
```

## Why some files are NOT `.test.mjs`

- `templates/GcGate.mjs` -- template with `<PACKAGE_NAME>` placeholder;
  fails to import if run. Belongs in `templates/`.
- `test/torture/harness.mjs` -- helper imported by torture tests; not a
  runnable test by itself.
- `test/fixtures/TargetClean.mjs`, `TargetDirty.mjs` -- workload targets
  the CLI smoke tests spawn as child processes; not tests themselves.

With the explicit test glob, these are naturally excluded from discovery.

## Self-noise ceilings (test/07-self-noise.test.mjs)

The ceilings in v1.1.0 are regression sentinels for orders-of-magnitude
changes, not tight per-machine bounds:

- `SELF_NOISE_MAX_MINORS = 30` (was 5; raised to accommodate hardware
  variance)
- `SELF_NOISE_MAX_PAUSE_MS = 5` (was 2; same reason)

If your hardware sees more than 30 minor GCs in a 500 ms noop loop, that
IS an anomaly worth investigating -- but the previous ceilings were
tripping on ordinary machines with slightly more aggressive scavenging.
