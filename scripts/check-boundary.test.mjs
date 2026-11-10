import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBoundary } from './check-boundary.mjs';

async function fixture(t, source, name = 'core.ts') {
  const root = await mkdtemp(join(tmpdir(), 'partitioner-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', name), source);
  return root;
}

for (const [name, source] of [
  [
    'core.ts',
    `import './body.js'; export { x } from './core.js'; export type Core = typeof import('./core.js');`,
  ],
  [
    'core.ts',
    `// fetch('https://example.test')\nconst message = 'Unsupported fetch('; const sample = "import('external')";`,
  ],
  [
    'core.test.ts',
    `import assert from 'node:assert'; import {test} from 'vitest'; fetch('https://example.test');`,
  ],
  ['react.ts', `import {useMemo} from 'react';`],
]) {
  test(`accepts permitted syntax: ${source}`, async (t) => {
    await checkBoundary(await fixture(t, source, name));
  });
}

for (const source of [
  `import 'external';`,
  `export {x} from '../outside.js';`,
  `export type T = typeof import('node:fs');`,
  `import React from 'react';`,
  `import('./body.js');`,
  `require('./body.js');`,
  `import fs = require('node:fs');`,
  `fetch('https://example.test');`,
  'const message = `result: ${fetch("https://example.test")}`;',
  `globalThis['fetch']('https://example.test');`,
  `new WebSocket('wss://example.test');`,
  `new XMLHttpRequest();`,
  `new DOMParser();`,
  `eval('code');`,
  `new Function('code');`,
  `Function('code');`,
  `localStorage.getItem('key');`,
  `globalThis.sessionStorage.clear();`,
  `indexedDB.open('db');`,
  `element.innerHTML = markup;`,
  `element['innerHTML'] += markup;`,
]) {
  test(`rejects boundary violation: ${source}`, async (t) => {
    await assert.rejects(
      checkBoundary(await fixture(t, source)),
      /boundary violation|Dynamic import|Require import|Disallowed capture sink/,
    );
  });
}

test('runtime imports remain prohibited in tests', async (t) => {
  await assert.rejects(
    checkBoundary(await fixture(t, `import('./core.js');`, 'core.test.ts')),
    /Dynamic import/,
  );
});
