import { analyzeEntry } from './entry.js';
import { LIMITS } from './types.js';
import { expect, it, describe } from 'vitest';
import { analyze } from './analyze.js';
import { requestChanges, requestChangesComplete } from './request-analysis.js';
import { STRUCTURE_LIMITS } from './structured.js';
import { REQUEST_ANALYSIS_LIMITS, createRequestIndex, indexRequest } from './request-index.js';
import { Buffer } from 'node:buffer';
import { analyze as analyzeCore, requestChanges as requestChangesCore } from './core.js';

const capture = (requests: unknown[]) =>
  new Blob([
    JSON.stringify({
      log: {
        entries: requests.map((request) => ({
          request,
          response: {
            status: 200,
            headers: [],
            content: { mimeType: 'text/plain', text: 'accepted' },
          },
        })),
      },
    }),
  ]);
const request = (extra: object) => ({
  method: 'POST',
  url: 'https://example.test/submit',
  headers: [],
  ...extra,
});

it('compares captured and exporter cookies through one logical field with captured values preferred', async () => {
  const result = await analyze(
    capture([
      request({
        headers: [{ name: 'Cookie', value: 'sid="captured-111"' }],
        cookies: [{ name: 'sid', value: 'stale-000' }],
      }),
      request({ cookies: [{ name: 'sid', value: '"exported-222"' }] }),
    ]),
  );
  const cookieChanges = requestChanges(result, 0).changes.filter((c) => c.key === 'sid');
  expect(cookieChanges.map((c) => [c.kind, c.examples.map((e) => e.value)])).toEqual([
    ['Cookie', ['["captured-111"]', '["exported-222"]']],
  ]);
  expect(result.entries[0].diagnostics).toContain(
    'Request Cookie headers conflict with HAR cookies. Header values are authoritative.',
  );
  expect(result.entries[0].requestHeaders).toEqual([
    { name: 'Cookie', value: 'sid="captured-111"' },
  ]);
  expect(result.requestIndex!.rows.get(0)!.sources?.get('Cookie')).toBe('headers');
  expect(result.requestIndex!.rows.get(1)!.sources?.get('Cookie')).toBe('har');
});

it('treats quoted exporter cookies as the same values as captured cookies', async () => {
  const result = await analyze(
    capture([
      request({ headers: [{ name: 'Cookie', value: 'sid="same-111"' }] }),
      request({ cookies: [{ name: 'sid', value: '"same-111"' }] }),
    ]),
  );
  expect(result.requestIndex!.rows.get(0)!.categories.get('Cookie')).toEqual(
    new Map([['sid', '["same-111"]']]),
  );
  expect(result.requestIndex!.rows.get(1)!.categories.get('Cookie')).toEqual(
    new Map([['sid', '["same-111"]']]),
  );
  expect(requestChanges(result, 0).changes.filter((c) => c.key === 'sid')).toEqual([]);
});

it('uses captured cookie absence when the exporter also records an empty cookie array', async () => {
  const result = await analyze(capture([request({ headers: [], cookies: [] })]));
  expect(result.requestIndex!.rows.get(0)!.categories.get('Cookie')).toEqual(new Map());
  expect(result.requestIndex!.rows.get(0)!.sources?.get('Cookie')).toBe('headers');
  expect(result.entries[0].diagnostics).toBeUndefined();
});

it('keeps malformed captured cookie interpretation unknown despite valid exporter fields', async () => {
  const result = await analyze(
    capture([
      request({ headers: [{ name: 'Cookie', value: 'sid=known-111' }] }),
      request({ headers: [{ name: 'Cookie', value: 'sid=known-111' }] }),
      request({
        headers: [{ name: 'Cookie', value: 'sid="unterminated' }],
        cookies: [{ name: 'sid', value: 'exported-222' }],
      }),
    ]),
  );
  const changes = requestChanges(result, 2);
  expect(changes.current?.changes.filter((c) => c.kind === 'Cookie')).toEqual([]);
  expect(changes.contrasts?.every((c) => c.complete)).toBe(true);
  expect(changes.contrasts?.[0].changes).toContainEqual(
    expect.objectContaining({ kind: 'Header', key: 'cookie', observed: '["sid=\\"unterminated"]' }),
  );
});

it('compares decoded form values and duplicate positions across captured text and exporter params', async () => {
  const result = await analyze(
    capture([
      request({
        postData: { mimeType: 'application/x-www-form-urlencoded', text: 'q=one+two&q=three' },
      }),
      request({
        postData: {
          mimeType: 'application/x-www-form-urlencoded',
          params: [
            { name: 'q', value: 'one two' },
            { name: 'q', value: 'four' },
          ],
        },
      }),
    ]),
  );
  const changes = requestChanges(result, 0).changes.filter((c) => c.kind === 'Form');
  expect(changes.map((c) => [c.key, c.examples.map((e) => e.value)])).toEqual([
    ['/q/1/value', ['three', 'four']],
  ]);
  expect(result.requestIndex!.rows.get(0)!.sources?.get('Form')).toBe('body');
  expect(result.requestIndex!.rows.get(1)!.sources?.get('Form')).toBe('har');
  expect(await requestChangesComplete(result, 0)).toEqual(requestChanges(result, 0));
});

it('uses captured form values and diagnoses conflicting exporter params', async () => {
  const result = await analyze(
    capture([
      request({
        postData: {
          mimeType: 'application/x-www-form-urlencoded',
          text: 'q=wire-111',
          params: [{ name: 'q', value: 'stale-000' }],
        },
      }),
      request({
        postData: {
          mimeType: 'application/x-www-form-urlencoded',
          params: [{ name: 'q', value: 'exported-222' }],
        },
      }),
    ]),
  );
  expect(
    requestChanges(result, 0)
      .changes.find((c) => c.key === '/q/0/value')
      ?.examples.map((e) => e.value),
  ).toEqual(['wire-111', 'exported-222']);
  expect(result.entries[0].diagnostics).toContain(
    'Request body fields conflict with HAR form parameters. Body values are authoritative.',
  );
  expect(result.entries[0].requestBody.text).toBe('q=wire-111');
});

it('keeps invalid captured form text unavailable instead of replacing it with exporter params', async () => {
  const result = await analyze(
    capture([
      request({ postData: { mimeType: 'application/x-www-form-urlencoded', text: 'q=wire-111' } }),
      request({ postData: { mimeType: 'application/x-www-form-urlencoded', text: 'q=wire-111' } }),
      request({
        postData: {
          mimeType: 'application/x-www-form-urlencoded',
          text: 'q=%ZZ',
          params: [{ name: 'q', value: 'exported-222' }],
        },
      }),
    ]),
  );
  expect(requestChanges(result, 2).current?.changes.filter((c) => c.kind === 'Form')).toEqual([]);
  expect(result.requestIndex!.rows.get(2)!.categories.has('Incomplete')).toBe(true);
  expect(result.entries[2].requestBody.text).toBe('q=%ZZ');
});

it('preserves multipart bytes and exporter hints without inventing missing file contents', async () => {
  const text =
    '--b\r\nContent-Disposition: form-data; name="q"\r\n\r\nwire-111\r\n--b\r\nContent-Disposition: form-data; name="upload"; filename="same.txt"\r\nContent-Type: text/plain\r\n\r\nsecret content\r\n--b--\r\n';
  const result = await analyze(
    capture([
      request({ postData: { mimeType: 'multipart/form-data; boundary=b', text } }),
      request({ postData: { mimeType: 'multipart/form-data; boundary=b', text } }),
      request({
        postData: {
          mimeType: 'multipart/form-data; boundary=b',
          params: [
            { name: 'q', value: 'exported-222' },
            { name: 'upload', fileName: 'same.txt' },
          ],
        },
      }),
    ]),
  );
  const changes = requestChanges(result, 2);
  expect(result.entries.slice(0, 2).map((entry) => entry.requestBody.text)).toEqual([text, text]);
  const metadata = result.requestIndex!.rows.get(2)!;
  expect(metadata.categories.get('Multipart')?.get('/q/0/value')).toBe('exported-222');
  expect(metadata.sources?.get('Multipart')).toBe('har');
  expect(metadata.categories.get('Multipart')?.get('/upload/0/@filename')).toBe('same.txt');
  expect(metadata.unavailable?.get('Multipart')?.has('/upload/0/value')).toBe(true);
  expect(changes.contrasts?.every((c) => c.complete)).toBe(false);
});

it.each(['text/plain', 'application/json'])(
  'retains form reflection only from captured body fields in %s',
  async (mime) => {
    for (const source of ['urlencoded', 'multipart', 'har']) {
      const entries = ['payload-111', 'payload-222', 'payload-333'].map((value) => ({
        request: request({
          postData:
            source === 'urlencoded'
              ? { mimeType: 'application/x-www-form-urlencoded', text: `q=${value}` }
              : source === 'multipart'
                ? {
                    mimeType: 'multipart/form-data; boundary=b',
                    text: `--b\r\nContent-Disposition: form-data; name="q"\r\n\r\n${value}\r\n--b--\r\n`,
                  }
                : { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'q', value }] },
        }),
        response: {
          status: 400,
          headers: [],
          content: {
            mimeType: mime,
            text:
              mime === 'application/json'
                ? JSON.stringify({ echo: value, error: 'invalid' })
                : `Rejected ${value}.`,
          },
        },
      }));
      const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
      expect(result.outcomes.map((g) => g.members)).toEqual(
        source !== 'har' ? [[0, 1, 2]] : [[0], [1], [2]],
      );
      expect(
        result
          .requestIndex!.rows.get(0)!
          .sources?.get(source === 'multipart' ? 'Multipart' : 'Form'),
      ).toBe(source === 'har' ? 'har' : 'body');
    }
  },
);

it('preserves escaped names and reserved-looking multipart field names', async () => {
  const text =
    '--b\r\nContent-Disposition: form-data; name="@header"\r\n\r\nkept\r\n--b\r\nContent-Disposition: form-data; name="a/b~c"\r\n\r\nvalue\r\n--b--\r\n';
  const result = await analyze(
    capture([
      request({ postData: { mimeType: 'multipart/form-data; boundary=b', text } }),
      request({
        postData: {
          mimeType: 'multipart/form-data; boundary=b',
          params: [
            { name: '@header', value: 'kept' },
            { name: 'a/b~c', value: 'value' },
          ],
        },
      }),
    ]),
  );
  expect(result.entries[0].requestBody.text).toBe(text);
  expect(result.requestIndex!.rows.get(1)!.categories.get('Multipart')).toEqual(
    new Map([
      ['/@header/0/value', 'kept'],
      ['/a~1b~0c/0/value', 'value'],
    ]),
  );
});

it('reconstructs consolidated fields and unknown file contents after query eviction', async () => {
  const file = capture([
    request({
      headers: [{ name: 'Cookie', value: 'sid=wire-111' }],
      postData: { mimeType: 'application/x-www-form-urlencoded', text: 'q=wire-111' },
    }),
    request({
      cookies: [{ name: 'sid', value: 'exported-222' }],
      postData: {
        mimeType: 'application/x-www-form-urlencoded',
        params: [
          { name: 'q', value: 'exported-222' },
          { name: 'file', fileName: 'note.txt' },
        ],
      },
    }),
  ]);
  const fresh = await analyze(file);
  const expected = await requestChangesComplete(fresh, 1);
  const original = REQUEST_ANALYSIS_LIMITS.retainedBytes;
  try {
    REQUEST_ANALYSIS_LIMITS.retainedBytes = 0;
    const evicted = await analyze(file);
    expect(evicted.requestIndex!.rows.size).toBe(0);
    REQUEST_ANALYSIS_LIMITS.retainedBytes = original;
    expect(await requestChangesComplete(evicted, 1)).toEqual(expected);
    expect(evicted.entries[1].diagnostics).toContain(
      'Request cookies use HAR metadata. No Cookie header was captured.',
    );
    expect(evicted.entries[1].diagnostics).toContain(
      'Request form fields use HAR parameters. Body text was not captured.',
    );
  } finally {
    REQUEST_ANALYSIS_LIMITS.retainedBytes = original;
  }
});

it('shares repeated provenance and unknown file metadata within the query budget', async () => {
  const row = request({
    cookies: [{ name: 'sid', value: 'constant-111' }],
    postData: {
      mimeType: 'multipart/form-data',
      params: [{ name: 'upload', fileName: 'note.txt' }],
    },
  });
  const result = await analyze(capture(Array.from({ length: 1000 }, () => row)));
  expect(result.requestIndex!.rows.size).toBe(1000);
  expect(result.requestIndex!.limited).toBe(false);
  expect(result.requestIndex!.bytes).toBeLessThan(192 * 1000);
  const first = result.requestIndex!.rows.get(0)!;
  expect(result.requestIndex!.rows.get(999)!.sources).toBe(first.sources);
  expect(result.requestIndex!.rows.get(999)!.unavailable).toBe(first.unavailable);
  const before = structuredClone(first);
  await requestChangesComplete(result, 999);
  expect(first).toEqual(before);
});

it.each([
  [{ name: 'q', value: 'x'.repeat(STRUCTURE_LIMITS.valueChars + 1) }],
  Array.from({ length: STRUCTURE_LIMITS.fields + 1 }, (_, i) => ({
    name: `q${i}`,
    value: 'value',
  })),
  Array.from({ length: 9 }, (_, i) => ({ name: `q${i}`, value: 'é'.repeat(4096) })),
])(
  'keeps excessive exporter params unavailable without weakening captured form text',
  async (params) => {
    const result = await analyze(
      capture([
        request({
          postData: { mimeType: 'application/x-www-form-urlencoded', text: 'q=wire-111', params },
        }),
        request({ postData: { mimeType: 'application/x-www-form-urlencoded', params } }),
      ]),
    );
    expect(result.requestIndex!.rows.get(0)!.categories.get('Form')).toEqual(
      new Map([['/q/0/value', 'wire-111']]),
    );
    expect(result.requestIndex!.rows.get(0)!.categories.has('Incomplete')).toBe(false);
    expect(result.requestIndex!.rows.get(1)!.categories.has('Incomplete')).toBe(true);
    expect(requestChanges(result, 1).current?.changes.filter((c) => c.kind === 'Form')).toEqual([]);
  },
);

describe('public API request indexing', () => {
  const capture = (entries: unknown[]) => new Blob([JSON.stringify({ log: { entries } })]);

  const row = (text = 'ok', mimeType = 'text/plain', request = {}) => ({
    request: { method: 'POST', url: 'https://example.test/items', headers: [], ...request },
    response: { status: 200, headers: [], content: { mimeType, text } },
  });

  it('treats binary base64 form content as unavailable field evidence', async () => {
    const analysis = await analyzeCore(
      capture([
        row('ok', 'text/plain', {
          postData: {
            mimeType: 'application/x-www-form-urlencoded',
            text: Buffer.from([255]).toString('base64'),
            encoding: 'base64',
          },
        }),
      ]),
    );
    expect(analysis.entries[0].requestBody.state).toBe('binary');
    expect(requestChangesCore(analysis, 0).incomplete).toBeGreaterThan(0);
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
    ['reported', 'Form', 'application/x-www-form-urlencoded', 'input=probe-111'],
    ['header', 'Form', 'application/x-www-form-urlencoded', 'input=probe-111'],
    [
      'reported',
      'Multipart',
      'multipart/form-data',
      '--CaseSensitive\r\nContent-Disposition: form-data; name="input"\r\n\r\nprobe-111\r\n--CaseSensitive--\r\n',
    ],
    [
      'header',
      'Multipart',
      'multipart/form-data',
      '--CaseSensitive\r\nContent-Disposition: form-data; name="input"\r\n\r\nprobe-111\r\n--CaseSensitive--\r\n',
    ],
  ])(
    'retains %s request %s evidence from padded media types',
    async (source, format, base, text) => {
      const mime = ` \t${base} \t; boundary=CaseSensitive`;
      const row = exchange();
      const file = capture([
        {
          ...row,
          request: {
            ...row.request,
            method: 'POST',
            headers: source === 'header' ? [{ name: 'Content-Type', value: mime }] : [],
            postData: { text, ...(source === 'reported' ? { mimeType: mime } : {}) },
          },
        },
      ]);
      const result = await analyze(file);
      expect(result.entries[0].requestBody.state).toBe('text');
      const field = '/input/0/value';
      if (format === 'Form')
        expect(result.requestIndex?.rows.get(0)?.categories.get(format)?.get(field)).toBe(
          'probe-111',
        );
      else expect(result.entries[0].requestBody.text).toBe(text);
      expect(result.entries[0].diagnostics).toBeUndefined();
      if (source === 'header') expect(result.entries[0].requestHeaders[0].value).toBe(mime);
    },
  );

  it.each([
    ['JSON', 'application/json'],
    ['XML', 'application/xml'],
    ['Form', 'application/x-www-form-urlencoded'],
  ])(
    'keeps rejected request media types out of %s interpretation and reflection evidence',
    async (format, mime) => {
      const rows = ['probe-111', 'probe-222', 'probe-333'].map((value) => {
        const text =
          format === 'JSON'
            ? JSON.stringify({ input: value })
            : format === 'XML'
              ? `<r>${value}</r>`
              : `input=${value}`;
        const row = exchange(`Rejected value ${value}.`, 'text/plain');
        return {
          ...row,
          request: {
            ...row.request,
            method: 'POST',
            postData: { mimeType: `${mime};${'x'.repeat(300)}`, text },
          },
        };
      });
      const result = await analyze(capture(rows));
      expect(
        result.entries.every(
          (entry) => entry.requestBody.hash && entry.requestBody.state === 'binary',
        ),
      ).toBe(true);
      expect(result.requestIndex?.rows.get(0)?.categories.has(format)).toBe(false);
      expect((await requestChangesComplete(result, 0)).incomplete).toBeGreaterThan(0);
      expect(result.outcomes.map((group) => group.members)).toEqual([[0], [1], [2]]);
      const valid = rows.map((row) => ({
        ...row,
        request: { ...row.request, postData: { ...row.request.postData, mimeType: mime } },
      }));
      expect((await analyze(capture(valid))).outcomes.map((group) => group.members)).toEqual([
        [0, 1, 2],
      ]);
      const fallback = {
        ...rows[0],
        request: { ...rows[0].request, headers: [{ name: 'Content-Type', value: mime }] },
      };
      const recovered = await analyze(capture([fallback]));
      expect(recovered.entries[0].requestBody.state).toBe('text');
      if (format === 'XML')
        expect(recovered.entries[0].requestBody.text).toBe(rows[0].request.postData.text);
      else expect(recovered.requestIndex?.rows.get(0)?.categories.has(format)).toBe(true);
      expect(recovered.requestIndex?.rows.get(0)?.categories.has('Incomplete')).toBe(true);
    },
  );

  it.each([
    ['JSON', 'application/json'],
    ['XML', 'application/xml'],
    ['Form', 'application/x-www-form-urlencoded'],
    ['Multipart', 'multipart/form-data; boundary=probe-boundary'],
  ])('rejects ambiguous Content-Type fallbacks before %s interpretation', async (format, mime) => {
    const rows = ['probe-111', 'probe-222', 'probe-333'].map((value) => {
      const text =
        format === 'JSON'
          ? JSON.stringify({ input: value })
          : format === 'XML'
            ? `<r>${value}</r>`
            : format === 'Form'
              ? `input=${value}`
              : `--probe-boundary\r\nContent-Disposition: form-data; name="input"\r\n\r\n${value}\r\n--probe-boundary--\r\n`;
      const row = exchange(`Rejected value ${value}.`, 'text/plain');
      return {
        ...row,
        request: {
          ...row.request,
          method: 'POST',
          headers: [
            { name: 'Content-Type', value: mime },
            { name: 'content-type', value: 'text/plain' },
          ],
          postData: { text },
        },
      };
    });
    const result = await analyze(capture(rows));
    expect(
      result.entries.every(
        (entry) => entry.requestBody.hash && entry.requestBody.state === 'binary',
      ),
    ).toBe(true);
    expect(result.requestIndex?.rows.get(0)?.categories.has(format)).toBe(false);
    expect((await requestChangesComplete(result, 0)).incomplete).toBeGreaterThan(0);
    expect(result.outcomes.map((group) => group.members)).toEqual([[0], [1], [2]]);
    const unique = rows.map((row) => ({
      ...row,
      request: { ...row.request, headers: row.request.headers.slice(0, 1) },
    }));
    expect((await analyze(capture(unique))).outcomes.map((group) => group.members)).toEqual([
      [0, 1, 2],
    ]);
    const sameDuplicate = {
      ...rows[0],
      request: {
        ...rows[0].request,
        headers: [
          { name: 'Content-Type', value: mime },
          { name: 'content-type', value: mime },
        ],
      },
    };
    expect(
      (await analyze(capture([sameDuplicate]))).requestIndex?.rows.get(0)?.categories.has(format),
    ).toBe(false);
    const invalidType = {
      ...rows[0],
      request: {
        ...rows[0].request,
        headers: [{ name: 'Content-Type', value: 'invalid/' + mime }],
      },
    };
    const invalid = await analyze(capture([invalidType]));
    expect(invalid.entries[0].requestBody.state).toBe('binary');
    expect(invalid.requestIndex?.rows.get(0)?.categories.has('Incomplete')).toBe(true);
  });
});

describe('bounded large-capture indexing', () => {
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

  it('shares repeated request features and keeps the late rare mutation indexed', async () => {
    const text = JSON.stringify(
      Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, i])),
    );
    const rows = Array.from({ length: 5000 }, () => ({
      ...exchange(),
      request: { ...exchange().request, postData: { mimeType: 'application/json', text } },
    }));
    rows[4999].request.url += '?attack=yes';
    rows[4999].response.status = 403;
    const result = await analyze(capture(rows));
    expect(result.requestIndex!.rows.size).toBe(5000);
    expect(
      requestChanges(result, 4999).current?.changes.find((c) => c.key === 'attack')?.observed,
    ).toBe('["yes"]');
  }, 15_000);

  it.each([
    ['q=a+b', 'q=a%20b'],
    ['q', 'q='],
    ['a=1&b=2', 'b=2&a=1'],
  ])('retains raw query distinction %s / %s', async (a, b) => {
    const rows = [a, b].map((query) => {
      const row = exchange();
      row.request.url += `?${query}`;
      return row;
    });
    const result = await analyze(capture(rows));
    expect(requestChanges(result, 1).current?.changes.some((c) => c.kind === 'Query')).toBe(true);
  });
});

it('uses captured URLs with null exporter query metadata without losing empty-query evidence', async () => {
  const result = await analyze(
    capture([
      request({}),
      request({ queryString: [] }),
      request({ queryString: null }),
      request({ url: 'https://example.test/submit?bad=%', queryString: null }),
      request({ url: 'https://example.test/submit?bad=%ff', queryString: null }),
      request({ url: '', queryString: null }),
    ]),
  );
  for (const id of [0, 1, 2]) {
    const row = result.requestIndex!.rows.get(id)!;
    expect(row.categories.get('Query parameter')).toEqual(new Map());
    expect(row.categories.has('Incomplete')).toBe(false);
  }
  expect(result.requestIndex!.rows.get(4)!.categories.get('Query parameter')?.get('bad')).toBe(
    '["�"]',
  );
  expect(result.requestIndex!.rows.get(4)!.categories.has('Incomplete')).toBe(false);
  for (const id of [3, 5]) {
    const row = result.requestIndex!.rows.get(id)!;
    expect(row.categories.has('Query parameter')).toBe(false);
    expect(row.categories.has('Incomplete')).toBe(true);
  }
});

it('retains parsed request values near the query work limit despite many empty XML elements', async () => {
  const raw = {
    request: request({
      postData: {
        mimeType: 'application/xml',
        text:
          '<r>' +
          Array.from({ length: 100 }, (_, i) => `<empty${i}/>`).join('') +
          '<value>alpha</value></r>',
      },
    }),
    response: { status: 200, headers: [], content: { mimeType: 'text/plain', text: 'accepted' } },
  };
  const entry = await analyzeEntry(raw, 0, LIMITS, { bytes: 0, nodes: 0 });
  const index = createRequestIndex();
  index.work = REQUEST_ANALYSIS_LIMITS.work - 10;
  indexRequest(index, entry, raw);
  expect(index.rows.get(0)?.categories.get('XML')?.get('/r/0/value/0/#text/0')).toBe('alpha');
  expect(index.limited).toBe(false);
});
