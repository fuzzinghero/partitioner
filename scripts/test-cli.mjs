import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('CLI analyzes captures from an unbuilt checkout without dependencies', async () => {
  const checkout = await mkdtemp(join(tmpdir(), 'partitioner-cli-'));
  try {
    for (const path of ['bin', 'src', 'package.json', 'examples'])
      await cp(new URL(`../${path}`, import.meta.url), join(checkout, path), { recursive: true });
    const run = (...args) =>
      spawnSync(process.execPath, [join(checkout, 'bin/partitioner.mjs'), ...args], {
        cwd: tmpdir(),
        encoding: 'utf8',
      });
    const capture = join(checkout, 'capture with spaces.har');
    await cp(join(checkout, 'examples/partition-report.har'), capture);
    const result = run('--file', capture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.capturedRequests, 4);
    assert.equal(report.contexts[0].partitions[0].requestCount, 3);
    assert.equal(report.contexts[0].partitions[1].sample.response.status, 422);
    const help = run('--help');
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: partitioner --file/);
    assert.equal(help.stderr, '');
    const invalidArgs = run('--unknown');
    assert.equal(invalidArgs.status, 2);
    assert.equal(invalidArgs.stdout, '');
    assert.match(invalidArgs.stderr, /partitioner:/);
    await writeFile(join(checkout, 'invalid.har'), '{invalid');
    for (const file of ['missing.har', 'invalid.har']) {
      const failure = run('--file', join(checkout, file));
      assert.equal(failure.status, 1);
      assert.equal(failure.stdout, '');
      assert.match(failure.stderr, /partitioner:/);
    }
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});
