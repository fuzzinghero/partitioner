import { expect, it, describe } from 'vitest';
import { analyze, analyzeReport, groupPage, requestChangesComplete } from './core.js';
import { analyze as analyzeInternal } from './analyze.js';

const origin = 'https://example.test';
const capture = (entries: unknown[]) => new Blob([JSON.stringify({ log: { entries } })]);
const row = (
  url: string,
  headers = [{ name: 'Host', value: 'example.test' }],
  comment?: string,
) => ({
  request: { method: 'GET', url, headers, httpVersion: 'HTTP/2.0' },
  response: {
    status: 200,
    headers: [{ name: 'Content-Type', value: 'text/plain' }],
    content: { mimeType: 'text/plain', text: 'accepted' },
  },
  comment,
});
const target = (path: string, authority = 'example.test') =>
  JSON.stringify({
    meta: { target_scheme: 'https', target_authority: authority, target_path: path },
  });

it('uses captured targets for report and UI contexts while preserving Host mutations and raw URLs', async () => {
  const path = '/?url=one';
  const rows = [
    row(origin + path),
    row(path, undefined, target(path)),
    row(path, [{ name: 'Host', value: '127.0.0.1' }], target(path)),
    row(path, [{ name: 'Host', value: 'http://other.test/' }], target(path)),
  ];
  const input = capture(rows);
  const report = await analyzeReport(input);
  expect(report.contexts).toHaveLength(1);
  expect(report.contexts[0]).toMatchObject({
    label: origin + '/',
    requestCount: 4,
    partitionCount: 1,
  });
  const analysis = await analyze(input);
  expect(groupPage(analysis, 'endpoints', 0, '').rows[0].scope).toBe(origin + '/');
  expect(analysis.entries.map((entry) => entry.url)).toEqual(
    rows.map((entry) => entry.request.url),
  );
  expect(analysis.entries[3].requestHeaders).toEqual(rows[3].request.headers);
  expect(analysis.entries[1]).not.toHaveProperty('contextUrl');
  const relativeOnly = await analyzeReport(capture(rows.slice(1)));
  expect(relativeOnly.contexts[0].label).toBe(origin + '/');
  expect(relativeOnly.contexts[0].partitions[0].sample?.request.url).toBe(path);
  const changes = await requestChangesComplete(analysis, 2);
  expect(changes.changes.some((field) => field.kind === 'Header' && field.key === 'host')).toBe(
    true,
  );
  expect(
    changes.changes.some((field) => field.kind === 'Path' && (field.distinctValues ?? 0) > 1),
  ).toBe(false);
});

it.each(['HTTP/2.0', 'HTTP/3.0'])(
  'resolves %s pseudo headers without requiring Host',
  async (httpVersion) => {
    const path = '/items?x=%2F';
    const relative = row(path, [
      { name: ':scheme', value: 'https' },
      { name: ':authority', value: 'EXAMPLE.TEST:443' },
      { name: ':path', value: path },
    ]);
    relative.request.httpVersion = httpVersion;
    const analysis = await analyze(capture([row(origin + path), relative]));
    expect(analysis.endpoints).toHaveLength(1);
    expect(analysis.endpoints[0].label).toBe(origin + '/items');
    expect(analysis.entries[1].url).toBe(path);
    expect(analysis.entries[1].diagnostics).toBeUndefined();
  },
);

it('resolves Host with a captured scheme and accepts protocol target metadata', async () => {
  const path = '/items';
  const report = await analyzeReport(
    capture([
      row(origin + path),
      row(path, [
        { name: ':scheme', value: 'https' },
        { name: 'Host', value: 'example.test' },
      ]),
      row(
        path,
        [],
        JSON.stringify({
          meta: {
            protocol_scheme: 'https',
            protocol_authority: 'example.test',
            protocol_path: path,
          },
        }),
      ),
    ]),
  );
  expect(report.contexts).toHaveLength(1);
  expect(report.contexts[0].requestCount).toBe(3);
});

it('keeps origins and schemes distinct and preserves literal paths during family inference', async () => {
  const report = await analyzeReport(
    capture([
      row(origin + '/users/1'),
      row('/users/2', undefined, target('/users/2')),
      row('/users/3', undefined, target('/users/3', 'other.test')),
      row('http://example.test/users/1'),
    ]),
  );
  expect(report.contexts.map((context) => [context.label, context.requestCount])).toEqual([
    [origin + '/users/{param2}', 2],
    ['https://other.test/users/3', 1],
    ['http://example.test/users/1', 1],
  ]);
  const analysis = await analyze(
    capture([row(origin + '/users/1'), row('/users/2', undefined, target('/users/2'))]),
  );
  const changes = await requestChangesComplete(analysis, 1);
  expect(
    changes.changes
      .find((field) => field.kind === 'Path' && field.key === 'Segment 2')
      ?.examples.map((example) => example.value),
  ).toEqual(['1', '2']);
});

it.each([
  '{invalid',
  JSON.stringify({
    meta: { target_scheme: 'https', target_authority: 'example.test', target_path: '/different' },
  }),
  target('/items', 'user@example.test'),
  target('/items', 'example.test/path'),
  target('/items', 'example.test\\other'),
  target('/items', 'example.test?query'),
  target('/items', 'example.test\r\n'),
  JSON.stringify({
    meta: { target_scheme: 'file', target_authority: 'example.test', target_path: '/items' },
  }),
  target('/items') + ' '.repeat(8192),
])('does not use malformed, unrelated, or excessive target metadata: %#', async (comment) => {
  const report = await analyzeReport(capture([row('/items', [], comment)]));
  expect(report.contexts[0].label).toBe('/items');
});

it.each([
  [
    { name: ':scheme', value: 'https' },
    { name: ':authority', value: 'example.test' },
    { name: 'Host', value: 'other.test' },
  ],
  [
    { name: ':scheme', value: 'https' },
    { name: ':authority', value: 'example.test' },
    { name: ':authority', value: 'other.test' },
  ],
  [
    { name: ':scheme', value: 'https' },
    { name: ':scheme', value: 'http' },
    { name: ':authority', value: 'example.test' },
  ],
])('keeps conflicting authority evidence unresolved: %#', async (headers) => {
  const report = await analyzeReport(capture([row('/items', headers)]));
  expect(report.contexts[0].label).toBe('/items');
});

it('resolves legacy HTTP/1.1 Host-only targets and records the assumed scheme', async () => {
  const path = '/login';
  const relative = row(path, [{ name: 'Host', value: 'example.test' }], 'opaque legacy comment');
  relative.request.httpVersion = 'HTTP/1.1';
  const analysis = await analyze(
    capture([
      relative,
      row('http://example.test' + path, [{ name: 'Host', value: 'example.test' }]),
    ]),
  );
  expect(analysis.endpoints).toHaveLength(1);
  expect(groupPage(analysis, 'endpoints', 0, '').rows[0].scope).toBe('http://example.test/login');
  expect(analysis.entries[0].url).toBe(path);
  expect(analysis.entries[0].requestHeaders).toEqual(relative.request.headers);
  expect(analysis.entries[0].diagnostics).toContain(
    'Request context assumes HTTP because no scheme was captured.',
  );
  const report = await analyzeReport(capture([relative]));
  expect(report.contexts[0].label).toBe('http://example.test/login');
  expect(report.contexts[0].partitions[0].sample?.request.url).toBe(path);
});

it.each([
  [{ name: 'Host', value: 'user@example.test' }],
  [{ name: 'Host', value: 'http://example.test/' }],
  [
    { name: 'Host', value: 'example.test' },
    { name: 'Host', value: 'other.test' },
  ],
  [
    { name: ':authority', value: 'example.test' },
    { name: 'Host', value: 'other.test' },
  ],
  [
    { name: ':scheme', value: 'file' },
    { name: 'Host', value: 'example.test' },
  ],
])('does not assume HTTP for invalid or ambiguous authority evidence: %#', async (headers) => {
  const report = await analyzeReport(capture([row('/items', headers)]));
  expect(report.contexts[0].label).toBe('/items');
});

it('uses explicit HTTPS metadata ahead of the Host-only HTTP fallback', async () => {
  const analysis = await analyze(capture([row('/items', undefined, target('/items'))]));
  expect(analysis.endpoints[0].label).toBe(origin + '/items');
  expect(analysis.entries[0].diagnostics).toBeUndefined();
});

it('leaves absolute URLs authoritative and honors explicit context associations', async () => {
  const rows = [
    row(origin + '/items', [], target('/items', 'other.test')),
    row('/items', [], target('/items')),
  ];
  const report = await analyzeReport(capture(rows));
  expect(report.contexts.map((context) => context.label)).toEqual([origin + '/items']);
  const explicit = await analyzeReport(capture(rows), { contexts: [[0], [1]] });
  expect(explicit.contexts.map((context) => context.label)).toEqual([
    'Provided context 1',
    'Provided context 2',
  ]);
});

describe('capture boundary cases', () => {
  const exchange = (text = '{}', mime = 'application/json') => ({
    request: {
      method: 'GET',
      url: 'https://example.test/items',
      headers: [] as { name: string; value: string }[],
    },
    response: {
      status: 200,
      headers: [] as { name: string; value: string }[],
      content: { text, mimeType: mime },
    },
  });

  const capture = (rows: unknown[]) => new Blob([JSON.stringify({ log: { entries: rows } })]);

  it('recognizes a valid HTTP/2 root target and equivalent default-port authorities', async () => {
    const row = {
      ...exchange(),
      request: {
        ...exchange().request,
        url: 'https://EXAMPLE.test:443',
        httpVersion: 'HTTP/2',
        headers: [
          { name: 'Host', value: 'example.test' },
          { name: ':authority', value: 'EXAMPLE.TEST:443' },
          { name: ':path', value: '/' },
          { name: ':method', value: 'GET' },
        ],
      },
    };
    const result = await analyzeInternal(capture([row]));
    expect(result.entries[0].diagnostics).toBeUndefined();
  });
});
