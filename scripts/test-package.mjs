// Test the archive from a separate project, not source imports or a workspace symlink.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const consumer = await mkdtemp(join(tmpdir(), 'partitioner-consumer-'));
let server;
let browser;
const run = (command, args, cwd = consumer) =>
  execFileSync(command, args, { cwd, stdio: 'inherit' });
try {
  const packed = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--foreground-scripts=false',
        '--json',
        '--pack-destination',
        consumer,
      ],
      { cwd: root, encoding: 'utf8' },
    ),
  )[0];
  assert(
    !packed.files.some((file) => /\.test\.|^scripts\//.test(file.path)),
    'Do not ship tests or development tooling.',
  );
  assert(
    packed.files.some((file) => file.path === 'src/client.ts'),
    'Ship navigable production source.',
  );
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  run('npm', [
    'install',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    join(consumer, packed.filename),
  ]);
  await cp(join(root, 'scripts/fixtures/consumer'), consumer, { recursive: true });
  const packageRoot = join(consumer, 'node_modules/@fuzzinghero/partitioner');
  for (const file of packed.files.filter((file) => file.path.endsWith('.map'))) {
    const mapPath = join(packageRoot, file.path);
    const map = JSON.parse(await readFile(mapPath, 'utf8'));
    for (const source of map.sources) {
      const sourcePath = resolve(dirname(mapPath), map.sourceRoot ?? '', source);
      assert(
        sourcePath.startsWith(packageRoot + sep),
        'Source maps must stay inside the installed package.',
      );
      assert((await stat(sourcePath)).isFile(), `Missing mapped source: ${source}`);
    }
  }
  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2023', 'DOM', 'DOM.Iterable'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        types: [],
      },
      files: ['consumer.ts'],
    }),
  );
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json']);
  await writeFile(
    join(consumer, 'tsconfig.node.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2023'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        types: ['node'],
        typeRoots: [join(root, 'node_modules/@types')],
      },
      files: ['node-consumer.ts'],
    }),
  );
  run(process.execPath, [
    join(root, 'node_modules/typescript/bin/tsc'),
    '-p',
    'tsconfig.node.json',
  ]);

  run(process.execPath, ['probe.mjs']);
  const exampleReport = JSON.parse(
    execFileSync(process.execPath, [join(packageRoot, 'examples/analyze.mjs')], {
      cwd: consumer,
      encoding: 'utf8',
    }),
  );
  assert.equal(exampleReport.summary.capturedRequests, 4);
  assert.equal(exampleReport.contexts[0].partitions[0].requestCount, 3);
  assert.equal(exampleReport.contexts[0].partitions[1].sample.response.status, 422);
  const cli = join(consumer, 'node_modules/.bin/partitioner');
  const cliRun = (args) => spawnSync(cli, args, { cwd: consumer, encoding: 'utf8' });
  for (const flag of ['--help', '-h']) {
    const result = cliRun([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: partitioner --file/);
    assert.equal(result.stderr, '');
  }
  const capturePath = join(consumer, 'capture with spaces.har');
  await cp(join(packageRoot, 'examples/partition-report.har'), capturePath);
  for (const flag of ['--file', '-f']) {
    const result = cliRun([flag, capturePath]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), exampleReport);
  }
  for (const args of [[], ['--file'], ['--unknown'], [capturePath]]) {
    const result = cliRun(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /partitioner:/);
  }
  await writeFile(join(consumer, 'invalid.har'), '{invalid');
  for (const path of ['missing.har', 'invalid.har']) {
    const result = cliRun(['--file', path]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /partitioner:/);
  }
  await writeFile(
    join(consumer, 'incomplete.har'),
    JSON.stringify({
      log: {
        entries: [
          {
            request: { method: 'GET', url: 'https://example.test/', headers: [] },
            response: { status: 200, content: { mimeType: 'text/plain' } },
          },
        ],
      },
    }),
  );
  const incomplete = cliRun(['--file', 'incomplete.har']);
  assert.equal(incomplete.status, 0, incomplete.stderr);
  assert.equal(JSON.parse(incomplete.stdout).summary.missingResponseBodies, 1);
  assert.equal(incomplete.stderr, '');
  await build({
    root: consumer,
    configFile: false,
    base: './',
    logLevel: 'warn',
    build: { target: 'es2022', outDir: 'build' },
  });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
  server = createServer(async (request, response) => {
    try {
      const path = resolve(
        consumer,
        '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname),
      );
      if (!path.startsWith(consumer + sep)) {
        response.writeHead(403).end();
        return;
      }
      response.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream');
      response.end(await readFile(path));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    ...(process.env.PARTITIONER_BROWSER === 'chromium' ? {} : { channel: 'chrome' }),
    headless: true,
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
  });
  for (const path of ['/native.html', '/build/index.html']) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      if (new URL(route.request().url()).origin !== origin) {
        errors.push('Unexpected external request');
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(origin + path);
    await page.waitForFunction(() => window.consumerResult !== undefined, undefined, {
      timeout: 15000,
    });
    assert.deepEqual(await page.evaluate(() => window.consumerResult), { ok: true }, path);
    assert.deepEqual(errors, [], path);
    await page.close();
    console.log(`Installed package browser checks passed: ${path}`);
  }
} finally {
  await Promise.allSettled([
    browser?.close(),
    server && new Promise((resolve) => server.close(resolve)),
  ]);
  await rm(consumer, { recursive: true, force: true });
}
