// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { expect, it, describe } from 'vitest';
import { analyze, analyzeReport, buildReport, groupPage, requestChanges } from './core.js';
import type { ReportOptions } from './report-types.js';

const capture = (entries: unknown[]) => new Blob([JSON.stringify({ log: { entries } })]);
const row = (value = 'one', response: Record<string, unknown> = {}, request = {}) => ({
  time: 12,
  request: {
    method: 'POST',
    url: `https://example.test/items?q=${value}&q=shared`,
    headers: [{ name: 'Content-Type', value: 'application/json' }],
    postData: { mimeType: 'application/json', text: JSON.stringify({ nested: { value } }) },
    ...request,
  },
  response: {
    status: 200,
    headers: [],
    content: { mimeType: 'text/plain', text: 'accepted' },
    ...response,
  },
});
const fixture = async () =>
  new Blob([await readFile(new URL('../examples/partition-report.har', import.meta.url))]);

it.each([1, 3])('explains singleton partitions in a %i-request capture', async (count) => {
  const entries = [row()];
  if (count === 3) entries.push(row('two', { status: 400 }), row('three', { status: 400 }));
  const report = await analyzeReport(capture(entries));
  const partitions = report.contexts[0].partitions;
  expect(partitions.find((partition) => partition.requestCount === 1)?.grouping.explanation).toBe(
    'Single observation. No comparison available.',
  );
  if (count === 3)
    expect(partitions.find((partition) => partition.requestCount === 2)?.grouping.explanation).toBe(
      'Responses share the same captured body bytes and grouping metadata.',
    );
});

it('explains HTML date normalization as heuristic evidence', async () => {
  const dates = ['Thu, 08 Oct 2026 18:03:38 GMT', 'Fri, 09 Oct 2026 18:03:38 GMT'];
  const report = await analyzeReport(
    capture(
      dates.map((date) =>
        row('fixed', { content: { mimeType: 'text/html', text: `<p>${date}</p>` } }),
      ),
    ),
  );
  expect(report.summary.responsePartitions).toBe(1);
  expect(report.contexts[0].partitions[0].grouping).toMatchObject({
    heuristic: true,
    basis: 'inferred-noise',
    normalizations: ['response-telemetry'],
  });
});

it('preserves field identities for whole-query and literal Query string variations', async () => {
  const rows = [
    ['Query%20string=one', 200],
    ['Query+string=one', 200],
    ['Query%20string=two', 400],
  ].map(([query, status]) =>
    row(
      'value',
      { status, content: { mimeType: 'text/plain', text: status === 200 ? 'ok' : 'bad' } },
      { method: 'GET', url: `https://example.test/?${query}`, postData: undefined },
    ),
  );
  const report = await analyzeReport(capture(rows));
  const [first, second] = report.contexts[0].partitions.map(
    (partition) => partition.variations.fields[0],
  );
  expect(first).toMatchObject({ id: '["Raw query","Query representation"]' });
  expect(second).toMatchObject({ id: '["Query parameter","Query string"]' });
});

it('explains a complete fixture through nested partitions and paired captured HTTP exchanges', async () => {
  const file = await fixture();
  const report = await analyzeReport(file);
  expect(report.summary).toMatchObject({
    capturedRequests: 4,
    analyzedRequests: 4,
    skippedRequests: 0,
    requestContexts: 1,
    responsePartitions: 2,
  });
  expect(report.source).toEqual({ format: 'har', bytes: file.size });
  const [context] = report.contexts;
  expect(context).toMatchObject({ methods: ['POST'], requestCount: 4, partitionCount: 2 });
  expect(context.partitions.map((p) => [p.number, p.requestCount, p.statuses])).toEqual([
    [1, 3, [200]],
    [2, 1, [422]],
  ]);
  const [success, failure] = context.partitions;
  expect(success.responseBytes).toEqual({ min: 17, max: 17 });
  expect(success.timeMs).toEqual({ min: 10, max: 12 });
  expect(success.sample).toMatchObject({
    entry: 0,
    request: {
      method: 'POST',
      url: 'https://example.test/orders?tag=demo&tag=public',
      httpVersion: 'HTTP/1.1',
      body: {
        state: 'text',
        text: '{"order":{"quantity":1},"request_id":"demo-0"}',
        truncated: false,
      },
    },
    response: { status: 200, body: { text: '{"accepted":true}' } },
  });
  expect(success.sample?.request.headers.filter((h) => h.name === 'X-Demo')).toEqual([
    { name: 'X-Demo', value: 'first' },
    { name: 'X-Demo', value: 'second' },
  ]);
  expect(failure.sample?.response.body.text).toBe('{"error":"quantity must be positive"}');
  const quantities = success.variations.fields.find((f) => f.key === '/order/quantity');
  expect(quantities).toMatchObject({
    label: '$.order.quantity',
    category: 'JSON',
    values: [
      { entry: 0, value: '1', format: 'json', requestCount: 2 },
      { entry: 2, value: '2', format: 'json', requestCount: 1 },
    ],
  });
  expect(failure.variations.fields.find((f) => f.key === '/order/quantity')?.values).toMatchObject([
    { entry: 3, value: '-1', format: 'json' },
  ]);
  expect(JSON.parse(JSON.stringify(report))).toEqual(report);
});

it('agrees with core grouping and request evidence without mutating the original handles', async () => {
  const analysis = await analyze(await fixture());
  const before = JSON.stringify(analysis);
  const report = await buildReport(analysis, { diagnostics: true });
  const groups = groupPage(analysis, 'outcomes', 0, '').rows;
  for (const partition of report.contexts[0].partitions) {
    const group = groups.find((g) => g.id === partition.id)!;
    expect(partition.requestCount).toBe(group.count);
    expect(partition.grouping.basis).toBe(group.match);
    expect(partition.sample?.entry).toBe(group.representative);
    expect(partition.variations.fields.map((f) => [f.category, f.key])).toEqual(
      requestChanges(analysis, group.representative).changes.map((c) => [c.kind, c.key]),
    );
  }
  expect(report.diagnostics?.summary.total).toBe(4);
  report.contexts[0].partitions[0].sample!.request.headers.length = 0;
  expect(JSON.stringify(analysis)).toBe(before);
});

it('keeps query vectors, JSON strings, exact numeric lexemes and full JSON paths legible', async () => {
  const file = capture(
    ['first', 'second'].map((value, id) =>
      row(
        value,
        {},
        {
          postData: {
            mimeType: 'application/json',
            text: `{"nested":{"value":"${value}"},"numeric":${id ? '9007199254740993' : '9007199254740992'},"items":[{"name":"${value}"}],"object":{"0":"${value}"}}`,
          },
        },
      ),
    ),
  );
  const report = await analyzeReport(file);
  const fields = report.contexts[0].partitions[0].variations.fields;
  expect(
    fields.find((f) => f.category === 'Query' && f.key === 'q')?.values.map((v) => v.value),
  ).toEqual([
    ['first', 'shared'],
    ['second', 'shared'],
  ]);
  expect(fields.find((f) => f.key === '/nested/value')?.values.map((v) => v.value)).toEqual([
    'first',
    'second',
  ]);
  expect(fields.find((f) => f.key === '/numeric')?.values.map((v) => v.value)).toEqual([
    '9007199254740992',
    '9007199254740993',
  ]);
  expect(fields.find((f) => f.key === '/items/0/name')?.label).toBe('$.items[0].name');
  expect(fields.find((f) => f.key === '/object/0')?.label).toBe('$.object["0"]');
});

it('labels corroborated reflection grouping as heuristic while retaining a real exchange', async () => {
  const values = ['payload-111', 'payload-222', 'payload-333'];
  const report = await analyzeReport(
    capture(
      values.map((value) => ({
        request: { method: 'GET', url: `https://example.test/echo?q=${value}`, headers: [] },
        response: {
          status: 200,
          headers: [],
          content: { mimeType: 'text/plain', text: `Rejected value ${value}.` },
        },
      })),
    ),
  );
  const [partition] = report.contexts[0].partitions;
  expect(report.summary.responsePartitions).toBe(1);
  expect(partition.requestCount).toBe(3);
  expect(partition.grouping).toMatchObject({ basis: 'inferred-reflection', heuristic: true });
  expect(partition.sample?.response.body.text).toBe('Rejected value payload-111.');
  expect(
    partition.variations.fields.find((f) => f.key === 'q')?.values.map((v) => v.value),
  ).toEqual(values.map((v) => [v]));
});

it('rejects changed source bytes when recovering representative evidence', async () => {
  class ChangedCapture extends Blob {
    changed = false;
    constructor(private readonly original: string) {
      super([original]);
    }
    override slice(start = 0, end = this.size) {
      const original = this.original.slice(start, end);
      return new Blob([this.changed ? original.replace('accepted', 'rejected') : original]);
    }
  }
  const file = new ChangedCapture(JSON.stringify({ log: { entries: [row()] } }));
  const analysis = await analyze(file, { limits: { totalBodyBytes: 0 } });
  file.changed = true;
  await expect(buildReport(analysis)).rejects.toMatchObject({
    code: 'SOURCE_CHANGED',
  });
});

it('allows cancellation after report projection starts', async () => {
  const analysis = await analyze(
    capture(Array.from({ length: 60 }, (_, id) => row(String(id), { status: 200 + id }))),
  );
  const controller = new AbortController();
  const pending = buildReport(analysis, { signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
});

describe('evidence coverage', () => {
  it('reports missing status and bodies without inventing HTTP failures', async () => {
    const report = await analyzeReport(capture([row('one', { status: 0, content: {} })]));
    const partition = report.contexts[0].partitions[0];
    expect(partition.statuses).toEqual([null]);
    expect(partition.sample?.response).toMatchObject({
      status: null,
      body: { state: 'missing', truncated: false },
    });
    expect(partition.grouping.basis).toBe('metadata-only');
    expect(partition.sample?.warnings).toContain(
      'No HTTP response status was captured (HAR status 0).',
    );
  });

  it('distinguishes empty, binary, invalid and limited bodies and preserves Unicode prefixes', async () => {
    const report = await analyzeReport(
      capture([
        row('empty', { content: { mimeType: 'text/plain', text: '' } }),
        row('binary', {
          content: { mimeType: 'application/octet-stream', text: 'AAE=', encoding: 'base64' },
        }),
        row('invalid', { content: { mimeType: 'text/plain', text: '*bad*', encoding: 'base64' } }),
        row('long', { content: { mimeType: 'text/plain', text: 'a😀rest' } }),
      ]),
      { reportLimits: { bodyChars: 2 } },
    );
    const samples = report.contexts.flatMap((c) => c.partitions).map((p) => p.sample!);
    expect(samples.find((s) => s.entry === 0)?.response.body).toMatchObject({
      state: 'empty',
      text: '',
      truncated: false,
    });
    expect(samples.find((s) => s.entry === 1)?.response.body.state).toBe('binary');
    expect(samples.find((s) => s.entry === 2)?.response.body.state).toBe('invalid');
    expect(samples.find((s) => s.entry === 3)?.response.body).toMatchObject({
      text: 'a',
      truncated: true,
    });
    const limited = await analyzeReport(
      capture([row('long', { content: { mimeType: 'text/plain', text: 'long response' } })]),
      { limits: { bodyBytes: 4 } },
    );
    expect(limited.contexts[0].partitions[0].sample?.response.body).toMatchObject({
      state: 'limited',
      truncated: true,
    });
  });

  it('recovers paired representative bodies from the HAR when retention evicts them', async () => {
    const report = await analyzeReport(capture([row()]), { limits: { totalBodyBytes: 0 } });
    const sample = report.contexts[0].partitions[0].sample!;
    expect(sample.request.body.text).toBe('{"nested":{"value":"one"}}');
    expect(sample.response.body).toMatchObject({ text: 'accepted', truncated: false });
    const limited = await analyzeReport(capture([row()]), {
      limits: { totalBodyBytes: 0 },
      reportLimits: { rereadBytes: 0 },
    });
    expect(limited.contexts[0].partitions[0].sample?.response.body).toMatchObject({
      state: 'omitted',
      truncated: true,
    });
  });

  it('keeps all partition summaries when global report budgets omit evidence', async () => {
    const report = await analyzeReport(await fixture(), {
      reportLimits: { evidenceChars: 0, variationEntries: 0 },
    });
    expect(report.contexts[0].partitions.map((p) => p.requestCount)).toEqual([3, 1]);
    expect(report.coverage).toMatchObject({
      samplesIncluded: 0,
      samplesOmitted: 2,
      variationPartitionsIncluded: 0,
      variationPartitionsOmitted: 2,
    });
    for (const partition of report.contexts[0].partitions) {
      expect(partition.sample).toBeNull();
      expect(partition.variations.coverage.state).toBe('omitted');
      expect(partition.sampleOmittedReason).toContain('budget');
    }
  });

  it('bounds variation work across partitions rather than resetting a budget for each partition', async () => {
    const report = await analyzeReport(await fixture(), { reportLimits: { variationEntries: 4 } });
    expect(report.contexts[0].partitions[0].variations.coverage.state).toBe('available');
    expect(report.contexts[0].partitions[1].variations.coverage.state).toBe('omitted');
  });

  it('accounts for serialized samples and variations against one finite evidence budget', async () => {
    const report = await analyzeReport(await fixture(), { reportLimits: { evidenceChars: 1000 } });
    const partitions = report.contexts.flatMap((c) => c.partitions);
    const included = partitions.reduce(
      (sum, p) =>
        sum +
        (p.sample ? JSON.stringify(p.sample).length : 0) +
        (p.variations.coverage.state !== 'omitted' ? JSON.stringify(p.variations).length : 0),
      0,
    );
    expect(included).toBeLessThanOrEqual(1000);
    expect(report.coverage).toMatchObject({ samplesIncluded: 1, samplesOmitted: 1 });
  });

  it('marks method-specific input evidence as partial when a partition contains multiple methods', async () => {
    const report = await analyzeReport(capture([row('one'), row('two', {}, { method: 'PUT' })]));
    expect(report.contexts[0].methods).toEqual(['POST', 'PUT']);
    expect(report.contexts[0].partitions[0].variations.coverage).toMatchObject({
      state: 'partial',
      comparedRequests: 1,
    });
  });

  it('reports skipped entries and handles empty captures', async () => {
    const skipped = await analyzeReport(capture([null, row()]));
    expect(skipped.summary).toMatchObject({
      capturedRequests: 2,
      analyzedRequests: 1,
      skippedRequests: 1,
    });
    const unavailable = skipped.contexts.find((c) => c.label === 'Skipped entries')!;
    expect(unavailable.methods).toEqual([]);
    expect(unavailable.partitions[0].sample?.request).toMatchObject({ method: null, url: null });
    expect(unavailable.partitions[0].sample?.warnings).toContain('Invalid HAR entry.');
    expect(unavailable.partitions[0].variations.coverage.state).toBe('omitted');
    const empty = await analyzeReport(capture([]));
    expect(empty.contexts).toEqual([]);
    expect(empty.summary.responsePartitions).toBe(0);
  });
});

it('rejects invalid report budgets before analyzing and honors cooperative cancellation', async () => {
  for (const reportLimits of [
    { bodyChars: -1 },
    { evidenceChars: Infinity },
    { rereadBytes: 0.5 },
    { unknown: 2 },
    { toString: 2 },
    null,
  ])
    await expect(
      analyzeReport(new Blob(['invalid']), { reportLimits } as ReportOptions),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
  await expect(
    analyzeReport(await fixture(), { signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ code: 'ABORTED' });
  const analysis = await analyze(await fixture());
  await expect(buildReport(analysis, { signal: AbortSignal.abort() })).rejects.toMatchObject({
    code: 'ABORTED',
  });
});

describe('public API report evidence', () => {
  const capture = (entries: unknown[]) => new Blob([JSON.stringify({ log: { entries } })]);

  const row = (text = 'ok', mimeType = 'text/plain', request = {}) => ({
    request: { method: 'POST', url: 'https://example.test/items', headers: [], ...request },
    response: { status: 200, headers: [], content: { mimeType, text } },
  });

  const literalValues = ['["first","second"]', '["third","fourth"]'];

  const multipart = (value: string) =>
    `--demo\r\nContent-Disposition: form-data; name="name"\r\n\r\n${value}\r\n--demo--\r\n`;

  it.each([
    ['request', 0],
    ['response', 1],
    ['both', 1],
  ] as const)('counts only oversized response bodies when %s is limited', async (side, count) => {
    const report = await analyzeReport(
      capture([
        row(side === 'request' ? 'ok' : 'oversized', 'text/plain', {
          postData: { mimeType: 'text/plain', text: side === 'response' ? 'ok' : 'oversized' },
        }),
      ]),
      { limits: { bodyBytes: 4 } },
    );
    expect(report.summary.limitedResponseBodies).toBe(count);
  });

  it.each(['Form', 'Multipart'] as const)(
    'preserves literal JSON-looking %s strings',
    async (format) => {
      const report = await analyzeReport(
        capture(
          literalValues.map((value) =>
            row('ok', 'text/plain', {
              postData:
                format === 'Form'
                  ? {
                      mimeType: 'application/x-www-form-urlencoded',
                      text: `name=${encodeURIComponent(value)}`,
                    }
                  : { mimeType: 'multipart/form-data; boundary=demo', text: multipart(value) },
            }),
          ),
        ),
      );
      const field = report.contexts[0].partitions[0].variations.fields.find(
        (f) => f.category === format && f.key === '/name/0/value',
      );
      expect(field?.values.map((value) => [value.value, value.format])).toEqual(
        literalValues.map((value) => [value, 'text']),
      );
    },
  );

  it.each(['Query', 'Header', 'Cookie'] as const)(
    'retains the %s vector representation when values are truncated',
    async (category) => {
      const report = await analyzeReport(
        capture(
          ['x'.repeat(600), 'short'].map((value) =>
            row('ok', 'text/plain', {
              url:
                category === 'Query'
                  ? `https://example.test/items?name=${value}`
                  : 'https://example.test/items',
              headers:
                category === 'Header'
                  ? [{ name: 'name', value }]
                  : category === 'Cookie'
                    ? [{ name: 'Cookie', value: `name=${value}` }]
                    : [],
            }),
          ),
        ),
      );
      const field = report.contexts[0].partitions[0].variations.fields.find(
        (f) => f.category === category && f.key === 'name',
      );
      expect(field?.values).toMatchObject([
        { value: ['x'.repeat(512)], format: 'values', truncated: true },
        { value: ['short'], format: 'values', truncated: false },
      ]);
    },
  );
});

describe('protocol failure reporting', () => {
  const capture = () =>
    new Blob([
      JSON.stringify({
        log: {
          entries: [200, 200, 200, 403, 0].map((status) => ({
            time: status === 0 ? 5000 : 25,
            request: {
              method: 'GET',
              url: 'https://example.test/?s=cve',
              httpVersion: status === 0 ? 'HTTP/3.0' : 'HTTP/2.0',
              headers: [],
            },
            response: {
              status,
              statusText: status === 0 ? 'Network Error' : 'OK',
              headers: status === 0 ? null : [],
              content:
                status === 0
                  ? { mimeType: 'application/octet-stream' }
                  : { mimeType: 'text/plain', text: status === 200 ? 'accepted' : 'denied' },
            },
          })),
        },
      }),
    ]);

  it('prioritizes failed protocol observations within the shared report budget', async () => {
    const report = await analyzeReport(capture(), { reportLimits: { variationEntries: 5 } });
    const partitions = report.contexts[0].partitions;
    const failed = partitions.find((p) => p.statuses[0] === null)!;
    expect(partitions.map((p) => p.requestCount)).toEqual([3, 1, 1]);
    expect(failed.variations.coverage.state).toBe('available');
    expect(failed.variations.fields[0]).toMatchObject({
      category: 'Endpoint',
      key: 'HTTP version',
      values: [{ value: 'HTTP/3.0', requestCount: 1 }],
    });
    expect(failed.variations.fields.some((f) => f.category === 'Query')).toBe(false);
    expect(report.coverage.variationPartitionsIncluded).toBe(1);
    expect(report.coverage.variationPartitionsOmitted).toBe(2);
  });

  it('preserves the captured failure details while classifying the protocol difference', async () => {
    const report = await analyzeReport(capture());
    const failed = report.contexts[0].partitions.find((p) => p.statuses[0] === null)!;
    expect(failed.sample?.response).toMatchObject({ status: null, statusText: 'Network Error' });
    expect(failed.sample?.request.httpVersion).toBe('HTTP/3.0');
    expect(failed.variations.fields[0]).toMatchObject({
      category: 'Endpoint',
      key: 'HTTP version',
    });
  });

  it('honors a zero comparison budget even for failed requests', async () => {
    const report = await analyzeReport(capture(), { reportLimits: { variationEntries: 0 } });
    expect(
      report.contexts[0].partitions.every((p) => p.variations.coverage.state === 'omitted'),
    ).toBe(true);
  });
});

describe('response reflection templates', () => {
  const capture = (rows: unknown[]) => new Blob([JSON.stringify({ log: { entries: rows } })]);

  const row = (value: string, mime: string, text: string) => ({
    request: {
      method: 'GET',
      url: `https://example.test/echo?q=${encodeURIComponent(value)}`,
      headers: [],
    },
    response: { status: 400, headers: [], content: { mimeType: mime, text } },
  });

  const values = [1, 2, 3].map((i) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${i}`);

  it('exports heuristic report grouping with original samples and all input variations', async () => {
    const rows = values.map((v) =>
      row(v, 'application/json', JSON.stringify({ echo: 'Rejected ' + v, accepted: false })),
    );
    const report = await analyzeReport(capture(rows));
    expect(report.summary.responsePartitions).toBe(1);
    const partition = report.contexts[0].partitions[0];
    expect(partition.grouping).toMatchObject({ basis: 'inferred-reflection', heuristic: true });
    expect(partition.sample?.response.body.text).toBe(rows[0].response.content.text);
    expect(
      partition.variations.fields.find((field) => field.category === 'Query' && field.key === 'q')
        ?.distinctValues,
    ).toBe(3);
  });
});

it('keeps reports independently mutable without changing retained grouping evidence', async () => {
  const analysis = await analyze(
    capture([row('one', { content: { mimeType: 'text/plain', text: '{"ok":true}' } })]),
  );
  const report = await buildReport(analysis);
  const rules = report.contexts[0].partitions[0].grouping.normalizations!;
  expect(rules).toEqual(['detected-json']);
  rules.length = 0;
  expect((await buildReport(analysis)).contexts[0].partitions[0].grouping.normalizations).toEqual([
    'detected-json',
  ]);
  expect(groupPage(analysis, 'outcomes', 0, '').rows[0].normalizations).toEqual(['detected-json']);
});
