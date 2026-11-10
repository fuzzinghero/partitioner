// Opt-in, file-backed benchmark. Does not include a GiB allocation in the test runner.
import assert from 'node:assert/strict';
import { openAsBlob } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, requestChangesComplete } from '../dist/core.js';
const mode = process.argv[2] ?? 'body';
assert(['body', 'dense'].includes(mode), 'Use body or dense.');
const target = Number(process.argv[3] ?? (mode === 'body' ? 1024 ** 3 : 24 * 1024 ** 2));
assert(Number.isSafeInteger(target) && target > 1024);
const bodyChars = mode === 'body' ? Math.max(32500, Math.ceil(target / 90000)) : 0;
const row = JSON.stringify({
  request: { method: 'GET', url: 'https://example.test/items', headers: [] },
  response: {
    status: 200,
    headers: [],
    content: {
      mimeType: 'application/json',
      text: JSON.stringify({ ok: true, padding: 'x'.repeat(bodyChars) }),
    },
  },
});
const prefix = '{"log":{"entries":[',
  suffix = ']}}';
const count = Math.min(
  100000,
  Math.floor((target - prefix.length - suffix.length) / (row.length + 1)),
);
assert(count > 0, 'Target must fit at least one entry.');
const directory = await mkdtemp(join(tmpdir(), 'har-benchmark-')),
  path = join(directory, 'capture.har');
try {
  const handle = await open(path, 'w');
  try {
    await handle.writeFile(prefix);
    const batch = Buffer.from((row + ',').repeat(256));
    let n = 0;
    while (n + 256 < count) {
      await handle.writeFile(batch);
      n += 256;
    }
    await handle.writeFile(Array.from({ length: count - n }, () => row).join(',') + suffix);
    let written = prefix.length + count * row.length + count - 1 + suffix.length;
    const padding = Buffer.alloc(1024 * 1024, 32);
    while (written < target) {
      const bytes = Math.min(padding.length, target - written);
      await handle.writeFile(padding.subarray(0, bytes));
      written += bytes;
    }
  } finally {
    await handle.close();
  }
  const file = await openAsBlob(path);
  assert.equal(
    file.size,
    target,
    'Node openAsBlob reported a truncated file size. Use a smaller target or a browser File benchmark.',
  );
  const peak = process.memoryUsage(),
    sample = () => {
      const usage = process.memoryUsage();
      for (const key in peak) peak[key] = Math.max(peak[key], usage[key]);
    };
  const started = performance.now();
  let last = 0;
  const analysis = await analyze(file, (done, total, entries) => {
    sample();
    if (done - last >= 128 * 1024 ** 2) {
      console.log(JSON.stringify({ done, total, entries }));
      last = done;
    }
  });
  const importMs = performance.now() - started,
    queryStarted = performance.now();
  const evidence = await requestChangesComplete(analysis, count - 1);
  sample();
  assert.equal(analysis.entries.length, count);
  assert.equal(analysis.outcomes.length, 1);
  assert.equal(evidence.incomplete, 0);
  assert.equal(evidence.cohortEntries, count);
  console.log(
    JSON.stringify(
      {
        mode,
        fileBytes: target,
        entries: count,
        importMs,
        queryMs: performance.now() - queryStarted,
        comparedRequests: evidence.entries,
        retainedBytes: analysis.summary.retainedBytes,
        metadataEstimate: analysis.summary.metadataEstimate,
        peak,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
