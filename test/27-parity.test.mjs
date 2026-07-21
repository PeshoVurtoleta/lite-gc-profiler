// Parity gate (v1.10.0, ROADMAP section 6 step 4).
//
// Three surfaces have to agree about what this package exports: the runtime
// module, the type declarations, and the docs. They drift silently -- a new
// export lands in Gc.js, the .d.ts follows, and llms.txt does not, so an agent
// consumer never learns the API exists. Or worse: a declaration outlives the
// function it declared, and TypeScript users call something that is gone.
//
// Ledger item 7 asked whether a tsc step belongs in the shipped scripts. It
// does not -- `npm run typecheck` covers it on demand without making a
// zero-dependency package carry TypeScript. What DOES belong in the suite is
// this: parity as an executable invariant rather than a habit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

/** Exported names, from the runtime module itself rather than by parsing. */
async function runtimeExports(file) {
    const m = await import(join(ROOT, file));
    return Object.keys(m).filter((k) => k !== 'default').sort();
}

/** Declared names in a .d.ts, from `export function|const|class` forms. */
function declaredExports(file) {
    const src = read(file);
    const names = new Set();
    const re = /^export\s+(?:declare\s+)?(?:function|const|class|let|var)\s+([A-Za-z0-9_$]+)/gm;
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
    // `export { a, b }` re-export lists.
    const re2 = /^export\s*\{([^}]+)\}/gm;
    while ((m = re2.exec(src)) !== null) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/).pop().trim();
            if (name && name !== 'default') names.add(name);
        }
    }
    return [...names].sort();
}

test('every runtime export of Gc.js is declared in Gc.d.ts', async () => {
    const runtime = await runtimeExports('Gc.js');
    const declared = new Set(declaredExports('Gc.d.ts'));
    const missing = runtime.filter((n) => !declared.has(n));
    assert.deepEqual(missing, [],
        'exported at runtime but undeclared -- TypeScript users cannot see these: ' + missing.join(', '));
});

test('every runtime export of Explain.js is declared in Explain.d.ts', async () => {
    const runtime = await runtimeExports('Explain.js');
    const declared = new Set(declaredExports('Explain.d.ts'));
    const missing = runtime.filter((n) => !declared.has(n));
    assert.deepEqual(missing, [], 'undeclared exports: ' + missing.join(', '));
});

test('no declaration outlives its implementation', async () => {
    // The dangerous direction: a .d.ts promising a function that no longer
    // exists compiles fine and fails at runtime.
    const runtime = new Set(await runtimeExports('Gc.js'));
    const ghosts = declaredExports('Gc.d.ts').filter((n) => !runtime.has(n));
    assert.deepEqual(ghosts, [],
        'declared but not exported at runtime -- these would compile and then throw: ' + ghosts.join(', '));
});

test('every gateable rule appears in the README and in llms.txt', () => {
    // The matrix is the source of truth for what can be gated. A rule nobody
    // documents is a rule nobody uses.
    const readme = read('README.md');
    const llms = read('llms.txt');
    const matrix = read('Gc.js').match(/const VERDICT_MATRIX = \{[\s\S]*?\n\};/)[0];
    const rules = [...matrix.matchAll(/^\s{4}(max[A-Za-z]+):/gm)].map((m) => m[1]);
    assert.ok(rules.length >= 15, 'sanity: found ' + rules.length + ' rules in the matrix');

    const undocumentedReadme = rules.filter((r) => !readme.includes(r));
    assert.deepEqual(undocumentedReadme, [], 'gateable but absent from README: ' + undocumentedReadme.join(', '));

    // llms.txt is a behavioural brief, not an API listing -- it deliberately
    // does not enumerate all sixteen rules, and forcing it to would bloat the
    // file it exists to keep short. The invariant that matters there is the
    // other direction: it must not name a rule that no longer exists.
    //
    // Checked against the whole implementation, not against VERDICT_MATRIX:
    // the matrix holds whole-window rules only. Differential rules
    // (maxExtraAllocRate and friends) live in the compare tables, and
    // deliberately-ungated names live in _UNGATED_RULES -- llms.txt names
    // maxExternalGrowth precisely to say it is not a rule, which is exactly
    // the kind of documentation that should not trip this gate.
    const src = read('Gc.js');
    const ghosts = [...llms.matchAll(/`(max[A-Za-z]+)`/g)]
        .map((m) => m[1])
        .filter((r) => !src.includes(r));
    assert.deepEqual([...new Set(ghosts)], [],
        'llms.txt names rules that are not in the matrix: ' + ghosts.join(', '));
});

test('every inconclusive reason code is documented in INCONCLUSIVE.md', () => {
    const src = read('Gc.js');
    const doc = read('INCONCLUSIVE.md');
    const codes = new Set([...src.matchAll(/reason(?::|\s=)\s*'([a-z_]+)'/g)].map((m) => m[1]));
    const missing = [...codes].filter((c) => !doc.includes(c));
    assert.deepEqual(missing, [],
        'reason codes a user can receive with no triage row: ' + missing.join(', '));
});

test('the shipped file list covers every file the docs link to', () => {
    const pkg = JSON.parse(read('package.json'));
    const shipped = new Set(pkg.files);
    // Docs shipped inside the tarball must not link to docs that are not.
    for (const doc of ['README.md', 'INCONCLUSIVE.md', 'COOKBOOK.md']) {
        const links = [...read(doc).matchAll(/\]\(\.\/([A-Za-z0-9_.-]+\.md)\)/g)].map((m) => m[1]);
        for (const link of links) {
            assert.ok(shipped.has(link),
                doc + ' links to ' + link + ', which is not in package.json files[] -- '
                + 'the link is dead for anyone reading from node_modules');
        }
    }
});

test('the version is consistent across every surface that states it', () => {
    const version = JSON.parse(read('package.json')).version;
    assert.match(read('Gc.js'), new RegExp("const VERSION = '" + version.replace(/\./g, '\\.') + "'"));
    assert.match(read('Gc.d.ts'), new RegExp("VERSION: '" + version.replace(/\./g, '\\.') + "'"));
    assert.ok(read('llms.txt').includes('v' + version), 'llms.txt states a stale version');
});
