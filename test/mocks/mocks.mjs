// Tiny loader for the canonical report mocks in this folder. Tests import a
// fixture by name; regenerate the JSON with `node --expose-gc generate.mjs`.
// readFileSync + JSON.parse (not an import assertion) so this stays portable
// across Node versions.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadMock(name) {
    return JSON.parse(readFileSync(join(HERE, name + '.json'), 'utf8'));
}

export const MOCK_NAMES = [
    'report-pass', 'report-fail', 'report-inconclusive',
    'baseline', 'aggregate-workers', 'cli-run'
];
