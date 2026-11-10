#!/usr/bin/env node
import { existsSync, openAsBlob } from 'node:fs';
import { parseArgs } from 'node:util';

async function loadCore() {
  const built = new URL('../dist/core.js', import.meta.url);
  if (existsSync(built)) return import(built.href);

  // A source checkout needs no build or dependencies on Node with type stripping.
  const { registerHooks } = await import('node:module');
  if (!registerHooks || !process.features.typescript)
    throw new Error('Use Node.js 22.18+ with TypeScript enabled, or run npm ci to build the CLI.');
  const source = new URL('../src/', import.meta.url).href;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(source) && /^\.\/[^/]+\.js$/.test(specifier))
        return nextResolve(specifier.slice(0, -3) + '.ts', context);
      return nextResolve(specifier, context);
    },
  });
  try {
    return await import(new URL('core.ts', source).href);
  } finally {
    hooks.deregister();
  }
}

const help = `Usage: partitioner --file <capture.har>

Analyze a HAR file and write the partition report as JSON to stdout.

Options:
  -f, --file <path>  HAR file to import
  -h, --help         Show this help

Example:
  partitioner --file capture.har > report.json
`;

process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE') {
    console.error(`partitioner: ${error.message}`);
    process.exitCode = 1;
  }
});

let values;
try {
  ({ values } = parseArgs({
    options: {
      file: { type: 'string', short: 'f' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
  if (!values.help && !values.file) throw new Error('Specify a HAR file with --file <path>.');
} catch (error) {
  console.error(`partitioner: ${error.message}\nRun partitioner --help for usage.`);
  process.exitCode = 2;
}

if (process.exitCode === undefined) {
  if (values.help) process.stdout.write(help);
  else {
    try {
      const { analyzeReport } = await loadCore();
      const report = await analyzeReport(await openAsBlob(values.file));
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      console.error(`partitioner: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
