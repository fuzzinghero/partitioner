import { expect, it, describe } from 'vitest';
import { analyze, compare, requestChanges } from './core.js';
import { analyze as analyzeInternal } from './analyze.js';
import { diffHeaders, compare as compareDiff } from './diff.js';
import { LIMITS } from './types.js';
import { requestChangesComplete } from './request-analysis.js';

const capture = (texts: string[], mime: string, headers: { name: string; value: string }[]) =>
  new Blob([
    JSON.stringify({
      log: {
        entries: texts.map((text, id) => ({
          request: { method: 'GET', url: `https://example.test/?q=payload-${id}11`, headers: [] },
          response: { status: 200, headers, content: { mimeType: mime, text } },
        })),
      },
    }),
  ]);

it.each([
  {
    name: 'JSON metadata against text headers',
    mime: 'application/json',
    texts: ['{ "x": 1 }', '{"x":1}'],
    headers: [{ name: 'Content-Type', value: 'text/plain' }],
  },
  {
    name: 'HTML date metadata against text headers',
    mime: 'text/html',
    texts: ['<p>Thu, 08 Oct 2026 18:03:38 GMT</p>', '<p>Fri, 09 Oct 2026 18:03:38 GMT</p>'],
    headers: [{ name: 'Content-Type', value: 'text/plain' }],
  },
  {
    name: 'duplicate MIME headers',
    mime: 'application/json',
    texts: ['{ "x": 1 }', '{"x":1}'],
    headers: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'content-type', value: 'application/json' },
    ],
  },
  {
    name: 'request reflection with conflicting MIME',
    mime: 'text/plain',
    texts: ['Rejected payload-011.', 'Rejected payload-111.', 'Rejected payload-211.'],
    headers: [{ name: 'Content-Type', value: 'application/json' }],
  },
])('uses captured bytes for $name', async ({ mime, texts, headers }) => {
  const result = await analyze(capture(texts, mime, headers));
  expect(result.outcomes).toHaveLength(texts.length);
  expect(result.entries.map((entry) => entry.body.text)).toEqual(texts);
  expect(
    result.entries.every((entry) =>
      entry.diagnostics?.some((message) => /media type|Content-Type/.test(message)),
    ),
  ).toBe(true);
  expect(compare(result.entries[0], result.entries[1]).body.kind).toBe('text');
});

it('keeps captured JSON interpretation when only harmless MIME casing and charset spelling differ', async () => {
  const result = await analyze(
    capture(['{"x":1}', '{ "x": 1 }'], 'application/json; charset=utf-8', [
      { name: 'Content-Type', value: 'Application/JSON; charset=UTF-8' },
    ]),
  );
  expect(result.outcomes.map((group) => group.members)).toEqual([[0, 1]]);
});

describe('captured HAR entries', () => {
  const row = (
    text?: unknown,
    mime = 'application/json',
    status = 200,
    url = 'https://sample.invalid/api/1',
  ) => ({
    time: 12,
    request: { method: 'GET', url, headers: [] },
    response: {
      status,
      headers: [],
      content: { mimeType: mime, size: 0, ...(text === undefined ? {} : { text }) },
    },
  });

  const har = (entries: unknown[]) => new Blob([JSON.stringify({ log: { entries } })]);

  const run = (entries: unknown[], overrides = {}) =>
    analyzeInternal(har(entries), undefined, { ...LIMITS, ...overrides });

  it('preserves duplicate headers, request/query pairs and source IDs through skipped entries', async () => {
    const e = row('{}');
    e.response.headers = [
      { name: 'Set-Cookie', value: 'a=1' },
      { name: 'Set-Cookie', value: 'b=2' },
    ] as never;
    Object.assign(e.request, {
      queryString: [
        { name: 'x', value: '1' },
        { name: 'x', value: '2' },
      ],
      postData: { mimeType: 'text/plain', text: 'request' },
    });
    const a = await run([null, e]);
    expect(a.entries.map((e) => e.id)).toEqual([0, 1]);
    expect(a.summary.skipped).toBe(1);
    expect(a.entries[1].responseHeaders).toHaveLength(2);
    expect(a.entries[1].query).toHaveLength(2);
    expect(a.entries[1].requestBody.text).toBe('request');
    expect(diffHeaders(e.response.headers, [{ name: 'Set-Cookie', value: 'a=1' }])[0].path).toBe(
      '/headers/1',
    );
  });
});

describe('captured HAR entries', () => {
  const row = (
    text?: unknown,
    mime = 'application/json',
    status = 200,
    url = 'https://sample.invalid/api/1',
  ) => ({
    time: 12,
    request: { method: 'GET', url, headers: [] },
    response: {
      status,
      headers: [],
      content: { mimeType: mime, size: 0, ...(text === undefined ? {} : { text }) },
    },
  });

  const har = (entries: unknown[]) => new Blob([JSON.stringify({ log: { entries } })]);

  const run = (entries: unknown[], overrides = {}) =>
    analyzeInternal(har(entries), undefined, { ...LIMITS, ...overrides });

  it('retains bodies and marks excessive headers unavailable', async () => {
    const e = row('{}');
    e.response.headers = Array.from({ length: 201 }, () => ({ name: 'x', value: '1' })) as never;
    const a = await run([e]);
    expect(a.summary.skipped).toBe(0);
    expect(a.entries[0].diagnostics).toContain(
      'Response headers are invalid or excessive; unavailable.',
    );
    expect(a.entries[0].body.text).toBe('{}');
  });

  it('accepts JSON-escaped base64 under the decoded cap and preserves HAR HTTP lines', async () => {
    const encoded = btoa('abcdefgh');
    const e = row(encoded, 'text/plain');
    Object.assign(e.response.content, { encoding: 'base64' });
    Object.assign(e.request, { httpVersion: 'HTTP/2.0' });
    Object.assign(e.response, { httpVersion: 'HTTP/2.0', statusText: 'OK' });
    const escaped = Array.from(
      encoded,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ).join('');
    const file = new Blob([
      JSON.stringify({ log: { entries: [e] } }).replace(JSON.stringify(encoded), `"${escaped}"`),
    ]);
    const a = await analyzeInternal(file, undefined, { ...LIMITS, bodyBytes: 8 });
    expect(a.entries[0].body.text).toBe('abcdefgh');
    expect(a.entries[0]).toMatchObject({
      requestHttpVersion: 'HTTP/2.0',
      responseHttpVersion: 'HTTP/2.0',
      statusText: 'OK',
    });
  });
});

describe('exporter compatibility', () => {
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

  const run = (entries: unknown[]) => analyze(new Blob([JSON.stringify({ log: { entries } })]));

  it('accepts null arrays and uses URL query values instead of discarding the entry', async () => {
    const a = await run([
      row('', {}, { status: 0 }),
      row('', { url: 'https://example.invalid/items?q=two' }, { status: 0 }),
    ]);
    expect(a.summary.skipped).toBe(0);
    expect(a.summary.analyzed).toBe(2);
    expect(
      requestChanges(a, 0)
        .changes.find((c) => c.key === 'q')
        ?.examples.map((e) => e.value),
    ).toEqual(['["one"]', '["two"]']);
  });

  it('marks malformed pair containers unavailable while retaining other evidence', async () => {
    const a = await run([
      row('', { queryString: {} }),
      row('', { headers: [{ name: 'x', value: 7 }] }),
    ]);
    expect(a.summary.skipped).toBe(0);
    expect(a.entries.every((e) => e.diagnostics?.length)).toBe(true);
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
  ])(
    'preserves response evidence without inventing an unavailable method: %s',
    async (_label, method) => {
      const valid = exchange();
      const unknown = { ...exchange('{"error":true}'), request: { ...valid.request, method } };
      const result = await analyzeInternal(capture([...Array(4).fill(valid), unknown]));
      expect(result.summary.analyzed).toBe(5);
      expect(result.entries[4].body.text).toBe('{"error":true}');
      expect(result.requestIndex?.rows.get(4)?.categories.has('HTTP method')).toBe(false);
      result.requestIndex?.rows.delete(4); // Exercise the source reread used after feature eviction.
      for (const id of [0, 4]) {
        const changes = await requestChangesComplete(result, id);
        expect(changes.current?.changes.filter((change) => change.kind === 'Endpoint')).toEqual([]);
        expect(changes.methods).toEqual(id === 0 ? [{ method: 'GET', count: 4, entry: 0 }] : []);
        expect(changes.incomplete).toBeGreaterThan(0);
        expect(changes.contrasts?.[0]).toMatchObject({ complete: false, responseChanged: true });
      }
    },
  );

  it('canonicalizes responses with whitespace-padded reported media types', async () => {
    const rows = [
      exchange('{"a":1,"b":2}', ' \tapplication/json \t; charset=utf-8'),
      exchange('{ "b":2,"a":1 }'),
    ];
    const result = await analyzeInternal(capture(rows));
    expect(result.outcomes.map((group) => group.members)).toEqual([[0, 1]]);
    expect(result.entries[0].body.state).toBe('text');
    expect(result.entries[0].mime).toBe('application/json; charset=utf-8');
  });

  it('preserves captured transport errors and separates unknown from captured-empty response headers', async () => {
    const rows = ['reset', 'timeout'].map((_error) => ({
      ...exchange(),
      response: { status: 0, _error },
    }));
    const unknown = {
      ...exchange(),
      response: { status: 200, content: exchange().response.content },
    };
    const result = await analyzeInternal(capture([...rows, unknown, exchange()]));
    expect(result.entries.slice(0, 2).map((e) => e.transportError)).toEqual(['reset', 'timeout']);
    expect(result.outcomes).toHaveLength(4);
  });

  it('keeps rejected transport errors distinct from missing errors and from each other', async () => {
    for (const location of ['response', 'entry']) {
      const errors = [
        'x'.repeat(1025),
        'x'.repeat(1024) + 'y',
        7,
        { code: 'timeout' },
        null,
        undefined,
        'reset',
        'reset',
      ];
      const rows = errors.map((error) => {
        const row = exchange();
        return location === 'response'
          ? { ...row, response: { ...row.response, _error: error } }
          : { ...row, _error: error };
      });
      const result = await analyzeInternal(capture(rows));
      expect(result.outcomes.map((group) => group.members)).toEqual([
        [0],
        [1],
        [2],
        [3],
        [4],
        [5],
        [6, 7],
      ]);
      expect(
        result.entries
          .slice(0, 5)
          .every((entry) =>
            entry.diagnostics?.some((message) => message.includes('transport error')),
          ),
      ).toBe(true);
    }
  });

  it('uses a single captured Content-Type when the exporter omits response mimeType', async () => {
    const rows = ['{"a":1,"b":2}', '{ "b":2,"a":1 }'].map((text) => ({
      ...exchange(),
      response: {
        status: 200,
        headers: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
        content: { text },
      },
    }));
    const result = await analyzeInternal(capture(rows));
    expect(result.entries[0].body.state).toBe('text');
    expect(result.outcomes).toHaveLength(1);
  });

  it('explains rejected response media fallbacks while preserving absent and valid controls', async () => {
    const fields = [
      [{ name: 'Content-Type', value: 'not-a-media-type' }],
      [{ name: 'Content-Type', value: 'application/json;' + 'x'.repeat(256) }],
      [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Content-Type', value: 'application/json' },
      ],
      [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Content-Type', value: 'text/plain' },
      ],
      [],
      [{ name: 'Content-Type', value: 'application/json' }],
    ];
    const rows = fields.map((headers) => ({
      ...exchange(),
      response: { status: 200, headers, content: { text: '{}' } },
    }));
    const result = await analyzeInternal(capture(rows));
    for (const entry of result.entries.slice(0, 4)) {
      expect(entry.diagnostics).toContain(
        'Response Content-Type fallback is invalid, ambiguous, or excessive.',
      );
      expect(entry.responseMimeAvailable).toBe(false);
      expect(entry.body.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.status).toBe(200);
    }
    expect(result.entries[4].diagnostics).toBeUndefined();
    expect(result.entries[5].diagnostics).toBeUndefined();
    expect(result.entries[5].body.state).toBe('text');
    expect(result.entries.map((entry) => entry.responseHeaders)).toEqual(fields);
    expect(result.summary.warnings).toContain(
      'Some capture fields are invalid, too large, or conflicting. Analysis of those fields may be incomplete.',
    );
  });

  it('canonicalizes JSON with optional whitespace in the fallback Content-Type and retains its raw header', async () => {
    const value = '\t application/json; charset=utf-8 \t';
    const rows = ['{"a":1,"b":2}', '{ "b":2,"a":1 }'].map((text) => ({
      ...exchange(),
      response: { status: 200, headers: [{ name: 'Content-Type', value }], content: { text } },
    }));
    const result = await analyzeInternal(capture(rows));
    expect(result.entries.map((entry) => entry.mime)).toEqual([
      'application/json; charset=utf-8',
      'application/json; charset=utf-8',
    ]);
    expect(result.entries.every((entry) => entry.body.state === 'text' && entry.body.shape)).toBe(
      true,
    );
    expect(result.entries.map((entry) => entry.responseHeaders[0].value)).toEqual([value, value]);
    expect(result.outcomes.map((group) => group.members)).toEqual([[0, 1]]);
  });

  it('keeps unavailable statuses separate across canonical, exact and reflection grouping', async () => {
    for (const mime of ['application/json', 'text/plain']) {
      const statuses = [-1, 1000, '200', null, undefined, -1, 200, 200];
      const rows = statuses.map((status) => {
        const row = exchange('{}', mime);
        return { ...row, response: { ...row.response, status } };
      });
      const result = await analyzeInternal(capture(rows));
      expect(result.entries.map((entry) => entry.status)).toEqual([
        null,
        null,
        null,
        null,
        null,
        null,
        200,
        200,
      ]);
      expect(result.outcomes.map((group) => group.members)).toEqual([
        [0],
        [1],
        [2],
        [3],
        [4],
        [5],
        [6, 7],
      ]);
    }
    const rows = ['probe-111', 'probe-222', 'probe-333'].map((value, i) => {
      const row = exchange(`Rejected value ${value}.`, 'text/plain');
      return {
        ...row,
        request: { ...row.request, url: `https://example.test/items?q=${value}` },
        response: { ...row.response, status: [-1, 1000, null][i] },
      };
    });
    const result = await analyzeInternal(capture(rows));
    expect(result.outcomes.map((group) => group.members)).toEqual([[0], [1], [2]]);
    expect(result.outcomes.every((group) => group.match !== 'inferred-reflection')).toBe(true);
  });

  it('isolates invalid response media types while detecting strict JSON with no declaration', async () => {
    const rejected = [
      undefined,
      null,
      42,
      '',
      'application/json;' + 'x'.repeat(256),
      'not-a-media-type',
    ];
    const rows = rejected.map((mimeType) => {
      const row = exchange();
      return { ...row, response: { ...row.response, content: { text: '{}', mimeType } } };
    });
    const result = await analyzeInternal(capture(rows));
    expect(result.outcomes.map((group) => group.members)).toEqual([[0, 3], [1], [2], [4], [5]]);
    expect(
      result.entries.every((entry) => entry.responseMimeAvailable === false && entry.body.hash),
    ).toBe(true);
    const compared = compareDiff(result.entries[0], result.entries[1]);
    expect(compared.metadata).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'mime', kind: 'changed' })]),
    );
    const fallback = rows.map((row) => ({
      ...row,
      response: { ...row.response, headers: [{ name: 'Content-Type', value: 'application/json' }] },
    }));
    const recovered = await analyzeInternal(capture(fallback));
    expect(recovered.outcomes.map((group) => group.members)).toEqual([[0, 1, 2, 3, 4, 5]]);
    expect(
      recovered.entries.every(
        (entry) => entry.responseMimeAvailable && entry.body.state === 'text',
      ),
    ).toBe(true);
  });

  it('charges retained transport-error text against the configured metadata budget', async () => {
    const row = exchange();
    const baseline = await analyzeInternal(capture([row]));
    const withError = { ...row, response: { ...row.response, _error: 'x'.repeat(1024) } };
    const budget = baseline.summary.metadataEstimate + 2048;
    await expect(
      analyzeInternal(capture([withError]), undefined, { metadataBytes: budget - 1 }),
    ).rejects.toThrow('metadata budget');
    const accepted = await analyzeInternal(capture([withError]), undefined, {
      metadataBytes: budget,
    });
    expect(accepted.entries[0].transportError).toBe('x'.repeat(1024));
    expect(accepted.summary.metadataEstimate).toBe(budget);
  });

  it('also accounts for retained method, protocol, status text and diagnostic strings', async () => {
    const row = exchange();
    const captureRow = {
      ...row,
      request: { ...row.request, method: 'X'.repeat(8192), httpVersion: 'HTTP/2' },
      response: { ...row.response, httpVersion: 'HTTP/3', statusText: 'x'.repeat(256) },
    };
    const result = await analyzeInternal(capture([captureRow]));
    expect(result.summary.metadataEstimate).toBeGreaterThanOrEqual(2 * (8192 + 6 + 6 + 256));
    expect(result.entries[0].diagnostics?.length).toBeGreaterThan(0);
    await expect(
      analyzeInternal(capture([captureRow]), undefined, { metadataBytes: 4096 }),
    ).rejects.toThrow('metadata budget');
  });
});

describe('untrusted capture boundaries', () => {
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

  it('retains valid response evidence when the captured method is malformed', async () => {
    const row = exchange('{"denied":true}');
    row.request.method = 'X'.repeat(65);
    const result = await analyzeInternal(capture([row]));
    expect(result.entries[0].status).toBe(200);
    expect(result.entries[0].body.text).toBe('{"denied":true}');
    expect(result.entries[0].diagnostics?.length).toBeGreaterThan(0);
  });
});
