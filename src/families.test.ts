// @vitest-environment node
import { it, expect, describe } from 'vitest';
import { analyze } from './analyze.js';
import { requestChanges } from './request-analysis.js';

const row = (url: string, status = 200, body = '{}', extra: Record<string, unknown> = {}) => ({
  request: { method: 'GET', url, ...extra },
  response: {
    status,
    headers: [
      { name: 'Date', value: new Date(1700000000000 + Math.random() * 1000000).toUTCString() },
    ],
    content: { mimeType: 'application/json', text: body },
  },
});
const run = (entries: unknown[]) => analyze(new Blob([JSON.stringify({ log: { entries } })]));
describe('Useful endpoint partitions and selective variance', () => {
  it('infers numeric and UUID parameters including nested positions but keeps named endpoints/origins separate', async () => {
    const a = await run(
      [
        'https://example.invalid/users/1/orders/10',
        'https://example.invalid/users/2/orders/11',
        'https://example.invalid/login',
        'https://example.invalid/logout',
        'https://other.invalid/users/1/orders/10',
      ].map((url) => row(url)),
    );
    expect(a.endpoints).toHaveLength(4);
    expect(a.entries[0].family).toBe('https://example.invalid/users/{param2}/orders/{param4}');
    expect(a.entries[0].outcome).toBe(a.entries[1].outcome);
    const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
    const b = await run(ids.map((id) => row(`https://example.invalid/users/${id}`)));
    expect(b.endpoints).toHaveLength(1);
    expect(requestChanges(b, 0).changes[0].kind).toBe('Path');
  });
  it('does not collide with a literal template-looking path', async () => {
    const a = await run(
      ['/users/1', '/users/2', '/users/{param2}'].map((path) =>
        row(`https://example.invalid${path}`),
      ),
    );
    expect(a.endpoints).toHaveLength(3);
  });
  it('attaches recognizable terminal endpoint fuzzing only to an observed parent', async () => {
    const a = await run(
      ['/api/items', '/api/items/%27', '/api/items/%00', '/api/admin'].map((path) =>
        row(`https://example.invalid${path}`),
      ),
    );
    expect(a.endpoints).toHaveLength(2);
    expect(a.endpoints[0].members).toHaveLength(3);
    expect(a.entries[3].family).toBe('https://example.invalid/api/admin');
  });
});

it('uses the longest repeated endpoint anchor for direct and multi-segment fuzz suffixes', async () => {
  const paths = [
    '/api/items',
    '/api/items',
    '/api/items/check',
    '/api/items/check',
    '/api/items/check<script>',
    '/api/items/check/%2e%2e%2f%2f/example.invalid',
    '/api/items/check/..;https://example.invalid/a',
    '/api/items/check//example.invalid',
    '/api/items/check/%09/next',
    '/api/items/checks',
    '/api/other',
  ];
  const result = await run(paths.map((path) => row('https://service.invalid' + path)));
  expect(result.entries.slice(2, 9).map((e) => e.family)).toEqual(
    Array(7).fill('https://service.invalid/api/items/check'),
  );
  expect(result.entries[9].family).toBe('https://service.invalid/api/items/checks');
  expect(result.entries[10].family).toBe('https://service.invalid/api/other');
});

it('does not infer a direct suffix anchor from a singleton, a named neighbor, another origin or query syntax', async () => {
  const urls = [
    'https://routes.invalid/api/item',
    'https://routes.invalid/api/item<script>',
    'https://routes.invalid/api/list',
    'https://routes.invalid/api/list',
    'https://routes.invalid/api/listing<script>',
    'https://other.invalid/api/list<script>',
    'https://routes.invalid/api/listing?q=%3Cscript%3E',
  ];
  const result = await run(urls.map((url) => row(url)));
  expect(result.endpoints).toHaveLength(6);
  expect(result.entries[4].family).toBe(urls[4]);
  expect(result.entries[5].family).toBe(urls[5]);
  expect(result.entries[6].family).toBe('https://routes.invalid/api/listing');
});

it('recognizes an absolute-URL payload appended directly to a repeated endpoint', async () => {
  const result = await run(
    ['/api/check', '/api/check', '/api/checkhttps://example.invalid/x'].map((path) =>
      row('https://direct.invalid' + path),
    ),
  );
  expect(result.endpoints).toHaveLength(1);
});
