import { expect, it, describe } from 'vitest';
import { analyze } from './analyze.js';
import { compare } from './diff.js';
import { LIMITS } from './types.js';

describe('response partition identity', () => {
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
    analyze(har(entries), undefined, { ...LIMITS, ...overrides });

  it('analyzes available bodies and groups missing bodies only by known metadata', async () => {
    const a = await analyze(
      har([row('one', 'text/plain'), row('two', 'text/plain'), row(), row()]),
    );
    expect(a.entries[0].body.text).toBe('one');
    expect(a.entries[2].outcome).toBe(a.entries[3].outcome);
    expect(a.entries[2].body.hash).toBeUndefined();
    expect(a.entries[2].body.state).toBe('missing');
    expect(a.entries[0].outcome).not.toBe(a.entries[1].outcome);
  });

  it('keeps reflection-like JSON values and header differences visible. Text changes form separate groups', async () => {
    const first = row('{"echo":"payload-A","ok":true}'),
      second = row('{"echo":"payload-B","ok":true}');
    first.response.headers = [{ name: 'X-Outcome', value: 'A' }] as never;
    second.response.headers = [{ name: 'X-Outcome', value: 'B' }] as never;
    const a = await run([
      first,
      second,
      row('Echo payload-A', 'text/plain'),
      row('Echo payload-B', 'text/plain'),
    ]);
    expect(a.outcomes).toHaveLength(4);
    const result = compare(a.entries[0], a.entries[1]);
    expect(result.body.changes[0]).toMatchObject({
      path: '/echo',
      reference: '"payload-A"',
      comparison: '"payload-B"',
    });
    expect(result.headers[0]).toMatchObject({
      reference: 'X-Outcome: A',
      comparison: 'X-Outcome: B',
    });
  });
});

describe('captured response evidence', () => {
  const row = (response: string, mimeType = 'application/json', requestBody?: string) => ({
    request: {
      method: 'POST',
      url: 'https://example.test/orders',
      headers: [],
      ...(requestBody === undefined
        ? {}
        : { postData: { mimeType: 'text/plain', text: requestBody } }),
    },
    response: { status: 200, headers: [], content: { mimeType, text: response } },
  });

  const capture = (entries: unknown[]) => new Blob([JSON.stringify({ log: { entries } })]);

  it('explains invalid JSON response grouping in terms of captured body bytes', async () => {
    const result = await analyze(capture([row('{'), row('{')]));
    expect(result.outcomes).toHaveLength(1);
    expect(result.summary.warnings).toContain(
      'Some response bodies could not be parsed or exceeded analysis limits. Those bodies were compared using their captured bytes.',
    );
    expect(result.entries[0].body.shapeWarning).toBe(
      'JSON could not be parsed or exceeded analysis limits. Responses were compared using body bytes.',
    );
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

  it.each(['exact bytes', 'canonical JSON', 'HTML dates'])(
    'joins %s evidence with reflected response templates in either capture order',
    async (method) => {
      const html = method === 'HTML dates';
      const rows = values.map((v) =>
        row(
          v,
          html ? 'text/html' : 'application/json',
          html
            ? `<p>Rejected ${v}</p><p>Sun, 01 Jun 2025 12:34:56 GMT</p>`
            : JSON.stringify({ echo: v, error: 'invalid' }),
        ),
      );
      const extra = row(
        'unrelated-token',
        rows[0].response.content.mimeType,
        method === 'canonical JSON'
          ? JSON.stringify({ error: 'invalid', echo: values[0] })
          : method === 'HTML dates'
            ? rows[0].response.content.text.replace('Sun, 01 Jun', 'Mon, 02 Jun')
            : rows[0].response.content.text,
      );
      for (const entries of [[...rows, extra], [...rows, extra].reverse()]) {
        const result = await analyze(capture(entries));
        expect(result.outcomes.map((group) => group.members)).toEqual(
          html ? (entries[0] === extra ? [[0], [1, 2, 3]] : [[0, 1, 2], [3]]) : [[0, 1, 2, 3]],
        );
        expect(result.outcomes.find((group) => group.members.length >= 3)?.match).toBe(
          'inferred-reflection',
        );
      }
    },
  );

  it.each(['status', 'origin', 'header', 'transport error', 'MIME'])(
    'keeps canonical aliases inside the %s boundary',
    async (boundary) => {
      const rows = values.map((v) =>
        row(v, 'application/json', JSON.stringify({ echo: v, error: 'invalid' })),
      );
      const extra = row(
        'unrelated-token',
        'application/json',
        JSON.stringify({ error: 'invalid', echo: values[0] }),
      );
      if (boundary === 'status') extra.response.status = 403;
      if (boundary === 'origin')
        extra.request.url = extra.request.url.replace('example.test', 'other.test');
      if (boundary === 'header')
        (extra.response as Record<string, unknown>).headers = [
          { name: 'Content-Security-Policy', value: "default-src 'none'" },
        ];
      if (boundary === 'transport error')
        (extra.response as Record<string, unknown>)._error = 'reset';
      if (boundary === 'MIME') extra.response.content.mimeType = 'application/problem+json';
      expect(
        (await analyze(capture([...rows, extra]))).outcomes.map((group) => group.members),
      ).toEqual([[0, 1, 2], [3]]);
    },
  );

  it.each(['status', 'origin', 'header', 'transport error'])(
    'preserves %s response boundaries around inferred templates',
    async (boundary) => {
      const rows = [false, true].flatMap((different) =>
        values.map((v) => {
          const entry = row(
            v,
            'application/json',
            JSON.stringify({ echo: `Rejected ${v}`, accepted: false }),
          );
          if (different && boundary === 'status') entry.response.status = 403;
          if (different && boundary === 'origin')
            entry.request.url = entry.request.url.replace('example.test', 'other.test');
          if (different && boundary === 'header')
            (entry.response as Record<string, unknown>).headers = [
              { name: 'Content-Security-Policy', value: "default-src 'none'" },
            ];
          if (different && boundary === 'transport error')
            (entry.response as Record<string, unknown>)._error = 'reset';
          return entry;
        }),
      );
      expect((await analyze(capture(rows))).outcomes.map((group) => group.members)).toEqual([
        [0, 1, 2],
        [3, 4, 5],
      ]);
    },
  );
});

describe('structured response identity', () => {
  const request = (overrides = {}) => ({
    method: 'POST',
    url: 'https://example.invalid/items?q=one',
    headers: [{ name: 'X-Test', value: 'one' }],
    postData: { mimeType: 'application/json', text: '{"name":"one","n":9007199254740993}' },
    ...overrides,
  });

  it('separates XML and form response values while preserving exact body hashes', async () => {
    for (const [mime, a, b] of [
      ['application/xml', '<r id="1">one</r>', '<r id="2">two</r>'],
      ['application/x-www-form-urlencoded', 'a=one', 'a=two'],
    ]) {
      const result = await analyze(
        new Blob([
          JSON.stringify({
            log: {
              entries: [a, b].map((text) => ({
                request: request(),
                response: { status: 200, content: { mimeType: mime, text } },
              })),
            },
          }),
        ]),
      );
      expect(result.outcomes).toHaveLength(2);
      expect(result.entries[0].body.hash).not.toBe(result.entries[1].body.hash);
      expect(result.entries.map((entry) => entry.body.text)).toEqual([a, b]);
      if (mime === 'application/x-www-form-urlencoded')
        expect(result.entries[0].body.shape).toBeTruthy();
    }
  });
});

describe('response partition identity', () => {
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
    ['application/json', '{"ok":true,"n":9007199254740992}', '{"ok":false,"n":9007199254740993}'],
    ['application/xml', '<r>Accepted</r>', '<r>Rejected</r>'],
    ['application/xml', '<r><!--allowed--></r>', '<r><!--denied--></r>'],
    ['application/xml', '<?mode allowed?><r/>', '<?mode denied?><r/>'],
    ['application/x-www-form-urlencoded', 'ok=true', 'ok=false'],
  ])('preserves meaningful values in %s', async (mime, left, right) => {
    const result = await analyze(capture([exchange(left, mime), exchange(right, mime)]));
    expect(result.outcomes).toHaveLength(2);
  });

  it('canonicalizes JSON key order without erasing duplicate keys or business values', async () => {
    const result = await analyze(
      capture(['{"a":1,"b":2}', '{ "b":2, "a":1 }', '{"a":0,"a":1,"b":2}'].map((t) => exchange(t))),
    );
    expect(result.entries[0].outcome).toBe(result.entries[1].outcome);
    expect(result.entries[2].outcome).not.toBe(result.entries[0].outcome);
    expect(result.entries[2].body.shapeWarning).toBeTruthy();
  });

  it.each(['Location', 'Access-Control-Allow-Origin', 'WWW-Authenticate', 'Set-Cookie'])(
    'uses meaningful response header %s in partition identity',
    async (name) => {
      const rows = ['one', 'two'].map((value) => {
        const row = exchange();
        row.response.headers = [{ name, value }];
        return row;
      });
      expect((await analyze(capture(rows))).outcomes).toHaveLength(2);
    },
  );

  it('keeps exact equality stable across aggregate shape-budget exhaustion', async () => {
    // Exceed the bounded canonical cache, so exact identity must also survive cache eviction.
    const rows = [
      exchange('{"n":1}'),
      ...Array.from({ length: 4096 }, (_, i) => exchange(JSON.stringify({ n: i + 2 }))),
      exchange('{"n":1}'),
    ];
    const result = await analyze(capture(rows), undefined, { ...LIMITS, totalShapeNodes: 2 });
    expect(result.entries[0].outcome).toBe(result.entries.at(-1)!.outcome);
    expect(result.summary.shapeLimited).toBeGreaterThan(0);
  });

  it('retains every discovered partition beyond a display page', async () => {
    const result = await analyze(
      capture(
        Array.from({ length: 80 }, (_, i) =>
          exchange(`result ${String.fromCodePoint(0x410 + i)}`, 'text/plain'),
        ),
      ),
    );
    expect(result.outcomes).toHaveLength(80);
    expect(result.outcomes.every((g) => g.members.length === 1)).toBe(true);
  });

  it('groups request-correlated values while preserving uncorrelated business choices', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => {
      const payload = `payload-${i}abc`;
      const row = exchange(`Echo ${payload}`, 'text/plain');
      row.request.url += `?q=${payload}`;
      return row;
    });
    const result = await analyze(capture(rows), undefined, { ...LIMITS, totalBodyBytes: 0 });
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].match).toBe('inferred-reflection');
    const business = ['accepted', 'rejected', '12345678', '87654321', '11223344'].map((v) => {
      const row = exchange(`Result ${v}`, 'text/plain');
      return row;
    });
    expect((await analyze(capture(business))).outcomes).toHaveLength(5);
  });
});
