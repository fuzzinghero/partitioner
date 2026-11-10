import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
// Keep stale declarations and worker assets out of release archives.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
    '-p',
    'tsconfig.json',
  ],
  { cwd: root, stdio: 'inherit' },
);
await build({
  absWorkingDir: root,
  entryPoints: {
    index: 'src/index.ts',
    core: 'src/core.ts',
    browser: 'src/browser.ts',
    react: 'src/react.ts',
    'har.worker': 'src/har.worker.ts',
  },
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['react'],
  outdir: 'dist',
  sourcemap: true,
  sourcesContent: false,
});
