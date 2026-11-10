// @vitest-environment node
import { expect, it, vi, describe } from 'vitest';
import { analyze, memberPage, groupPage } from './analyze.js';
import {
  requestChanges,
  requestChangesComplete,
  requestScope,
  REQUEST_ANALYSIS_LIMITS,
  createRequestIndex,
  indexRequest,
} from './request-analysis.js';
import { STRUCTURE_LIMITS } from './structured.js';
import {
  analyze as analyzeCore,
  requestChanges as requestChangesCore,
  requestChangesComplete as requestChangesCompleteCore,
  analyzeReport,
} from './core.js';
import type { AnalyzeOptions } from './types.js';
import { Buffer } from 'node:buffer';

const request = (overrides = {}) => ({
  method: 'POST',
  url: 'https://example.invalid/items?q=one',
  headers: [{ name: 'X-Test', value: 'one' }],
  postData: { mimeType: 'application/json', text: '{"name":"one","n":9007199254740993}' },
  ...overrides,
});
const capture = (requests: unknown[]) =>
  new Blob([
    JSON.stringify({
      log: {
        entries: requests.map((req) => ({
          request: req,
          response: { status: 200, content: { mimeType: 'application/json', text: '{}' } },
        })),
      },
    }),
  ]);

it('reports container-to-value transitions as JSON fields alongside their children', async () => {
  const parent = request({
    postData: { mimeType: 'application/json', text: '{"value":{"nested":1}}' },
  });
  const result = await analyze(
    capture([
      parent,
      parent,
      request({ postData: { mimeType: 'application/json', text: '{"value":[]}' } }),
    ]),
  );
  expect(requestChanges(result, 2).current?.changes.filter((c) => c.kind === 'JSON')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: '/value', reference: '{"nested":1}', observed: '[]' }),
      expect.objectContaining({ key: '/value/nested', reference: '1', observed: undefined }),
    ]),
  );
});

it('groups JSON samples by exact full paths while preserving visually similar wire keys', async () => {
  const body = (value: string) =>
    JSON.stringify({
      order_id: value,
      'order_id ': value,
      'order_id\n': value,
      reference: value,
      'reference\u0000': value,
      'reference\\u0000': value,
      nested: { order_id: value },
    });
  const result = await analyze(
    capture(
      ['first', 'second'].map((value) =>
        request({ postData: { mimeType: 'application/json', text: body(value) } }),
      ),
    ),
  );
  const evidence = requestChanges(result, 1);
  const fields = evidence.changes.filter((change) => change.kind === 'JSON');
  expect(fields.map((field) => field.key).sort()).toEqual(
    [
      '/order_id',
      '/order_id ',
      '/order_id\n',
      '/reference',
      '/reference\u0000',
      '/reference\\u0000',
      '/nested/order_id',
    ].sort(),
  );
  expect(new Set(fields.map((field) => field.id)).size).toBe(7);
  for (const field of fields) {
    expect(field.examples).toEqual([
      { entry: 0, count: 1, value: '"first"', truncated: false },
      { entry: 1, count: 1, value: '"second"', truncated: false },
    ]);
    expect(evidence.current?.changes.find((change) => change.id === field.id)).toMatchObject({
      key: field.key,
      observed: '"second"',
    });
  }
  result.requestIndex!.rows.clear();
  expect(await requestChangesComplete(result, 1)).toEqual(evidence);
});

it('presents query and body changes using customer categories and meaningful fields', async () => {
  const base = request({ postData: { mimeType: 'text/plain', text: 'old' } });
  const changed = request({
    url: 'https://example.invalid/items?q=two',
    postData: { mimeType: 'application/octet-stream', text: 'new' },
  });
  const result = await analyze(capture([base, base, changed]));
  expect(requestChanges(result, 2).current?.changes.map((c) => [c.kind, c.key])).toEqual([
    ['Query', 'q'],
    ['Body', 'Content type'],
  ]);
  expect(requestChanges(result, 2).contrasts?.[0].changes.find((c) => c.key === 'q')).toMatchObject(
    {
      kind: 'Query',
      reference: '["one"]',
      observed: '["two"]',
    },
  );
});

it('selects a literal Query string parameter consistently across views and rereads', async () => {
  const result = await analyze(
    capture([
      request({ url: 'https://example.invalid/items?Query%20string=one' }),
      request({ url: 'https://example.invalid/items?Query%20string=two' }),
    ]),
  );
  const evidence = requestChanges(result, 1);
  const query = evidence.contrasts![0].changes.filter(
    (c) => c.kind === 'Query' && c.key === 'Query string',
  );
  expect(query.map((c) => c.observed)).toEqual(['["two"]']);
  expect(query.map((c) => c.id)).toEqual(['["Query parameter","Query string"]']);
  expect(query.every((c) => typeof c.id === 'string' && c.id.length > 0)).toBe(true);
  const field = query.find((c) => c.observed === '["two"]')!;
  expect(evidence.current?.changes.find((c) => c.key === 'Query string')?.id).toBe(field.id);
  expect(evidence.changes.find((c) => c.key === 'Query string')?.id).toBe(field.id);
  result.requestIndex!.rows.clear();
  expect(await requestChangesComplete(result, 1)).toEqual(evidence);
});

it('bounds aggregate query reread bytes while keeping indexed comparisons and reporting incomplete coverage', async () => {
  const large = 'x'.repeat(17 * 1024 ** 2);
  const entries = [0, 1, 2].map((id) => ({
    request: request({ url: `https://example.invalid/items?q=${id}` }),
    response: {
      status: 200,
      content: { mimeType: 'text/plain', text: id === 2 ? 'small' : large },
    },
  }));
  const file = new Blob([JSON.stringify({ log: { entries } })]);
  const result = await analyze(file, { limits: { bodyBytes: 64 } });
  result.requestIndex!.rows.delete(0);
  result.requestIndex!.rows.delete(1);
  result.requestIndex!.limited = true;
  const slice = vi.spyOn(file, 'slice');
  const evidence = await requestChangesComplete(result, 2);
  expect(slice).toHaveBeenCalledTimes(1);
  const bytes = slice.mock.calls.reduce(
    (sum, [start = 0, end = file.size]) => sum + end - start,
    0,
  );
  expect(bytes).toBeLessThanOrEqual(32 * 1024 ** 2);
  expect(evidence.incomplete).toBeGreaterThan(0);
  expect(evidence.contrastsLimited).toBe(true);
  expect(evidence.changes).toEqual([]);
  expect(evidence.current?.changes).toEqual([]);
  expect(evidence.contrasts?.[0]).toMatchObject({ reference: 0, comparison: 2, causal: false });
});

it('bounds the number of small source entries reread by one query', async () => {
  const file = capture(
    Array.from({ length: 1002 }, (_, id) =>
      request({ url: `https://example.invalid/items?q=${id}` }),
    ),
  );
  const result = await analyze(file);
  result.requestIndex!.rows.clear();
  result.requestIndex!.limited = true;
  const slice = vi.spyOn(file, 'slice');
  const evidence = await requestChangesComplete(result, 1001);
  expect(slice).toHaveBeenCalledTimes(1000);
  expect(evidence.incomplete).toBeGreaterThan(0);
  expect(evidence.contrastsLimited).toBe(true);
  expect(evidence.changes).toEqual([]);
});

describe('Observed request changes', () => {
  it('indexes methods, exact query values, duplicate headers, JSON values and field presence across one literal path', async () => {
    const result = await analyze(
      capture([
        request(),
        request({
          url: 'https://example.invalid/items?q=two&q=three',
          headers: [
            { name: 'x-test', value: 'two' },
            { name: 'X-Test', value: 'three' },
          ],
          postData: { mimeType: 'application/json', text: '{"n":9007199254740992,"added":null}' },
        }),
      ]),
    );
    const changes = requestChanges(result, 0);
    expect(changes.entries).toBe(2);
    expect(changes.changes.map((c) => [c.kind, c.key])).toEqual(
      expect.arrayContaining([
        ['Query', 'q'],
        ['Header', 'x-test'],
        ['JSON', '/n'],
        ['JSON', '/name'],
        ['JSON', '/added'],
      ]),
    );
    expect(changes.changes.find((c) => c.key === '/n')?.examples.map((e) => e.value)).toEqual([
      '9007199254740993',
      '9007199254740992',
    ]);
    expect(changes.changes.find((c) => c.key === 'x-test')?.examples[1].value).toBe(
      '["two","three"]',
    );
    expect(changes.changes.find((c) => c.key === '/name')?.present).toBe(1);
    expect(result.endpoints).toHaveLength(1); // Source method and URL remain intact; analysis groups by family.
    expect(groupPage(result, 'outcomes', 0, '').rows.map((r) => r.scope)).toEqual([
      'https://example.invalid/items',
    ]);
  });
  it('keeps missing, malformed, oversized and duplicate-key body data out of field absence inferences', async () => {
    const result = await analyze(
      capture([
        request(),
        request({ postData: {} }),
        request({ postData: { mimeType: 'application/json', text: '{bad' } }),
        request({ postData: { mimeType: 'application/json', text: '{"a":1,"a":2}' } }),
        request({
          postData: { mimeType: 'application/json', text: ' '.repeat(STRUCTURE_LIMITS.bytes + 1) },
        }),
      ]),
    );
    const resultChanges = requestChanges(result, 0);
    expect(resultChanges.changes.some((c) => c.kind === 'JSON')).toBe(false);
    expect(resultChanges.incomplete).toBeGreaterThan(0);
  });
  it('signals retention and work exhaustion without claiming complete change coverage', async () => {
    const result = await analyze(capture([request()]));
    const index = createRequestIndex();
    index.bytes = REQUEST_ANALYSIS_LIMITS.retainedBytes;
    indexRequest(index, result.entries[0], { request: request() });
    expect(index.limited).toBe(true);
    expect(index.rows.size).toBe(0);
    expect(requestChanges({ ...result, requestIndex: index }, 0).incomplete).toBeGreaterThan(0);
    const work = createRequestIndex();
    work.work = REQUEST_ANALYSIS_LIMITS.work;
    indexRequest(work, result.entries[0], { request: request() });
    expect(work.limited).toBe(true);
    expect(requestChanges({ ...result, requestIndex: work }, 0).changes).toHaveLength(0);
  });
  it('retains HAR-only form parameters and metadata without inventing missing file bodies', async () => {
    const result = await analyze(
      capture(
        ['a', 'b'].map((value) =>
          request({
            postData: {
              mimeType: 'multipart/form-data',
              params: [
                { name: 'field', value },
                { name: 'upload', fileName: `${value}.txt`, contentType: 'text/plain' },
              ],
            },
          }),
        ),
      ),
    );
    const changes = requestChanges(result, 0).changes;
    expect(changes.find((c) => c.key === '/field/0/value')?.examples.map((e) => e.value)).toEqual([
      'a',
      'b',
    ]);
    expect(changes.some((c) => c.key === '/upload/0/value')).toBe(false);
    expect(changes.some((c) => c.key === '/upload/0/@filename')).toBe(true);
  });
  it('retains captured body evidence and reports media types when structured fields are not comparable', async () => {
    const result = await analyze(
      capture([
        request(),
        request({ postData: { mimeType: 'application/xml', text: '<r>one</r>' } }),
        request({ postData: { mimeType: 'application/json', text: '' } }),
      ]),
    );
    const changes = requestChanges(result, 0).changes;
    expect(result.entries.map((entry) => entry.requestBody.text)).toEqual([
      '{"name":"one","n":9007199254740993}',
      '<r>one</r>',
      '',
    ]);
    expect(new Set(result.entries.map((entry) => entry.requestBody.hash)).size).toBe(3);
    expect(changes.find((c) => c.key === 'Content type')?.examples.map((e) => e.value)).toEqual([
      'application/xml',
    ]);
    expect(changes.some((c) => c.kind === 'JSON')).toBe(false);
  });
  it('keeps unassociated sibling paths and encoded path differences separate', async () => {
    const result = await analyze(
      capture(
        ['/items/one', '/items/two', '/items/%74wo', '/other/two'].map((path) =>
          request({ url: 'https://example.invalid' + path }),
        ),
      ),
    );
    expect(result.endpoints).toHaveLength(4);
    expect(requestScope('https://example.invalid/items/../other?q=1').url).toBe(
      'https://example.invalid/items/../other',
    );
  });
  it('limits examples without dropping entry navigation and anchors requests beyond page one', async () => {
    const result = await analyze(
      capture(
        Array.from({ length: 60 }, (_, i) =>
          request({ postData: { mimeType: 'application/json', text: `{"name":${i}}` } }),
        ),
      ),
    );
    const change = requestChanges(result, 0).changes.find((c) => c.key === '/name')!;
    expect(change.examples).toHaveLength(REQUEST_ANALYSIS_LIMITS.examples);
    expect(change.moreValues).toBe(true);
    expect(change.present).toBe(60);
    const page = memberPage(result, result.entries[55].outcome, 'outcomes', 0, '', '', 55);
    expect(page.page).toBe(1);
    expect(page.rows.some((e) => e.id === 55)).toBe(true);
    expect(page.total).toBe(60);
  });
});

describe('Representative request contrasts', () => {
  const row = (query: string, status = 403, overrides = {}) => ({
    request: {
      method: 'GET',
      url: `https://example.invalid/items?${query}`,
      headers: [],
      queryString: [],
      ...overrides,
    },
    response: { status, headers: [], content: { mimeType: 'application/json', text: '{}' } },
  });
  const analyzeRows = (entries: unknown[], options = {}) =>
    analyze(new Blob([JSON.stringify({ log: { entries } })]), undefined, undefined, options);

  it('replaces an early distant request with a later closer request from the same partition', async () => {
    const result = await analyzeRows([
      row('q=far&a=2&b=2'),
      row('q=target&a=1&b=2'),
      row('q=target&a=1&b=1', 200),
    ]);
    const retained = requestChanges(result, 2);
    const evidence = retained.contrasts!;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      reference: 1,
      comparison: 2,
      complete: true,
      causal: false,
    });
    expect(
      evidence[0].changes.filter((change) => change.kind === 'Query').map((change) => change.key),
    ).toEqual(['b']);
    result.requestIndex!.rows.clear();
    expect(await requestChangesComplete(result, 2)).toEqual(retained);
  });

  it('prefers a complete contrast over an apparently closer request with missing headers', async () => {
    const result = await analyzeRows([
      row('q=other&a=1', 403, { headers: undefined }),
      row('q=other&a=2'),
      row('q=target&a=1', 200),
    ]);
    expect(requestChanges(result, 2).contrasts?.[0]).toMatchObject({
      reference: 1,
      complete: true,
    });
  });

  it('retains identical-input response variation alongside changed inputs within five slots', async () => {
    const result = await analyzeRows([
      row('q=target'),
      row('q=changed'),
      ...Array.from({ length: 6 }, (_, index) => row(`q=variant${index}`, 404 + index)),
      row('q=target', 200),
    ]);
    const contrasts = requestChanges(result, 8).contrasts!;
    expect(contrasts).toHaveLength(5);
    expect(contrasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reference: 0,
          changes: [],
          complete: true,
          responseChanged: true,
          causal: false,
        }),
        expect.objectContaining({ reference: 1, complete: true, responseChanged: true }),
      ]),
    );
  });

  it('does not count raw query serialization as a second semantic mutation when ranking examples', async () => {
    const result = await analyzeRows(
      [
        row('q=target', 403, { method: 'POST', url: 'https://example.invalid/other?q=target' }),
        row('q=changed'),
        row('q=target', 200),
      ],
      { contexts: [[0, 1, 2]] },
    );
    expect(requestChanges(result, 2).contrasts?.map((contrast) => contrast.reference)).toEqual([
      1, 0,
    ]);
  });

  it('reports selection exhaustion while keeping bounded examples and usable field summaries', async () => {
    const entries = Array.from({ length: 600 }, (_, index) =>
      row(
        Array.from({ length: 180 }, (_, field) => `q${field}=${field === 0 ? index : 'same'}`).join(
          '&',
        ),
      ),
    );
    entries.push(row(Array.from({ length: 180 }, (_, field) => `q${field}=same`).join('&'), 200));
    const result = await analyzeRows(entries);
    const evidence = requestChanges(result, 600);
    expect(evidence.contrastsLimited).toBe(true);
    expect(evidence.contrasts?.length).toBeLessThanOrEqual(5);
    expect(evidence.contrasts?.[0]).toMatchObject({ reference: 0, complete: true });
    expect(evidence.changes.some((change) => change.kind === 'Query' && change.key === 'q0')).toBe(
      true,
    );
    expect(evidence.incomplete).toBe(0);
  });
});

it('reserves contrast-search work for other response partitions after a large same-partition cohort', async () => {
  const request = (value: string) => ({
    method: 'GET',
    url:
      'https://example.invalid/items?' +
      Array.from({ length: 180 }, (_, field) => `q${field}=${field === 0 ? value : 'same'}`).join(
        '&',
      ),
    headers: [],
    queryString: [],
  });
  const entries = Array.from({ length: 600 }, (_, index) => ({
    request: request(String(index)),
    response: { status: 200, headers: [], content: { mimeType: 'text/plain', text: 'Accepted' } },
  }));
  entries.push({
    request: request('different'),
    response: { status: 403, headers: [], content: { mimeType: 'text/plain', text: 'Denied' } },
  });
  entries.push({
    request: request('selected'),
    response: { status: 200, headers: [], content: { mimeType: 'text/plain', text: 'Accepted' } },
  });
  const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
  const evidence = requestChanges(result, 601);
  expect(evidence.contrasts?.[0]).toMatchObject({
    reference: 600,
    responseChanged: true,
    complete: true,
  });
  expect(evidence.contrastsLimited).toBe(true);
});

it('reports individual cookie removal only when response peers have known captured headers', async () => {
  const withCookie = request({ headers: [{ name: 'Cookie', value: 'role=admin' }] });
  const result = await analyze(capture([withCookie, withCookie, request({ headers: [] })]));
  expect(requestChanges(result, 2).current?.changes).toContainEqual(
    expect.objectContaining({
      kind: 'Cookie',
      key: 'role',
      observed: undefined,
      reference: '["admin"]',
    }),
  );
  const unknown = await analyze(capture([withCookie, withCookie, request({ headers: undefined })]));
  expect(requestChanges(unknown, 2).current?.changes.some((c) => c.kind === 'Cookie')).toBe(false);
  const malformed = await analyze(
    capture([
      withCookie,
      withCookie,
      request({ headers: [{ name: 'Cookie', value: 'role="unterminated' }] }),
    ]),
  );
  expect(requestChanges(malformed, 2).current?.changes.some((c) => c.kind === 'Cookie')).toBe(
    false,
  );
});

it.each([
  'consent={"necessary":true}',
  'name=two words',
  'name=one,two',
  'nameless',
  'name=value;',
])(
  'preserves complete raw request contrasts when optional Cookie parsing rejects %s',
  async (value) => {
    const result = await analyze(
      capture([
        request({ headers: [{ name: 'Cookie', value: 'role=admin' }] }),
        request({ headers: [{ name: 'Cookie', value }] }),
      ]),
    );
    const contrast = requestChanges(result, 1).contrasts?.find((c) => c.reference === 0);
    expect(contrast?.complete).toBe(true);
    expect(contrast?.changes).toContainEqual(
      expect.objectContaining({ kind: 'Header', key: 'cookie', observed: JSON.stringify([value]) }),
    );
    expect(contrast?.changes.some((c) => c.kind === 'Cookie')).toBe(false);
  },
);

it('does not mark complete captured requests incomplete for cookie-array disagreement or exporter omission', async () => {
  const common = { headers: [{ name: 'Cookie', value: 'sid="abc123"' }] };
  for (const cookies of [
    [{ name: 'sid', value: '"abc123"' }],
    [{ name: 'sid', value: 'different' }],
    undefined,
  ]) {
    const result = await analyze(
      capture([
        request({ ...common, cookies: [{ name: 'sid', value: 'abc123' }] }),
        request({ ...common, cookies }),
      ]),
    );
    expect(requestChanges(result, 1).contrasts?.every((c) => c.complete)).toBe(true);
    expect(result.requestIndex!.rows.get(1)!.categories.has('Incomplete')).toBe(false);
    expect(result.entries[1].requestHeaders).toEqual(common.headers);
    const different = cookies?.[0].value === 'different';
    expect(
      result.entries[1].diagnostics?.some((d) => /conflict.*HAR cookies/.test(d)) ?? false,
    ).toBe(different);
    expect(result.requestIndex!.rows.get(1)!.categories.get('Cookie')?.get('sid')).toBe(
      '["abc123"]',
    );
    expect(result.requestIndex!.rows.get(1)!.sources?.get('Cookie')).toBe('headers');
  }
});

describe('request body representations', () => {
  const cases = [
    {
      mime: 'application/xml',
      texts: ['<r>a\rb</r>', '<r>a&#13;b</r>'],
      childValues: ['a\nb', 'a\rb'],
    },
    { mime: 'application/xml', texts: ['<r>&#X41;</r>', '<r>A</r>'] },
    {
      mime: 'application/xml',
      texts: [
        '<!DOCTYPE r SYSTEM "local.dtd"><r>one</r>',
        '<!DOCTYPE r SYSTEM "local.dtd"><r>two</r>',
      ],
    },
    {
      mime: 'multipart/form-data; boundary=x',
      texts: [
        '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\none\r\n--x\r\nContent-Disposition: form-data; name="b"\r\n\r\ntwo\r\n--x--\r\n',
        '--x\r\nContent-Disposition: form-data; name="b"\r\n\r\ntwo\r\n--x\r\nContent-Disposition: form-data; name="a"\r\n\r\none\r\n--x--\r\n',
      ],
    },
    {
      mime: 'multipart/form-data; boundary=x; boundary=y',
      texts: [
        '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\none\r\n--x--\r\n',
        '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\ntwo\r\n--x--\r\n',
      ],
    },
  ];

  const capture = (entries: unknown[]) => new Blob([JSON.stringify({ log: { entries } })]);

  it.each(cases)(
    'groups $mime by exact bytes and preserves actionable request differences',
    async ({ mime, texts, childValues }) => {
      const response = (text: string) => ({
        status: 200,
        headers: [],
        content: { mimeType: mime, text },
      });
      const request = (text?: string) => ({
        method: 'POST',
        url: 'https://example.test/',
        headers: [],
        ...(text === undefined ? {} : { postData: { mimeType: mime, text } }),
      });
      const responses = await analyzeCore(
        capture(
          [...texts, texts[0]].map((text) => ({ request: request(), response: response(text) })),
        ),
      );
      expect(responses.outcomes.map((group) => group.members)).toEqual([[0, 2], [1]]);
      const requests = await analyzeCore(
        capture(
          texts.map((text) => ({
            request: request(text),
            response: { status: 200, headers: [], content: { mimeType: 'text/plain', text: 'ok' } },
          })),
        ),
      );
      for (const evidence of [
        requestChangesCore(requests, 1),
        await requestChangesCompleteCore(requests, 1),
      ])
        expect(
          evidence.changes
            .find((change) =>
              childValues
                ? change.kind === 'XML' && change.key === '/r/0/#text/0'
                : change.kind === 'Body' && change.key === 'Content',
            )
            ?.examples.map((example) => example.value),
        ).toEqual(childValues ?? texts);
      expect(requests.entries.map((entry) => entry.requestBody.text)).toEqual(texts);
    },
  );

  it('keeps simultaneous multipart header and value differences in portable body samples', async () => {
    const texts = ['first', 'second'].map(
      (value) =>
        `--x\r\nContent-Disposition: form-data; name="a"\r\nX-Part: ${value}\r\n\r\n${value}\r\n--x--\r\n`,
    );
    const report = await analyzeReport(
      capture(
        texts.map((text) => ({
          request: {
            method: 'POST',
            url: 'https://example.test/',
            headers: [],
            postData: { mimeType: 'multipart/form-data; boundary=x', text },
          },
          response: { status: 200, headers: [], content: { mimeType: 'text/plain', text: 'ok' } },
        })),
      ),
    );
    expect(
      report.contexts[0].partitions[0].variations.fields
        .find((field) => field.category === 'Multipart' && field.key === '/a/0/value')
        ?.values.map((value) => value.value),
    ).toEqual(['first', 'second']);
    expect(report.contexts[0].partitions[0].sample?.request.body.text).toBe(texts[0]);
  });
});

describe('Content-Length evidence', () => {
  const row = (length: string, text: string, extra = {}) => ({
    method: 'POST',
    url: 'https://example.test/items',
    headers: [{ name: 'Content-Length', value: length }],
    postData: { mimeType: 'text/plain', text },
    ...extra,
  });

  const run = (requests: unknown[], options?: AnalyzeOptions) =>
    analyze(
      new Blob([
        JSON.stringify({
          log: {
            entries: requests.map((request) => ({
              request,
              response: {
                status: 200,
                headers: [],
                content: { mimeType: 'text/plain', text: 'OK' },
              },
            })),
          },
        }),
      ]),
      options,
    );

  const lengthField = (change: { kind: string; key: string }) =>
    change.kind === 'Header' && change.key === 'content-length';

  it.each(['POST', 'GET'])(
    'uses UTF-8 byte lengths to present meaningful %s header changes',
    async (method) => {
      const analysis = await run([
        ...Array.from({ length: 8 }, () => row('1', 'a', { method })),
        row('2', 'é', { method }),
        row('2', '猫', { method }),
      ]);
      const accurate = requestChanges(analysis, 8);
      const mismatch = requestChanges(analysis, 9);
      expect(analysis.entries[8].requestBody.bytes).toBe(2);
      expect(analysis.entries[9].requestBody.bytes).toBe(3);
      expect(analysis.entries[8].requestHeaders).toEqual([{ name: 'Content-Length', value: '2' }]);
      expect(accurate.current?.changes.filter(lengthField)).toEqual([]);
      expect(
        accurate.contrasts
          ?.filter((contrast) => contrast.reference < 9)
          .flatMap((contrast) => contrast.changes)
          .filter(lengthField),
      ).toEqual([]);
      expect(mismatch.current?.changes.find(lengthField)).toMatchObject({
        observed: '["2"]',
        reference: '["1"]',
      });
      // The closest actual request has the same declared length and different body bytes.
      expect(mismatch.contrasts?.[0]).toMatchObject({ reference: 8, comparison: 9 });
      expect(mismatch.changes.find(lengthField)).toMatchObject({
        affected: 1,
        distinctValues: 1,
        examples: [{ entry: 9, count: 1, value: '["2"]', truncated: false }],
      });
      analysis.requestIndex!.rows.clear();
      expect(await requestChangesComplete(analysis, 8)).toEqual(accurate);
      expect(await requestChangesComplete(analysis, 9)).toEqual(mismatch);
    },
  );

  it('uses decoded base64 bytes for length verification', async () => {
    const analysis = await run([
      row('1', '', {
        postData: { mimeType: 'application/octet-stream', encoding: 'base64', text: 'YQ==' },
      }),
      row('2', '', {
        postData: { mimeType: 'application/octet-stream', encoding: 'base64', text: 'YWI=' },
      }),
    ]);
    const evidence = requestChanges(analysis, 1);
    expect(analysis.entries[1].requestBody.bytes).toBe(2);
    expect(evidence.changes.filter(lengthField)).toEqual([]);
    expect(evidence.current?.changes.filter(lengthField)).toEqual([]);
    expect(evidence.contrasts?.flatMap((contrast) => contrast.changes).filter(lengthField)).toEqual(
      [],
    );
    analysis.requestIndex!.rows.clear();
    expect(await requestChangesComplete(analysis, 1)).toEqual(evidence);
  });

  it('distinguishes captured empty bodies from unavailable GET bodies', async () => {
    const analysis = await run([
      ...Array.from({ length: 8 }, () => row('1', 'a', { method: 'GET' })),
      row('0', '', { method: 'GET' }),
      row('0', '', { method: 'GET', postData: undefined }),
    ]);
    expect(analysis.entries[8].requestBody.bytes).toBe(0);
    expect(requestChanges(analysis, 8).current?.changes.filter(lengthField)).toEqual([]);
    expect(requestChanges(analysis, 9).changes.find(lengthField)?.examples).toEqual([
      { entry: 9, count: 1, value: '["0"]', truncated: false },
    ]);
  });

  it('retains unverifiable length changes after body analysis limits are reached', async () => {
    const analysis = await run([row('1', 'a'), row('1', 'a'), row('2', 'é')], {
      limits: { bodyBytes: 1 },
    });
    expect(analysis.entries[2].requestBody.state).toBe('limited');
    expect(requestChanges(analysis, 2).changes.find(lengthField)?.examples[0]).toMatchObject({
      entry: 2,
      value: '["2"]',
      count: 1,
    });
  });

  it.each([
    ['missing body', { postData: undefined }],
    [
      'exporter form metadata',
      {
        postData: {
          mimeType: 'application/x-www-form-urlencoded',
          params: [{ name: 'a', value: 'b' }],
        },
      },
    ],
    [
      'invalid body encoding',
      { postData: { mimeType: 'text/plain', text: 'é', encoding: 'unknown' } },
    ],
    [
      'compressed body',
      {
        headers: [
          { name: 'Content-Length', value: '2' },
          { name: 'Content-Encoding', value: 'gzip' },
        ],
      },
    ],
    [
      'transfer framing',
      {
        headers: [
          { name: 'Content-Length', value: '2' },
          { name: 'Transfer-Encoding', value: 'chunked' },
        ],
      },
    ],
    [
      'duplicate length',
      {
        headers: [
          { name: 'Content-Length', value: '2' },
          { name: 'content-length', value: '2' },
        ],
      },
    ],
    ['malformed length', { headers: [{ name: 'Content-Length', value: '+2' }] }],
    ['combined lengths', { headers: [{ name: 'Content-Length', value: '2, 2' }] }],
  ])('preserves %s as visible length evidence', async (_label, extra) => {
    const analysis = await run([row('1', 'a'), row('1', 'a'), row('2', 'é', extra)]);
    const evidence = requestChanges(analysis, 2);
    expect(evidence.changes.find(lengthField)?.examples[0].entry).toBe(2);
    expect(evidence.current?.changes.find(lengthField)).toMatchObject({ reference: '["1"]' });
    expect(evidence.contrasts?.flatMap((contrast) => contrast.changes).some(lengthField)).toBe(
      true,
    );
  });

  it('keeps length removal in contrasts when the body without a length is unavailable', async () => {
    const analysis = await run([
      row('1', 'a'),
      row('1', 'a', { headers: [], postData: undefined }),
    ]);
    for (const evidence of [
      requestChanges(analysis, 1),
      await requestChangesComplete(analysis, 1),
    ]) {
      expect(
        evidence.contrasts?.flatMap((contrast) => contrast.changes).find(lengthField),
      ).toMatchObject({ reference: '["1"]' });
    }
  });
});

describe('public API request evidence', () => {
  const capture = (entries: unknown[]) => new Blob([JSON.stringify({ log: { entries } })]);

  const row = (text = 'ok', mimeType = 'text/plain', request = {}) => ({
    request: { method: 'POST', url: 'https://example.test/items', headers: [], ...request },
    response: { status: 200, headers: [], content: { mimeType, text } },
  });

  const multipart = (value: string) =>
    `--demo\r\nContent-Disposition: form-data; name="name"\r\n\r\n${value}\r\n--demo--\r\n`;

  const formats = [
    {
      mime: 'application/x-www-form-urlencoded',
      body: (v: string) => `name=${encodeURIComponent(v)}`,
      key: '/name/0/value',
      example: 'one',
    },
    {
      mime: 'application/json',
      body: (v: string) => JSON.stringify({ name: v }),
      key: '/name',
      example: '"one"',
    },
    {
      mime: 'application/xml',
      body: (v: string) => `<root><name>${v}</name></root>`,
      key: '/root/0/name/0/#text/0',
      example: 'one',
    },
    {
      mime: 'multipart/form-data; boundary=demo',
      body: multipart,
      key: '/name/0/value',
      example: 'one',
    },
  ];

  it.each(formats)(
    'compares decoded $mime evidence before and after body eviction',
    async ({ mime, body, key, example }) => {
      for (const totalBodyBytes of [0, 10000]) {
        const entries = ['one', 'two'].map((value) =>
          row('ok', 'text/plain', {
            postData: {
              mimeType: mime,
              encoding: 'base64',
              text: Buffer.from(body(value)).toString('base64').replace(/.{4}/g, '$&\n'),
            },
          }),
        );
        const analysis = await analyzeCore(capture(entries), { limits: { totalBodyBytes } });
        const local = requestChangesCore(analysis, 0);
        for (const evidence of [local, await requestChangesCompleteCore(analysis, 0)]) {
          const field = evidence.changes.find((change) => change.key === key);
          expect(field?.examples[0]).toMatchObject({ entry: 0, value: example, count: 1 });
          expect(field?.distinctValues).toBe(2);
        }
      }
    },
  );
});

describe('empty JSON request bodies', () => {
  const capture = async (request: Record<string, unknown>) => {
    const normal = {
      method: 'POST',
      url: 'https://example.test/orders',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      postData: { mimeType: 'application/json', text: '{"order_id":1001}' },
    };
    return analyze(
      new Blob([
        JSON.stringify({
          log: {
            entries: [normal, normal, request].map((r, i) => ({
              request: r,
              response: {
                status: i === 2 ? 400 : 200,
                content: { mimeType: 'text/plain', text: i === 2 ? 'missing body' : 'ok' },
              },
            })),
          },
        }),
      ]),
    );
  };

  const empty = {
    method: 'POST',
    url: 'https://example.test/orders',
    bodySize: 0,
    headers: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Content-Length', value: '0' },
    ],
  };

  it('reports a confirmed zero-length JSON request alongside requests with JSON bodies', async () => {
    const analysis = await capture(empty);
    const result = await requestChangesComplete(analysis, 2);
    expect(
      result.changes.find((field) => field.kind === 'JSON' && field.key === '')?.examples,
    ).toEqual([{ entry: 2, count: 1, value: '', truncated: false, state: 'empty-body' }]);
  });

  it.each([
    { ...empty, bodySize: -1 },
    { ...empty, headers: [{ name: 'Content-Type', value: 'application/json' }] },
    { ...empty, headers: [...empty.headers, { name: 'Transfer-Encoding', value: 'chunked' }] },
    { ...empty, postData: { mimeType: 'application/json', text: '{"order_id":2}' } },
  ])(
    'does not infer an empty body when capture evidence is insufficient or contradictory',
    async (request) => {
      const analysis = await capture(request);
      const result = await requestChangesComplete(analysis, 2);
      expect(
        result.changes
          .flatMap((field) => field.examples)
          .some((example) => example.state === 'empty-body'),
      ).toBe(false);
    },
  );
});

describe('evicted request evidence', () => {
  const har = (bodies: string[], mime: string) =>
    new Blob([
      JSON.stringify({
        log: {
          entries: bodies.map((text, index) => ({
            request: {
              method: 'POST',
              url: 'https://example.test/items',
              headers: [{ name: 'Content-Type', value: mime }],
              postData: { mimeType: mime, text },
            },
            response: {
              status: index === bodies.length - 1 ? 400 : 200,
              content: { mimeType: 'text/plain', text: index === bodies.length - 1 ? 'bad' : 'ok' },
            },
          })),
        },
      }),
    ]);

  it.each([
    {
      mime: 'text/plain',
      bodies: ['old', 'old', 'old', 'new'],
      kind: 'Body',
      key: 'Content',
      reference: 'old',
      observed: 'new',
    },
    {
      mime: 'application/json',
      bodies: ['{"x":{"a":1}}', '{"x":{"a":1}}', '{"x":{"a":1}}', '{"x":null}'],
      kind: 'JSON',
      key: '/x',
      reference: '{"a":1}',
      observed: 'null',
    },
  ])(
    'restores complete $kind evidence after capture-wide body eviction',
    async ({ mime, bodies, kind, key, reference, observed }) => {
      const file = har(bodies, mime);
      const full = await analyze(file);
      const evicted = await analyze(file, { limits: { totalBodyBytes: 0 } });
      expect(evicted.entries.every((entry) => entry.requestBody.evicted)).toBe(true);
      const expected = await requestChangesComplete(full, 3);
      const actual = await requestChangesComplete(evicted, 3);
      const find = (result: typeof actual) =>
        result.current?.changes.find((change) => change.kind === kind && change.key === key);
      expect(find(expected)).toMatchObject({ reference, observed });
      expect(find(actual)).toMatchObject({ reference, observed });
      expect(actual.contrasts?.flatMap((contrast) => contrast.changes)).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind, key, reference, observed })]),
      );
      expect(evicted.entries.every((entry) => entry.requestBody.text === undefined)).toBe(true);
    },
  );
});

describe('unavailable exporter fields', () => {
  const row = (text = '', extra = {}, responseExtra = {}) => ({
    request: {
      method: 'POST',
      url: 'https://example.invalid/items?q=one',
      headers: [],
      queryString: null,
      ...extra,
    },
    response: {
      status: 503,
      headers: null,
      content: { mimeType: 'text/html', text },
      ...responseExtra,
    },
  });

  const run = (entries: unknown[]) => analyzeCore(new Blob([JSON.stringify({ log: { entries } })]));

  it('does not treat null request headers as evidence of removed headers', async () => {
    const a = await run([
      ...Array.from({ length: 8 }, () => row('', { headers: [{ name: 'X-Test', value: 'one' }] })),
      row('', { headers: null }),
    ]);
    expect(requestChangesCore(a, 8).current?.changes.some((c) => c.kind === 'Header')).toBe(false);
    expect(requestChangesCore(a, 8).incomplete).toBeGreaterThan(0);
  });
});

describe('selective request variance', () => {
  const row = (
    url: string,
    status = 200,
    body = '{}',
    extra: Record<string, unknown> = {},
    date = 'Tue, 14 Nov 2023 22:13:20 GMT',
  ) => ({
    request: { method: 'GET', url, ...extra },
    response: {
      status,
      headers: [{ name: 'Date', value: date }],
      content: { mimeType: 'application/json', text: body },
    },
  });

  const run = (entries: unknown[]) => analyze(new Blob([JSON.stringify({ log: { entries } })]));

  it('merges matching responses across query/method changes and volatile response headers', async () => {
    const a = await run([
      row('https://example.invalid/search?q=1'),
      row(
        'https://example.invalid/search?q=2',
        200,
        '{}',
        { method: 'POST' },
        'Wed, 15 Nov 2023 22:13:20 GMT',
      ),
    ]);
    expect(a.outcomes).toHaveLength(1);
    expect(a.outcomes[0].members).toEqual([0, 1]);
    expect(a.entries[0].responseHeaders).not.toEqual(a.entries[1].responseHeaders);
    expect(a.entries[1].url).toContain('q=2');
    expect(a.entries[1].method).toBe('POST');
  });

  it('counts selective changes only in the selected partition, preserving duplicate occurrence counts', async () => {
    const base = Array.from({ length: 8 }, () =>
      row('https://example.invalid/search?q=normal', 200, '{}', {
        headers: [{ name: 'X-Request-Id', value: crypto.randomUUID() }],
      }),
    );
    const a = await run([
      ...base,
      row('https://example.invalid/search?q=attack', 403),
      row('https://example.invalid/search?q=attack', 403),
    ]);
    const changed = requestChanges(a, 8);
    const q = changed.changes.find((c) => c.key === 'q')!;
    expect(changed.entries).toBe(2);
    expect(changed.cohortEntries).toBe(10);
    expect(q.affected).toBe(2);
    expect(q.compared).toBe(2);
    expect(q.distinctValues).toBe(1);
    expect(q.examples[0].count).toBe(2);
    expect(changed.changes.some((c) => c.key === 'x-request-id')).toBe(false);
    expect(requestChanges(a, 0).changes.some((c) => c.key === 'q')).toBe(false);
  });

  it('does not mistake repeated modal values for independent mutations or claim a baseline in all-unique input', async () => {
    const a = await run(
      Array.from({ length: 6 }, (_, i) => row(`https://example.invalid/search?q=${i}`)),
    );
    const q = requestChanges(a, 0).changes.find((c) => c.key === 'q')!;
    expect(q.inference).toBe('variation');
    expect(q.distinctValues).toBe(6);
    expect(q.examples).toHaveLength(5);
    expect(q.moreValues).toBe(true);
  });

  it('paginates all family partitions without merging rare outcomes', async () => {
    const a = await run(
      Array.from({ length: 80 }, (_, i) =>
        row('https://example.invalid/search', 200, JSON.stringify({ [`key${i}`]: true })),
      ),
    );
    expect(a.outcomes).toHaveLength(80);
    expect(groupPage(a, 'outcomes', 0, '').rows).toHaveLength(50);
    expect(groupPage(a, 'outcomes', 1, '').rows).toHaveLength(30);
    expect(memberPage(a, a.outcomes[79].id, 'outcomes', 0, '', '').rows.map((e) => e.id)).toEqual([
      79,
    ]);
  });
});

describe('request hydration limits', () => {
  it('retains indexed query evidence when body hydration reaches its entry limit', async () => {
    const entries = Array.from({ length: 1001 }, (_, i) => ({
      request: {
        method: 'POST',
        url: `https://example.test/items?x=${i}`,
        headers: [],
        postData: { mimeType: 'text/plain', text: 'same' },
      },
      response: { status: 200, content: { mimeType: 'text/plain', text: 'ok' } },
    }));
    const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]), {
      limits: { totalBodyBytes: 0 },
    });
    const evidence = await requestChangesComplete(result, 0);
    expect(
      evidence.changes.find((change) => change.kind === 'Query' && change.key === 'x'),
    ).toMatchObject({ distinctValues: 1001 });
    expect(evidence.incomplete).toBeGreaterThan(0);
    expect(evidence.contrastsLimited).toBe(true);
  });
});

describe('Request provenance, method cohorts and simultaneous differences', () => {
  const request = (text = '{"name":"normal","keep":true}', extra = {}) => ({
    method: 'POST',
    url: 'https://example.invalid/items?q=normal',
    headers: [{ name: 'X-Test', value: 'normal' }],
    postData: { mimeType: 'application/json', text },
    ...extra,
  });

  const row = (req = request(), status = 200, text = '{"latitude":38.849}') => ({
    request: req,
    response: { status, content: { mimeType: 'application/json', text } },
  });

  const run = (entries: unknown[]) => analyze(new Blob([JSON.stringify({ log: { entries } })]));

  const normal = () => Array.from({ length: 8 }, () => row());

  it('never extracts response-only fields as request fields', async () => {
    const a = await run([row(), row(request(), 200, '{"latitude":0,"responseOnly":"x"}')]);
    expect(requestChanges(a, 0).changes).toEqual([]);
    for (const item of a.requestIndex!.rows.values())
      expect([...item.categories.values()].flatMap((fields) => [...fields.keys()])).not.toContain(
        '/latitude',
      );
  });

  it('does not suggest absence-only fields without a dominant reference', async () => {
    const a = await run([
      row(request(), 201),
      ...Array.from({ length: 3 }, (_, i) => row(request(JSON.stringify({ latitude: i })))),
    ]);
    const result = requestChanges(a, 0);
    expect(result.changes.some((field) => field.key === '/latitude')).toBe(false);
    expect(result.current?.changes.some((field) => field.key === '/latitude')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('(not present)');
  });

  it('reports supported removals with their common request value, not a fabricated sample', async () => {
    const a = await run([...normal(), row(request('{"keep":true}'), 400)]);
    const result = requestChanges(a, 8);
    expect(result.changes.some((field) => field.key === '/name')).toBe(false);
    expect(result.current?.changes.find((field) => field.key === '/name')).toMatchObject({
      observed: undefined,
      reference: '"normal"',
      inference: 'deviation',
    });
  });

  it('keeps body schemas within methods while making mixed response partitions navigable', async () => {
    const a = await run([
      ...normal(),
      row(request('{"latitude":1}', { method: 'PUT' })),
      row(request('{"latitude":2}', { method: 'PUT' })),
    ]);
    expect(a.outcomes).toHaveLength(1);
    const post = requestChanges(a, 0),
      put = requestChanges(a, 8);
    expect(post.methods).toEqual([
      { method: 'POST', count: 8, entry: 0 },
      { method: 'PUT', count: 2, entry: 8 },
    ]);
    expect(post.changes.some((field) => field.kind === 'JSON')).toBe(false);
    expect(put.entries).toBe(2);
    expect(put.partitionEntries).toBe(10);
    expect(put.current?.changes.find((field) => field.kind === 'Endpoint')).toMatchObject({
      key: 'Method',
      observed: 'PUT',
      reference: 'POST',
    });
    const methodField = put.changes.find((field) => field.kind === 'Endpoint');
    expect(methodField).toMatchObject({
      key: 'Method',
      examples: [{ entry: 8, count: 2, value: 'PUT', truncated: false }],
    });
    expect(
      put.contrasts
        ?.flatMap((contrast) => contrast.changes)
        .find((field) => field.kind === 'Endpoint'),
    ).toMatchObject({
      id: methodField?.id,
      key: 'Method',
      observed: 'PUT',
      reference: 'POST',
    });
    expect(put.changes.find((field) => field.key === '/latitude')?.examples).toHaveLength(2);
    expect(
      memberPage(a, a.entries[0].outcome, 'outcomes', 0, '', '', 9, 'PUT').rows.map(
        (entry) => entry.id,
      ),
    ).toEqual([8, 9]);
    a.requestIndex!.rows.clear();
    expect(await requestChangesComplete(a, 8)).toEqual(put);
  });

  it('retains multiple changes together and does not multiply affected-request counts', async () => {
    const changed = request('{"name":"altered","keep":false,"extra":"new"}', {
      url: 'https://example.invalid/items?q=altered',
      headers: [{ name: 'X-Test', value: 'altered' }],
    });
    const a = await run([...normal(), row(changed, 400), row(changed, 400)]);
    const result = requestChanges(a, 8);
    expect(result.entries).toBe(2);
    expect(result.current?.changes.map((field) => field.key)).toEqual(
      expect.arrayContaining(['q', 'x-test', '/name', '/keep', '/extra']),
    );
    for (const field of result.changes) {
      expect(field.affected).toBe(2);
      expect(field.distinctValues).toBe(1);
      expect(field.examples[0].count).toBe(2);
    }
    expect(result.current?.changes.find((field) => field.key === '/extra')).toMatchObject({
      observed: '"new"',
      reference: undefined,
      inference: 'deviation',
    });
  });

  it('keeps disjoint changes associated with the correct request in a shared outcome', async () => {
    const a = await run([
      ...normal(),
      row(request('{"name":"a","keep":true}'), 400),
      row(request(undefined, { url: 'https://example.invalid/items?q=b' }), 400),
    ]);
    const first = requestChanges(a, 8),
      second = requestChanges(a, 9);
    expect(first.current?.changes.map((field) => field.key)).toEqual(['/name']);
    expect(second.current?.changes.map((field) => field.key)).toEqual(['q']);
    expect(first.changes.find((field) => field.key === '/name')?.examples[0].entry).toBe(8);
    expect(first.changes.find((field) => field.key === 'q')?.examples[0].entry).toBe(9);
  });

  it.each([
    ['application/xml', '<r a="one"><b>one</b></r>', '<r a="two"><b>two</b></r>', 'XML'],
    ['application/x-www-form-urlencoded', 'a=one&b=one', 'a=two&b=two', 'Form'],
    [
      'multipart/form-data; boundary=x',
      '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\none\r\n--x\r\nContent-Disposition: form-data; name="b"\r\n\r\none\r\n--x--\r\n',
      '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\ntwo\r\n--x\r\nContent-Disposition: form-data; name="b"\r\n\r\ntwo\r\n--x--\r\n',
      'Multipart',
    ],
  ])('retains simultaneous input differences in %s', async (mimeType, base, changed, kind) => {
    const req = (text: string) => request('', { postData: { mimeType, text } });
    const a = await run([
      ...Array.from({ length: 8 }, () => row(req(base))),
      row(req(changed), 400),
    ]);
    const changes = requestChanges(a, 8).current?.changes;
    expect(changes).toHaveLength(2);
    expect(changes).toEqual(
      expect.arrayContaining(
        (kind === 'XML' ? ['/r/0/@a', '/r/0/b/0/#text/0'] : ['/a/0/value', '/b/0/value']).map(
          (key) => expect.objectContaining({ kind, key, reference: 'one', observed: 'two' }),
        ),
      ),
    );
    expect(a.entries[8].requestBody.text).toBe(changed);
  });

  it('bounds method controls and preserves method-specific paging and custom methods', async () => {
    const a = await run(
      Array.from({ length: 120 }, (_, i) =>
        row(request(undefined, { method: i < 60 ? 'POST' : `CUSTOM${i}` })),
      ),
    );
    const result = requestChanges(a, 119);
    expect(result.methodCount).toBe(61);
    expect(result.methods).toHaveLength(50);
    expect(result.methods?.some((method) => method.method === 'CUSTOM119')).toBe(true);
    expect(
      memberPage(a, a.entries[0].outcome, 'outcomes', 0, '', '', 55, 'POST').rows.map(
        (entry) => entry.id,
      ),
    ).toEqual(Array.from({ length: 10 }, (_, i) => i + 50));
    expect(
      memberPage(a, a.entries[0].outcome, 'outcomes', 0, '', '', undefined, 'CUSTOM110').rows[0].id,
    ).toBe(110);
  });

  it('does not interpret unavailable/malformed request fields as removals', async () => {
    for (const postData of [
      {},
      { mimeType: 'application/json', text: '{bad' },
      { mimeType: 'application/json', text: '{"bad":"\ud800"}' },
    ]) {
      const a = await run([...normal(), row(request('', { postData }), 400)]);
      expect(requestChanges(a, 8).current?.changes.some((field) => field.kind === 'JSON')).toBe(
        false,
      );
    }
  });
});

describe('request evidence presentation', () => {
  const capture = (mimeType: string, bodies: string[]) =>
    new Blob([
      JSON.stringify({
        log: {
          entries: bodies.map((text) => ({
            request: {
              method: 'POST',
              url: 'https://example.test/items',
              headers: [],
              postData: { mimeType, text },
            },
            response: { status: 200, headers: [], content: { mimeType: 'text/plain', text: 'OK' } },
          })),
        },
      }),
    ]);

  it('preserves JSON parent types for array indices and numeric object keys across rereads', async () => {
    const result = await analyze(
      capture(
        'application/json',
        ['one', 'two'].map((value) =>
          JSON.stringify({ users: [{ name: value }], '0': { name: value } }),
        ),
      ),
    );
    const evidence = requestChanges(result, 1);
    expect(evidence.changes.find((field) => field.key === '/users/0/name')).toMatchObject({
      pathTypes: ['object', 'array', 'object'],
    });
    expect(evidence.changes.find((field) => field.key === '/0/name')).toMatchObject({
      pathTypes: ['object', 'object'],
    });
    result.requestIndex!.rows.clear();
    expect(await requestChangesComplete(result, 1)).toEqual(evidence);
  });

  it('marks parent types unknown when the same JSON pointer traverses different containers', async () => {
    const result = await analyze(capture('application/json', ['["one"]', '{"0":"two"}']));
    expect(requestChanges(result, 1).changes.find((field) => field.key === '/0')).toMatchObject({
      pathTypes: ['unknown'],
    });
  });

  it('preserves XML ordering and text differences in complete body evidence', async () => {
    const bodies = ['<r><a>one</a><b/></r>', '<r><b/><a>two</a></r>'];
    const result = await analyze(capture('application/xml', bodies));
    const evidence = requestChanges(result, 1);
    expect(
      evidence.changes
        .find((field) => field.kind === 'XML' && field.key === '/r/0/a/0/#text/0')
        ?.examples.map((example) => example.value),
    ).toEqual(['one', 'two']);
    expect(evidence.changes.map(({ kind, key }) => ({ kind, key }))).toEqual([
      { kind: 'XML', key: '/r/0/a/0/#text/0' },
    ]);
    expect(result.entries.map((entry) => entry.requestBody.text)).toEqual(bodies);
  });

  it('explains opaque body differences without needing a parameter interpretation', async () => {
    const result = await analyze(capture('text/plain', ['old', 'new']));
    expect(
      requestChanges(result, 1)
        .changes.find((field) => field.kind === 'Body' && field.key === 'Content')
        ?.examples.map((sample) => sample.value),
    ).toEqual(['old', 'new']);
    expect(result.entries.map((entry) => entry.requestBody.text)).toEqual(['old', 'new']);
  });

  it('retains conflicting content-type sources even when their sets of values coincide', async () => {
    const types = ['text/plain; charset=utf-8', 'text/plain; charset=us-ascii'];
    const result = await analyze(
      new Blob([
        JSON.stringify({
          log: {
            entries: types.map((type, i) => ({
              request: {
                method: 'POST',
                url: 'https://example.test/items',
                headers: [{ name: 'Content-Type', value: type }],
                postData: { mimeType: types[1 - i], text: i ? 'two' : 'one' },
              },
              response: {
                status: 200,
                headers: [],
                content: { mimeType: 'text/plain', text: 'OK' },
              },
            })),
          },
        }),
      ]),
    );
    const evidence = requestChanges(result, 1);
    expect(evidence.contentTypeConflict).toBe(true);
    expect(evidence.notices).toContain(
      'Body content type metadata conflicts with the Content-Type header.',
    );
    expect(
      evidence.changes
        .find((field) => field.kind === 'Body' && field.key === 'Content type parameters')
        ?.examples.map((example) => example.value),
    ).toEqual([types[1], types[0]]);
  });
});

describe('complete request evidence', () => {
  const entry = (
    text: string,
    mimeType = 'application/json',
    status = 200,
    headers: { name: string; value: string }[] = [],
  ) => ({
    request: {
      method: 'POST',
      url: 'https://example.test/items',
      headers,
      postData: { mimeType, text },
      bodySize: 3,
    },
    response: { status, headers: [], content: { mimeType: 'text/plain', text: 'ok' } },
  });

  const run = (entries: unknown[]) => analyze(new Blob([JSON.stringify({ log: { entries } })]));

  it('shows actual JSON containers when a container is replaced by a scalar', async () => {
    const a = await run([entry('{"x":{"a":1}}'), entry('{"x":null}')]);
    const field = requestChanges(a, 1).changes.find((c) => c.kind === 'JSON' && c.key === '/x');
    expect(field?.examples.map((e) => e.value)).toEqual(['{"a":1}', 'null']);
  });

  it('does not duplicate changes on parent containers when a nested value changes', async () => {
    const a = await run([entry('{"x":{"a":1}}'), entry('{"x":{"a":2}}')]);
    const result = requestChanges(a, 1);
    expect(result.changes.filter((c) => c.kind === 'JSON').map((c) => c.key)).toEqual(['/x/a']);
    expect(
      result.contrasts
        ?.flatMap((c) => c.changes)
        .filter((c) => c.kind === 'JSON')
        .map((c) => c.key),
    ).toEqual(['/x/a']);
  });

  it('returns usable raw request body text and preserves multipart boundaries', async () => {
    const a = await run([
      entry('alpha', 'text/plain', 200, [
        { name: 'Content-Type', value: 'multipart/form-data; boundary=first' },
      ]),
      entry('beta', 'text/plain', 201, [
        { name: 'Content-Type', value: 'multipart/form-data; boundary=second' },
      ]),
    ]);
    const result = requestChanges(a, 1);
    expect(
      result.contrasts?.[0].changes.find((c) => c.kind === 'Body' && c.key === 'Content'),
    ).toMatchObject({ reference: 'alpha', observed: 'beta' });
    expect(
      result.contrasts?.[0].changes.find((c) => c.kind === 'Header' && c.key === 'content-type'),
    ).toMatchObject({
      reference: '["multipart/form-data; boundary=first"]',
      observed: '["multipart/form-data; boundary=second"]',
    });
    expect(a.entries[0].requestBodySize).toBe(3);
  });

  it('marks unavailable body contrasts incomplete instead of returning a fingerprint', async () => {
    const a = await run([entry('alpha', 'text/plain', 200), entry('beta', 'text/plain', 201)]);
    a.entries[0].requestBody.text = undefined;
    a.entries[0].requestBody.evicted = true;
    const result = requestChanges(a, 1);
    expect(result.contrasts?.[0].complete).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/[a-f0-9]{64}/);
  });

  it('retains reported request body sizes only when they are known', async () => {
    const known = entry('a');
    const unknown = entry('b');
    unknown.request.bodySize = -1;
    const empty = entry('c');
    empty.request.bodySize = 0;
    const result = await run([known, unknown, empty]);
    expect(result.entries.map((e) => e.requestBodySize)).toEqual([3, undefined, 0]);
  });

  it('returns parseable bounded repeated header and query value excerpts', async () => {
    const value = `${'b'.repeat(510)}😀"\\end`;
    const first = entry('x', 'text/plain', 200, [
      { name: 'X-Payload', value },
      { name: 'X-Payload', value: 'second' },
    ]);
    const second = entry('x', 'text/plain', 201, [{ name: 'X-Payload', value: 'normal' }]);
    first.request.url += `?q=${encodeURIComponent(value)}&q=second`;
    second.request.url += '?q=normal';
    const result = requestChanges(await run([first, second]), 1);
    const contrast = result.contrasts?.[0];
    for (const kind of ['Header', 'Query']) {
      const key = kind === 'Header' ? 'x-payload' : 'q';
      const change = contrast?.changes.find((c) => c.kind === kind && c.key === key);
      expect(change?.truncated).toBe(true);
      const captured = JSON.parse(change!.reference!);
      expect(captured).toEqual([value.slice(0, 512)]);
      expect(value.startsWith(captured[0])).toBe(true);
    }
  });

  it('retains small scalar changes when the JSON body is too large for container excerpts', async () => {
    const large = (value: string) => `{${' '.repeat(33000)}"flag":"${value}"}`;
    const result = requestChanges(await run([entry(large('no')), entry(large('yes'))]), 1);
    expect(
      result.changes
        .find((c) => c.kind === 'JSON' && c.key === '/flag')
        ?.examples.map((sample) => sample.value),
    ).toEqual(['"no"', '"yes"']);
    expect(result.incomplete).toBeGreaterThan(0);
    expect(
      result.contrasts?.[0].changes.find((c) => c.kind === 'JSON' && c.key === '/flag'),
    ).toMatchObject({ reference: '"no"', observed: '"yes"' });
  });

  it('does not call an unavailable large JSON container an absent scalar', async () => {
    const result = requestChanges(
      await run([entry('{"x":1}'), entry('{"x":1}'), entry(`{${' '.repeat(33000)}"x":{"a":2}}`)]),
      2,
    );
    expect(result.incomplete).toBeGreaterThan(0);
    expect(
      result.current?.changes.filter((change) => change.kind === 'JSON' && change.key === '/x'),
    ).toEqual([]);
    expect(result.contrasts?.[0].complete).toBe(false);
  });

  it('keeps individual captured header changes when header order and casing also differ', async () => {
    const a = entry('same', 'text/plain', 200, [
      { name: 'X-A', value: 'one' },
      { name: 'X-B', value: 'two' },
    ]);
    const b = entry('same', 'text/plain', 201, [
      { name: 'x-b', value: 'two' },
      { name: 'x-a', value: 'changed' },
    ]);
    const analysis = await run([a, b]);
    const evidence = requestChanges(analysis, 1);
    expect(analysis.entries[0].requestHeaders).toEqual(a.request.headers);
    expect(analysis.entries[1].requestHeaders).toEqual(b.request.headers);
    expect(
      evidence.changes
        .filter((change) => change.kind === 'Header')
        .map((change) => ({
          key: change.key,
          values: change.examples.map((sample) => JSON.parse(sample.value)),
        })),
    ).toEqual([{ key: 'x-a', values: [['changed']] }]);
    expect(
      evidence.current?.changes
        .filter((change) => change.kind === 'Header')
        .map((change) => ({
          key: change.key,
          observed: change.observed,
        })),
    ).toEqual([{ key: 'x-a', observed: '["changed"]' }]);
    expect(evidence.contrasts?.[0]).toMatchObject({
      complete: false,
      changes: [{ kind: 'Header', key: 'x-a', reference: '["one"]', observed: '["changed"]' }],
    });
    analysis.requestIndex!.rows.clear();
    expect(await requestChangesComplete(analysis, 1)).toEqual(evidence);
  });
});

describe('aggregate request evidence budgets', () => {
  it('retains query and distinct body evidence with many large request bodies', async () => {
    const prefix = 'x'.repeat(1024 * 1024);
    const entries = Array.from({ length: 14 }, (_, index) => ({
      request: {
        method: 'POST',
        url: `https://example.test/items?x=${index}`,
        headers: [{ name: 'Content-Type', value: 'text/plain' }],
        postData: { mimeType: 'text/plain', text: `${prefix}${index}` },
      },
      response: { status: 200, content: { mimeType: 'text/plain', text: 'ok' } },
    }));
    const analysis = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
    for (const result of [
      requestChanges(analysis, 13),
      await requestChangesComplete(analysis, 13),
    ]) {
      const query = result.changes.find((change) => change.kind === 'Query' && change.key === 'x');
      const body = result.changes.find(
        (change) => change.kind === 'Body' && change.key === 'Content',
      );
      expect(query?.distinctValues).toBe(14);
      expect(body?.distinctValues).toBe(14);
      expect(body?.examples).toHaveLength(5);
      expect(
        body?.examples.every(
          (example) => example.value === prefix.slice(0, 512) && example.truncated,
        ),
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain(analysis.entries[13].requestBody.hash!);
    }
  });

  it('compares full body identities even when excerpts share a prefix', async () => {
    const prefix = 'x'.repeat(1024);
    const bodies = [`${prefix}old`, `${prefix}old`, `${prefix}old`, `${prefix}new`];
    const entries = bodies.map((text, index) => ({
      request: {
        method: 'POST',
        url: 'https://example.test/items',
        headers: [{ name: 'Content-Type', value: 'text/plain' }],
        postData: { mimeType: 'text/plain', text },
      },
      response: {
        status: index === 3 ? 400 : 200,
        content: { mimeType: 'text/plain', text: index === 3 ? 'bad' : 'ok' },
      },
    }));
    const analysis = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
    const result = await requestChangesComplete(analysis, 3);
    expect(
      result.current?.changes.find((change) => change.kind === 'Body' && change.key === 'Content'),
    ).toMatchObject({
      reference: prefix.slice(0, 512),
      observed: prefix.slice(0, 512),
      truncated: true,
    });
    expect(
      result.changes.find((change) => change.kind === 'Body' && change.key === 'Content')?.examples,
    ).toEqual([{ entry: 3, count: 1, value: prefix.slice(0, 512), truncated: true }]);
  });
});

describe('request category overlap', () => {
  const capture = (mime: string, bodies: string[], queries?: string[]) =>
    new Blob([
      JSON.stringify({
        log: {
          entries: bodies.map((text, id) => ({
            request: {
              method: 'POST',
              url: `https://example.test/submit${queries ? `?${queries[id]}` : ''}`,
              headers: [],
              postData: { mimeType: mime, text },
            },
            response: {
              status: id === 2 ? 422 : 200,
              content: { mimeType: 'text/plain', text: id === 2 ? 'Rejected' : 'Accepted' },
            },
          })),
        },
      }),
    ]);

  const xml = (v: string) => `<r><item>${v}</item></r>`;

  const multipart = (v: string) =>
    `--x\r\nContent-Disposition: form-data; name="item"\r\n\r\n${v}\r\n--x--\r\n`;

  it.each([
    {
      mime: 'application/json',
      kind: 'JSON',
      key: '/item',
      body: (v: string) => JSON.stringify({ item: v }),
    },
    {
      mime: 'application/problem+json',
      kind: 'JSON',
      key: '/item',
      body: (v: string) => JSON.stringify({ item: v }),
    },
    {
      mime: 'application/x-www-form-urlencoded; charset=utf-8',
      kind: 'Form',
      key: '/item/0/value',
      body: (v: string) => `item=${v}`,
    },
    { mime: 'text/xml', kind: 'XML', key: '/r/0/item/0/#text/0', body: xml },
    { mime: 'application/soap+xml', kind: 'XML', key: '/r/0/item/0/#text/0', body: xml },
    {
      mime: 'multipart/form-data; boundary=x',
      kind: 'Multipart',
      key: '/item/0/value',
      body: multipart,
    },
  ])(
    'selects child references for $mime through eviction and reports',
    async ({ mime, kind, key, body }) => {
      const file = capture(mime, ['one', 'one', 'two'].map(body));
      const options = { limits: { totalBodyBytes: 0 } };
      const result = await requestChangesCompleteCore(await analyzeCore(file, options), 2);
      const expected = [[kind, key]];
      for (const changes of [result.changes, result.current!.changes, result.contrasts![0].changes])
        expect(changes.map((field) => [field.kind, field.key])).toEqual(expected);
      const report = await analyzeReport(file, options);
      expect(
        report.contexts[0].partitions
          .find((p) => p.statuses.includes(422))!
          .variations.fields.map((f) => [f.category, f.key]),
      ).toEqual(expected);
    },
  );

  it.each([
    {
      label: 'object addition',
      before: '{"keep":1}',
      after: '{"keep":1,"x":{"a":2}}',
      keys: ['/x/a'],
    },
    {
      label: 'object removal',
      before: '{"keep":1,"x":{"a":2}}',
      after: '{"keep":1}',
      keys: ['/x/a'],
    },
    { label: 'array addition', before: '{"keep":1}', after: '{"keep":1,"x":[2]}', keys: ['/x/0'] },
    {
      label: 'escaped sibling prefix',
      before: '{}',
      after: '{"x":{},"x/y":2}',
      keys: ['/x', '/x~1y'],
    },
    { label: 'empty object addition', before: '{}', after: '{"x":{}}', keys: ['/x'] },
    { label: 'container type replacement', before: '{"x":{}}', after: '{"x":[]}', keys: ['/x'] },
    {
      label: 'scalar to object',
      before: '{"x":null}',
      after: '{"x":{"a":2}}',
      keys: ['/x', '/x/a'],
    },
    {
      label: 'object to scalar',
      before: '{"x":{"a":2}}',
      after: '{"x":null}',
      keys: ['/x', '/x/a'],
      summaryKeys: ['/x'],
    },
  ])(
    'uses specific JSON references for $label',
    async ({ label, before, after, keys, summaryKeys }) => {
      const file = capture('application/json', [before, before, after]);
      for (const totalBodyBytes of [0, 32 * 1024 * 1024]) {
        const options = { limits: { totalBodyBytes } };
        const result = await requestChangesCompleteCore(await analyzeCore(file, options), 2);
        for (const changes of [result.current!.changes, result.contrasts![0].changes])
          expect(
            changes
              .filter((c) => c.kind === 'JSON')
              .map((c) => c.key)
              .sort(),
          ).toEqual([...keys].sort());
        // Summary samples contain observed values; an absent value has no sample.
        const observedKeys = summaryKeys ?? (label === 'object removal' ? [] : keys);
        expect(
          result.changes
            .filter((c) => c.kind === 'JSON')
            .map((c) => c.key)
            .sort(),
        ).toEqual([...observedKeys].sort());
        if (totalBodyBytes > 0) {
          const report = await analyzeReport(file, options);
          expect(
            report.contexts[0].partitions
              .find((p) => p.statuses.includes(422))!
              .variations.fields.filter((f) => f.category === 'JSON')
              .map((f) => f.key)
              .sort(),
          ).toEqual([...observedKeys].sort());
        }
      }
    },
  );

  it.each([
    { label: 'value mutation', queries: ['q=one', 'q=one', 'q=two'], keys: ['q'] },
    {
      label: 'literal Query string name',
      queries: ['Query%20string=one', 'Query%20string=one', 'Query%20string=two'],
      keys: ['Query string'],
    },
    {
      label: 'encoding-only mutation',
      queries: ['q=a%20b', 'q=a%20b', 'q=a+b'],
      keys: ['Query string'],
    },
    {
      label: 'malformed query fallback',
      queries: ['q=%ZZ', 'q=%ZZ', 'q=%XX'],
      keys: ['Query string'],
    },
  ])('uses specific query references for $label', async ({ queries, keys }) => {
    const file = capture('text/plain', ['same', 'same', 'same'], queries);
    const result = await requestChangesCompleteCore(await analyzeCore(file), 2);
    for (const changes of [result.changes, result.current!.changes, result.contrasts![0].changes])
      expect(changes.filter((c) => c.kind === 'Query').map((c) => c.key)).toEqual(keys);
  });

  it.each(['text/plain', 'text/html'])(
    'retains Body fallback for opaque %s requests',
    async (mime) => {
      const result = await requestChangesCompleteCore(
        await analyzeCore(capture(mime, ['one', 'one', 'two'])),
        2,
      );
      for (const changes of [result.changes, result.current!.changes, result.contrasts![0].changes])
        expect(changes.map((c) => [c.kind, c.key])).toEqual([['Body', 'Content']]);
    },
  );
});

describe('request container budgets', () => {
  const makeEntries = (count: number) =>
    Array.from({ length: count }, (_, index) => {
      let body: unknown = {
        pad1: 'x'.repeat(6000),
        pad2: 'x'.repeat(6000),
        pad3: 'x'.repeat(6000),
        pad4: 'x'.repeat(6000),
        changed: index,
      };
      for (let depth = 0; depth < 22; depth++) body = { child: body };
      return {
        request: {
          method: 'POST',
          url: `https://example.test/items?x=${index}`,
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          postData: { mimeType: 'application/json', text: JSON.stringify(body) },
        },
        response: { status: 200, content: { mimeType: 'text/plain', text: 'ok' } },
      };
    });

  it.each([30, 70])(
    'preserves query and leaf evidence for %s deeply nested JSON requests',
    async (count) => {
      const analysis = await analyze(
        new Blob([JSON.stringify({ log: { entries: makeEntries(count) } })]),
      );
      for (const result of [
        requestChanges(analysis, 0),
        await requestChangesComplete(analysis, 0),
      ]) {
        expect(
          result.changes.find((field) => field.kind === 'Query' && field.key === 'x')
            ?.distinctValues,
        ).toBe(count);
        const leaf = `${'/child'.repeat(22)}/changed`;
        expect(
          result.changes.find((field) => field.kind === 'JSON' && field.key === leaf)
            ?.distinctValues,
        ).toBe(count);
      }
    },
  );

  it('deduplicates the same nested object across different parent documents', async () => {
    const entries = ['one', 'two', 'three'].map((other) => ({
      request: {
        method: 'POST',
        url: 'https://example.test/items',
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        postData: {
          mimeType: 'application/json',
          text: JSON.stringify({ object: { value: 42 }, other }),
        },
      },
      response: { status: 200, content: { mimeType: 'text/plain', text: 'ok' } },
    }));
    const analysis = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
    const result = await requestChangesComplete(analysis, 0);
    expect(
      result.changes.find((field) => field.kind === 'JSON' && field.key === '/other')
        ?.distinctValues,
    ).toBe(3);
    expect(
      result.changes.filter((field) => field.kind === 'JSON').map((field) => field.key),
    ).toEqual(['/other']);
  });

  it('keeps colliding container identities distinct and returns actual JSON values', async () => {
    // These two serialized objects have the same length and 32-bit internal hash.
    const objects = [{ v: 'mneihwuxk' }, { v: 'zbhrfjpzn' }, null];
    const entries = objects.map((slot) => ({
      request: {
        method: 'POST',
        url: 'https://example.test/items',
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        postData: { mimeType: 'application/json', text: JSON.stringify({ slot }) },
      },
      response: { status: 200, content: { mimeType: 'text/plain', text: 'ok' } },
    }));
    const analysis = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
    const result = await requestChangesComplete(analysis, 0);
    const field = result.changes.find((item) => item.kind === 'JSON' && item.key === '/slot');
    expect(field?.distinctValues).toBe(3);
    expect(field?.examples.map((example) => example.value)).toEqual([
      '{"v":"mneihwuxk"}',
      '{"v":"zbhrfjpzn"}',
      'null',
    ]);
  });
});

describe('request path evidence', () => {
  it.each([
    ['array first', ['[{"name":"x"}]', '[{"name":"x"}]', '{"0":{}}'], 2],
    ['object first', ['{"0":{}}', '[{"name":"x"}]', '[{"name":"x"}]'], 0],
  ])('reconciles parent types for an absent JSON leaf, %s', async (_label, bodies, selected) => {
    const entries = bodies.map((text, i) => ({
      request: {
        method: 'POST',
        url: 'https://example.test/items',
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        postData: { mimeType: 'application/json', text },
      },
      response: {
        status: i === selected ? 400 : 200,
        content: { mimeType: 'text/plain', text: i === selected ? 'bad' : 'ok' },
      },
    }));
    const analysis = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
    for (const result of [
      requestChanges(analysis, selected),
      await requestChangesComplete(analysis, selected),
    ]) {
      expect(
        result.current?.changes.find(
          (change) => change.kind === 'JSON' && change.key === '/0/name',
        ),
      ).toMatchObject({ reference: '"x"', pathTypes: ['unknown', 'object'] });
    }
  });
});

describe('request reference selection', () => {
  const formats = [
    {
      kind: 'XML',
      mime: 'application/xml',
      key: '/request/0/mode/0/#text/0',
      body: (value: string) => `<request><mode>${value}</mode></request>`,
    },
    {
      kind: 'Multipart',
      mime: 'multipart/form-data; boundary=x',
      key: '/upload/0/@filename',
      body: (value: string) =>
        `--x\r\nContent-Disposition: form-data; name="upload"; filename="${value}"\r\nContent-Type: application/octet-stream\r\n\r\nfixed file content\r\n--x--\r\n`,
    },
  ];

  const capture = (mime: string, bodies: string[]) =>
    new Blob([
      JSON.stringify({
        log: {
          entries: bodies.map((text, id) => ({
            request: {
              method: 'POST',
              url: 'https://example.test/submit',
              headers: [{ name: 'Content-Type', value: mime }],
              postData: { mimeType: mime, text },
            },
            response: {
              status: id === 2 ? 422 : 200,
              headers: [],
              content: { mimeType: 'text/plain', text: id === 2 ? 'Rejected' : 'Accepted' },
            },
          })),
        },
      }),
    ]);

  it.each(formats.flatMap((format) => [false, true].map((evicted) => ({ ...format, evicted }))))(
    'selects the $kind child reference in every query surface (evicted=$evicted)',
    async ({ kind, mime, key, body, evicted }) => {
      const bodies = ['standard', 'standard', 'disabled'].map(body);
      const file = capture(mime, bodies);
      const options = { limits: { totalBodyBytes: evicted ? 0 : 32 * 1024 * 1024 } };
      const analysis = await analyze(file, options);
      const changes = evicted
        ? await requestChangesComplete(analysis, 2)
        : requestChanges(analysis, 2);
      const reference = { kind, key, id: JSON.stringify([kind, key]) };
      expect(changes.changes.map(({ kind, key, id }) => ({ kind, key, id }))).toEqual([reference]);
      expect(changes.changes[0].examples.map(({ value }) => value)).toEqual(['disabled']);
      expect(changes.current?.changes).toEqual([
        expect.objectContaining({ ...reference, reference: 'standard', observed: 'disabled' }),
      ]);
      expect(changes.contrasts).toHaveLength(1);
      expect(changes.contrasts![0].changes).toEqual([
        expect.objectContaining({ ...reference, reference: 'standard', observed: 'disabled' }),
      ]);
      const report = await analyzeReport(file, options);
      const partition = report.contexts[0].partitions.find((part) => part.statuses.includes(422))!;
      expect(
        partition.variations.fields.map(({ category, key, id }) => ({ kind: category, key, id })),
      ).toEqual([reference]);
      expect(partition.sample?.request.body.text).toBe(bodies[2]);
    },
  );

  it.each([
    {
      kind: 'XML layout',
      mime: 'application/xml',
      bodies: ['<r a="same" b="same"/>', '<r a="same" b="same"/>', '<r b="same" a="same"/>'],
    },
    {
      kind: 'multipart part header',
      mime: 'multipart/form-data; boundary=x',
      bodies: ['first', 'first', 'changed'].map(
        (header) =>
          `--x\r\nContent-Disposition: form-data; name="item"\r\nX-Label: ${header}\r\n\r\nsame\r\n--x--\r\n`,
      ),
    },
    {
      kind: 'malformed XML',
      mime: 'application/xml',
      bodies: ['<r><item>first</r>', '<r><item>first</r>', '<r><item>changed</r>'],
    },
  ])('retains an actionable Body reference for $kind changes', async ({ mime, bodies }) => {
    const analysis = await analyze(capture(mime, bodies));
    const changes = requestChanges(analysis, 2);
    expect(changes.changes.map(({ kind, key }) => ({ kind, key }))).toEqual([
      { kind: 'Body', key: 'Content' },
    ]);
    expect(changes.current?.changes).toEqual([
      expect.objectContaining({
        kind: 'Body',
        key: 'Content',
        reference: bodies[0],
        observed: bodies[2],
      }),
    ]);
    expect(changes.contrasts![0].changes).toEqual([
      expect.objectContaining({
        kind: 'Body',
        key: 'Content',
        reference: bodies[0],
        observed: bodies[2],
      }),
    ]);
  });
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

  it.each([
    ['missing', undefined],
    ['non-string', 42],
    ['oversized', 'X'.repeat(8193)],
    ['empty', ''],
  ])('keeps unavailable URL data out of request evidence: %s', async (_label, url) => {
    const valid = exchange(),
      unknown = { ...exchange('{"error":true}'), request: { ...valid.request, url } };
    const result = await analyze(capture([valid, unknown]), undefined, undefined, {
      contexts: [[0, 1]],
    });
    expect(result.entries[1].requestUrlAvailable).toBe(false);
    expect(result.entries[1].body.text).toBe('{"error":true}');
    expect(result.requestIndex?.rows.get(1)?.categories.has('Raw query')).toBe(false);
    result.requestIndex?.rows.delete(1);
    const changes = await requestChangesComplete(result, 1);
    expect(
      changes.current?.changes.filter((change) => ['Path', 'Query'].includes(change.kind)),
    ).toEqual([]);
    expect(changes.contrasts?.[0]).toMatchObject({ complete: false, responseChanged: true });
    expect(changes.incomplete).toBeGreaterThan(0);
    const withQuery = {
      ...unknown,
      request: { ...unknown.request, queryString: [{ name: 'captured', value: 'kept' }] },
    };
    const independent = await analyze(capture([withQuery]));
    expect(
      independent.requestIndex?.rows.get(0)?.categories.get('Query parameter')?.get('captured'),
    ).toBe('["kept"]');
  });

  it.each(['', 'BAD METHOD', 'X'.repeat(65)])(
    'marks malformed method evidence incomplete while retaining the captured value: %j',
    async (method) => {
      const row = exchange();
      const invalid = { ...row, request: { ...row.request, method } };
      const result = await analyze(capture([row, invalid]));
      expect(result.entries[1].method).toBe(method);
      expect(result.entries[1].requestMethodAvailable).toBe(false);
      expect(result.entries[1].diagnostics).toContain(
        'Request method is missing, malformed, or excessive.',
      );
      expect(result.requestIndex?.rows.get(1)?.categories.has('HTTP method')).toBe(false);
      expect((await requestChangesComplete(result, 1)).incomplete).toBeGreaterThan(0);
      const custom = { ...row, request: { ...row.request, method: 'X'.repeat(64) } };
      const control = await analyze(capture([custom]));
      expect(control.entries[0].requestMethodAvailable).toBe(true);
      expect(control.requestIndex?.rows.get(0)?.categories.get('HTTP method')?.get('Method')).toBe(
        'X'.repeat(64),
      );
    },
  );

  it('does not infer query removal from a malformed HAR-only query list', async () => {
    const base = {
      ...exchange(),
      request: { ...exchange().request, queryString: [{ name: 'hidden', value: 'one' }] },
    };
    const broken = { ...exchange(), request: { ...exchange().request, queryString: {} } };
    const result = await analyze(capture([...Array(8).fill(base), broken]));
    expect(requestChanges(result, 8).current?.changes.some((c) => c.kind === 'Query')).toBe(false);
    expect(requestChanges(result, 8).incomplete).toBeGreaterThan(0);
  });
});

describe('observed request evidence', () => {
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

  const bodyRow = (text: string, mimeType: string) => ({
    ...exchange(),
    request: { ...exchange().request, postData: { text, mimeType } },
  });

  it.each([
    ['application/json', '{"a":[1]}', '{"a":{"0":1}}'],
    ['application/json', '1', '{"":1}'],
    ['application/xml', '<r><a/><b/></r>', '<r><b/><a/></r>'],
    [
      'multipart/form-data; boundary=x',
      '--x\r\nContent-Disposition: form-data; name="a"\r\nX-Part: one\r\n\r\ndata\r\n--x--\r\n',
      '--x\r\nContent-Disposition: form-data; name="a"\r\nX-Part: two\r\n\r\ndata\r\n--x--\r\n',
    ],
  ])(
    'preserves structured fields and captured multipart headers in %s',
    async (mime, left, right) => {
      const result = await analyze(capture([bodyRow(left, mime), bodyRow(right, mime)]));
      expect(result.entries.map((entry) => entry.requestBody.text)).toEqual([left, right]);
      expect(result.entries[0].requestBody.hash).not.toBe(result.entries[1].requestBody.hash);
      if (mime === 'application/xml')
        expect(
          requestChanges(result, 1)
            .changes.find((field) => field.kind === 'Body' && field.key === 'Content')
            ?.examples.map((example) => example.value),
        ).toEqual([left, right]);
      if (mime === 'application/json')
        expect(requestChanges(result, 1).current?.changes.some((c) => c.kind === 'JSON')).toBe(
          true,
        );
    },
  );

  it('keeps unknown headers out of field-removal evidence and detects framing/protocol changes', async () => {
    const base = {
      ...exchange(),
      request: {
        ...exchange().request,
        httpVersion: 'HTTP/2',
        headers: [
          { name: 'Content-Length', value: '0' },
          { name: ':authority', value: 'example.test' },
        ],
      },
    };
    const missing = { ...exchange(), request: { method: 'GET', url: base.request.url } };
    const changed = {
      ...base,
      request: {
        ...base.request,
        httpVersion: 'HTTP/3',
        headers: [
          { name: 'Content-Length', value: '1' },
          { name: ':authority', value: 'other.test' },
        ],
      },
    };
    const result = await analyze(capture([...Array(8).fill(base), missing, changed]));
    expect(requestChanges(result, 8).current?.changes.filter((c) => c.kind === 'Header')).toEqual(
      [],
    );
    const current = requestChanges(result, 9).current!.changes;
    expect(current.map((c) => c.key)).toEqual(
      expect.arrayContaining(['content-length', ':authority', 'HTTP version']),
    );
    expect(current.find((c) => c.key === 'HTTP version')).toMatchObject({
      kind: 'Endpoint',
      id: JSON.stringify(['Protocol', 'HTTP version']),
    });
    expect(result.entries[9].diagnostics?.some((d) => d.includes('authority'))).toBe(true);
  });

  it('retains the extra fuzz path after an inferred identifier and handles origin-form queries', async () => {
    const rows = ['/users/1', '/users/2', '/users/1/%27'].map((path) => {
      const row = exchange();
      row.request.url = `https://example.test${path}`;
      return row;
    });
    const result = await analyze(capture(rows));
    expect(
      requestChanges(result, 2).current?.changes.some((c) => c.observed?.includes('%27')),
    ).toBe(true);
    const origins = ['a', 'b'].map((q) => {
      const row = exchange();
      row.request.url = `/items?q=${q}`;
      return row;
    });
    expect((await analyze(capture(origins))).endpoints).toHaveLength(1);
  });

  it('compares actual requests across methods with every simultaneous mutation and raw encoding', async () => {
    const base = bodyRow('{"a":1}', 'application/json');
    base.request.url += '?q=a+b';
    const changed = bodyRow('{ "a":2 }', 'application/json');
    changed.request.method = 'PUT';
    changed.request.url += '?q=a%20b';
    changed.request.headers = [{ name: 'X-Fuzz', value: 'x' }];
    changed.response.status = 403;
    const result = await analyze(capture([...Array(8).fill(base), changed]));
    const contrast = requestChanges(result, 8).contrasts?.[0];
    expect(contrast).toMatchObject({ reference: 0, comparison: 8 });
    expect(contrast?.changes.map((c) => c.kind)).toEqual(
      expect.arrayContaining(['Endpoint', 'JSON', 'Header', 'Query']),
    );
    expect(contrast?.changes.find((change) => change.kind === 'JSON')).toMatchObject({
      key: '/a',
      reference: '1',
      observed: '2',
    });
  });

  it('retains interaction evidence when single-field marginals cannot explain partitions', async () => {
    const rows = ['00', '11', '01', '10'].map((pair) => {
      const row = bodyRow(JSON.stringify({ a: pair[0], b: pair[1] }), 'application/json');
      row.response.status = pair[0] === pair[1] ? 200 : 403;
      return row;
    });
    const result = await analyze(capture(rows));
    const evidence = requestChanges(result, 2);
    expect(
      evidence.contrasts?.some((c) => c.reference < 2 && c.changes.some((d) => d.kind === 'JSON')),
    ).toBe(true);
    expect(evidence.contrasts?.[0].causal).toBe(false);
  });

  it('rereads missing request features from the immutable source instead of losing late evidence', async () => {
    const rows = Array.from({ length: 10 }, () => exchange());
    rows[9].request.url += '?attack=yes';
    rows[9].response.status = 403;
    const result = await analyze(capture(rows));
    result.requestIndex!.rows.clear();
    result.requestIndex!.limited = true;
    const evidence = await requestChangesComplete(result, 9);
    expect(evidence.current?.changes.find((c) => c.key === 'attack')?.observed).toBe('["yes"]');
    expect(evidence.incomplete).toBe(0);
  });
});
