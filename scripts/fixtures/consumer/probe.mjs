import assert from 'node:assert/strict';
import * as root from '@fuzzinghero/partitioner';
import * as core from '@fuzzinghero/partitioner/core';
import * as browser from '@fuzzinghero/partitioner/browser';

assert.equal(
  root.HarError,
  core.HarError,
  'Errors must share identity across package entry points.',
);
assert.equal(root.HarError, browser.HarError);
const file = new Blob([
  JSON.stringify({
    log: {
      entries: [0, 1].map((id) => ({
        request: { method: 'GET', url: `https://example.test/items?q=${id}`, headers: [] },
        response: {
          status: 200,
          headers: [],
          content: {
            mimeType: 'application/json',
            text: JSON.stringify({ id, state: id ? 'denied' : 'accepted' }),
          },
        },
      })),
    },
  }),
]);
for (const client of [
  browser.createAnalyzer(),
  new browser.AnalyzerClient(),
  browser.createHarAnalyzer(),
  new browser.HarAnalyzerClient(),
]) {
  assert.equal(client.getSnapshot().status, 'idle');
  await assert.rejects(
    client.getPartitions(),
    (error) => error instanceof root.HarError && error.code === 'NOT_READY',
  );
  client.dispose();
  await assert.rejects(
    client.analyze(file),
    (error) => error instanceof root.HarError && error.code === 'DISPOSED',
  );
}
const analysis = await core.analyze(file, { limits: { totalBodyBytes: 0 } });
assert.equal(analysis.outcomes.length, 2);
assert.equal(
  core.groupPage(analysis, 'outcomes', 1, '', undefined, '', 1).rows[0].representative,
  1,
);
assert.equal((await core.requestChangesComplete(analysis, 1)).contrasts[0].causal, false);
const report = await core.analyzeReport(file);
assert.equal(report.schemaVersion, 1);
assert.equal(report.contexts.length, 1);
assert.equal(report.contexts[0].partitions.length, 2);
assert.equal(report.contexts[0].partitions[1].sample.request.url, 'https://example.test/items?q=1');
assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
assert.equal((await core.buildReport(analysis)).summary.responsePartitions, 2);
await assert.rejects(
  core.analyze(new Blob(['{bad'])),
  (error) => error instanceof root.HarError && error.code === 'INVALID_HAR',
);
console.log(
  'Installed ESM package: core analysis, deferred query, error identity and pagination passed.',
);

const diagnosticCapture = new Blob([
  JSON.stringify({
    log: {
      entries: [1, 2, 3].map((id) => ({
        request: { method: 'GET', url: 'https://example.test/defaults', headers: [] },
        response: {
          status: 400,
          headers: [{ name: 'Date', value: new Date(`2026-10-28T10:00:0${id}Z`).toUTCString() }],
          content: {
            mimeType: 'text/plain',
            text: JSON.stringify({
              message: 'Rejected',
              arbitrary: `2026-10-28T10:00:0${id}.123456789+00:00`,
            }),
          },
        },
      })),
    },
  }),
]);
const diagnosticReport = await core.analyzeReport(diagnosticCapture, {
  limits: { totalBodyBytes: 0 },
});
assert.equal(diagnosticReport.summary.responsePartitions, 1);
assert.equal(diagnosticReport.contexts[0].partitions[0].grouping.heuristic, true);
assert.deepEqual(diagnosticReport.contexts[0].partitions[0].grouping.normalizations, [
  'detected-json',
  'response-telemetry',
]);
