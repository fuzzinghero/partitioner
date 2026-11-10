import { compare } from './diff.js';
import { reflectSlot } from './slot-reflection.js';
import { slotInputs } from './request-evidence.js';
import { createRequestIndex, indexRequest, REQUEST_ANALYSIS_LIMITS } from './request-index.js';
import { Buffer } from 'node:buffer';
import { analyze as analyzeCore } from './core.js';
import { expect, it, describe } from 'vitest';
import { createHash } from 'node:crypto';
import { analyze, groupPage } from './analyze.js';
const token = (i: number) =>
  createHash('sha256')
    .update('sample-' + i)
    .digest('hex');
function entry(
  i: number,
  body: unknown,
  {
    query = 'x=' + i,
    headers = [],
    status = 400,
    mime = 'application/json',
    method = 'GET',
    postData,
  }: {
    query?: string;
    headers?: { name: string; value: string }[];
    status?: number;
    mime?: string;
    method?: string;
    postData?: unknown;
  } = {},
) {
  return {
    time: 20 + i,
    request: {
      method,
      url: 'https://example.test/items?' + query,
      headers: [],
      ...(postData ? { postData } : {}),
    },
    response: {
      status,
      headers,
      content: { mimeType: mime, text: typeof body === 'string' ? body : JSON.stringify(body) },
    },
  };
}
const cases: [string, ReturnType<typeof entry>[]][] = [
  [
    '1 unanchored metadata',
    Array.from({ length: 5 }, (_, i) =>
      entry(
        i,
        {
          ok: false,
          error: 'Invalid credentials',
          meta: { req_id: token(i), took_ms: [11, 14, 9, 18, 12][i] },
        },
        {
          method: 'POST',
          status: 401,
          headers: [{ name: 'X-Acme-Correlation', value: token(i).slice(0, 12) }],
        },
      ),
    ),
  ],
  [
    '2 cross-parameter reflection',
    ['alpha1234', 'bravo5678', 'charlie12', 'delta3456', 'echo7890', 'foxtrot12'].map((v, i) =>
      entry(
        i,
        { message: 'Rejected input: ' + v },
        { query: ['q', 'sort', 'page'][Math.floor(i / 2)] + '=' + v },
      ),
    ),
  ],
  [
    '3 short text',
    ['a', 'xy', 'abc', '-99'].map((v, i) =>
      entry(i, `Cannot parse "${v}" as integer`, { query: 'limit=' + v, mime: 'text/plain' }),
    ),
  ],
  [
    '4 cookies',
    Array.from({ length: 6 }, (_, i) =>
      entry(
        i,
        { error: 'Invalid coupon' },
        {
          status: 422,
          method: 'POST',
          postData: {
            mimeType: 'application/json',
            text: JSON.stringify({ coupon: String.fromCharCode(65 + i) }),
          },
          headers: [
            {
              name: 'Set-Cookie',
              value: `__Host-sess=${token(i)}; Path=/; HttpOnly; Secure; Max-Age=3600`,
            },
          ],
        },
      ),
    ),
  ],
  [
    '5 two states',
    Array.from({ length: 10 }, (_, i) =>
      entry(
        i,
        { error: i < 7 ? 'INSUFFICIENT_ROLE' : 'ACCOUNT_LOCKED', trace: token(i) },
        { status: 403, method: 'POST' },
      ),
    ),
  ],
  [
    '6 success reflection and token',
    ['a', 'b', 'c', 'long_payload_1', 'long_payload_2', 'long_payload_3'].map((v, i) =>
      entry(
        i,
        { greeting: `Hello ${v}!`, requestId: token(i) },
        { status: 200, query: 'name=' + v },
      ),
    ),
  ],
  [
    '7 numeric and keys',
    [101, 202, 303].map((v, i) =>
      entry(i, { inputId: v, results: { [v]: 'not_found' } }, { status: 200, query: 'id=' + v }),
    ),
  ],
  [
    '8 HTML',
    ['/a', '/b', '/admin', '/settings'].map((v, i) =>
      entry(
        i,
        `<html><body><form><input type="hidden" name="csrf" value="${token(i).slice(0, 32)}"><input type="hidden" name="next" value="${v}"></form><!-- rendered in ${i + 4}.2ms at 2026-11-09T16:00:0${i}Z --></body></html>`,
        { status: 200, query: 'next=' + encodeURIComponent(v), mime: 'text/html' },
      ),
    ),
  ],
  [
    'negative unique business amounts',
    [11, 14, 9, 18, 12].map((v, i) =>
      entry(i, { message: 'Available balance', amount: v }, { status: 200 }),
    ),
  ],
  [
    'negative resource identifiers',
    Array.from({ length: 5 }, (_, i) =>
      entry(i, { message: 'Resource selected', id: token(i) }, { status: 200 }),
    ),
  ],
  [
    'groups cache lifetime diagnostics',
    [60, 120, 180, 240].map((v, i) =>
      entry(
        i,
        { message: 'Rejected' },
        { headers: [{ name: 'Cache-Control', value: 'max-age=' + v }] },
      ),
    ),
  ],
  [
    'negative minority non-reflection',
    ['alpha1234', 'bravo5678', 'charlie12', 'delta3456', 'echo7890'].map((v, i) =>
      entry(
        i,
        { message: 'Rejected input: ' + (i === 4 ? 'ACCOUNT_LOCKED' : v) },
        { query: 'q=' + v },
      ),
    ),
  ],
];

const expected = [1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 2];
for (const [i, [name, entries]] of cases.entries()) {
  it(String(name), async () => {
    const raw = JSON.stringify({ log: { entries } });
    const a = await analyze(new Blob([raw]));
    expect(a.outcomes).toHaveLength(expected[i]);
    expect(a.outcomes.flatMap((g) => g.members).sort((x, y) => x - y)).toEqual(
      entries.map((_, i) => i),
    );
    expect(JSON.stringify({ log: { entries } })).toBe(raw);
  });
}
it('keeps malformed protocol-owned headers literal even when their values look like random tokens', async () => {
  const entries = Array.from({ length: 4 }, (_, i) =>
    entry(i, { error: 'Rejected' }, { headers: [{ name: 'traceparent', value: token(i) }] }),
  );
  expect((await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes).toHaveLength(
    4,
  );
});
it('normalizes telemetry tokens in plain text without requiring a reflected input', async () => {
  const entries = Array.from({ length: 2 }, (_, i) =>
    entry(i, `Error 500: trace 123e4567-e89b-42d3-a456-42661417400${i} took ${12 + i}.4ms`, {
      mime: 'text/plain',
    }),
  );
  const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
  expect(result.outcomes).toHaveLength(1);
  expect(result.outcomes[0].match).toBe('inferred-noise');
});
it('uses captured empty parameters to join a confirmed error template', async () => {
  const entries = ['a', 'b', ''].map((v, i) =>
    entry(i, { message: `Invalid value: '${v}'` }, { query: 'q=' + v }),
  );
  expect((await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes).toHaveLength(
    1,
  );
});
it('normalizes multiple cookie fields while preserving cookie order and attributes', async () => {
  const entries = Array.from({ length: 3 }, (_, i) =>
    entry(
      i,
      { error: 'Rejected' },
      {
        headers: [
          { name: 'Set-Cookie', value: 'first=' + token(i) + '; Secure; Path=/' },
          { name: 'Set-Cookie', value: 'second=' + token(i + 10) + '; HttpOnly; Path=/' },
        ],
      },
    ),
  );
  const a = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
  expect(a.outcomes).toHaveLength(1);
  expect(a.outcomes[0].normalizations).toContain('cookie-rotation');
  entries[2].response.headers.reverse();
  expect((await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes).toHaveLength(
    2,
  );
});
it('normalizes anonymous diagnostic header values and labels while retaining raw evidence', async () => {
  const entries = Array.from({ length: 4 }, (_, i) =>
    entry(
      i,
      { error: 'Rejected' },
      { headers: [{ name: 'X-Anonymous', value: `trace=${token(i)}; elapsed=${12 + i}.4ms` }] },
    ),
  );
  const a = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
  expect(a.outcomes).toHaveLength(1);
  expect(a.outcomes[0].normalizations).toContain('response-headers');
  entries[3].response.headers[0].value = `different=${token(3)}; elapsed=15.4ms`;
  expect((await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes).toHaveLength(
    1,
  );
});
it.each(['application/json', 'application/octet-stream'])(
  'normalizes headers around identical complete unsupported %s bodies without interpreting their bytes',
  async (mime) => {
    const entries = [0, 1, 2].map((i) =>
      entry(i, 'not a parsed document', {
        mime,
        headers: [{ name: 'X-Unknown', value: token(i) }],
      }),
    );
    const a = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
    expect(a.outcomes).toHaveLength(1);
    expect(new Set(a.entries.map((e) => e.body.hash)).size).toBe(1);
    entries[2].response.content.text = 'different complete body';
    expect((await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes).toHaveLength(
      2,
    );
  },
);

describe('capture-wide structural policy', () => {
  const values = ['payload-111', 'payload-222', 'payload-333'];
  const exchange = (value: string, text: string, mimeType = 'text/plain') => ({
    request: {
      method: 'GET',
      url: `https://example.test/echo?q=${value}`,
      headers: [] as { name: string; value: string }[],
    },
    response: { status: 200, headers: [], content: { mimeType, text } },
  });
  const capture = (entries: unknown[]) => new Blob([JSON.stringify({ log: { entries } })]);

  it('keeps reflection memberships independent of query retention and unrelated earlier requests', async () => {
    const cohort = values.map((value) => exchange(value, `Rejected value ${value}.`));
    const unrelated = Array.from({ length: 6 }, (_, i) =>
      exchange(String(i), 'Unrelated response'),
    );
    const original = REQUEST_ANALYSIS_LIMITS.retainedBytes;
    try {
      const fresh = await analyze(capture(cohort));
      expect(fresh.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
      REQUEST_ANALYSIS_LIMITS.retainedBytes = 0;
      for (const rows of [cohort, [...unrelated, ...cohort], [...cohort, ...unrelated.reverse()]]) {
        const result = await analyze(capture(rows));
        const ids = rows.flatMap((r, i) =>
          r.response.content.text.startsWith('Rejected') ? [i] : [],
        );
        expect(result.outcomes.find((g) => g.members.includes(ids[0]))?.members).toEqual(ids);
        expect(result.requestIndex!.rows.size).toBe(0);
        expect(result.requestIndex!.bytes).toBe(0);
        expect(result.summary.warnings.some((w) => /Request-change/.test(w))).toBe(true);
        expect(result.summary.warnings.some((w) => /reflection.*work/.test(w))).toBe(false);
      }
    } finally {
      REQUEST_ANALYSIS_LIMITS.retainedBytes = original;
    }
  });

  it.each([false, true])(
    'groups corroborated JSON value slots with exact evidence retained, reversed=%s',
    async (reversed) => {
      const rows = values.map((v) =>
        exchange(
          v,
          JSON.stringify({ error: 'invalid input', echo: v, accepted: false }),
          'application/json',
        ),
      );
      if (reversed) rows.reverse();
      const result = await analyze(capture(rows), { limits: { totalBodyBytes: 0 } });
      expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
      expect(result.outcomes[0].match).toBe('inferred-reflection');
      expect(new Set(result.entries.map((e) => e.body.hash)).size).toBe(3);
      expect(new Set(result.entries.map((e) => e.body.shape)).size).toBe(3);
    },
  );

  it('groups cookie-only echoes while retaining raw headers and individual values', async () => {
    const rows = values.map((v) => {
      const row = exchange(v, `Rejected cookie ${v}.`);
      row.request.url = 'https://example.test/echo';
      row.request.headers = [{ name: 'Cookie', value: `session=${v}; role=admin` }];
      return row;
    });
    const result = await analyze(capture(rows));
    expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
    expect(result.requestIndex!.rows.get(0)!.categories.get('Cookie')?.get('session')).toBe(
      '["payload-111"]',
    );
    expect(result.entries[0].requestHeaders[0].value).toBe('session=payload-111; role=admin');
  });

  it.each(['opaque-result-A', '11111111-1111-4111-8111-111111111111'])(
    'normalizes unreflected correlation values on missing-body responses: %s',
    async (token) => {
      const rows = [token, token.replace(/.$/, '2')].map((value) => ({
        request: { method: 'GET', url: 'https://example.test/echo', headers: [] },
        response: {
          status: 200,
          headers: [{ name: 'X-Correlation-ID', value }],
          content: { mimeType: 'text/plain' },
        },
      }));
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1]]);
      expect(result.outcomes[0].match).toBe('inferred-noise');
      expect(
        result.entries.every((e) => e.body.state === 'missing' && e.body.hash === undefined),
      ).toBe(true);
      expect(result.entries[0].responseHeaders).toEqual(rows[0].response.headers);
      expect(compare(result.entries[0], result.entries[1]).headers[0]).toMatchObject({
        reference: `X-Correlation-ID: ${token}`,
        comparison: `X-Correlation-ID: ${rows[1].response.headers[0].value}`,
      });
    },
  );

  it.each([
    ['whole scalar', (v: string, _i: number) => JSON.stringify(v)],
    ['wrapped whole echo', (v: string, _i: number) => JSON.stringify({ echo: v })],
    ['array echo', (v: string, _i: number) => JSON.stringify({ echo: [v], error: 'invalid' })],
    [
      'multiple occurrences',
      (v: string, _i: number) => JSON.stringify({ echo: v, decision: v, error: 'invalid' }),
    ],
    ['different decisions', (v: string, i: number) => JSON.stringify({ echo: v, code: 400 + i })],
    [
      'different paths',
      (v: string, i: number) => JSON.stringify({ ['echo' + i]: v, error: 'invalid' }),
    ],
    [
      'null and missing',
      (v: string, i: number) =>
        JSON.stringify({
          echo: v,
          error: 'invalid',
          ...(i === 0 ? {} : { other: i === 1 ? null : false }),
        }),
    ],
    ['numeric lexemes', (v: string, i: number) => `{"echo":"${v}","n":${['1', '1.0', '1e0'][i]}}`],
    [
      'array order and length',
      (v: string, i: number) =>
        JSON.stringify({ echo: v, error: 'invalid', items: [[1, 2], [2, 1], [1]][i] }),
    ],
    [
      'duplicate keys',
      (v: string, _i: number) => `{"echo":"${v}","echo":"ignored","error":"invalid"}`,
    ],
    [
      'substring echo',
      (v: string, _i: number) => JSON.stringify({ echo: `prefix ${v}`, error: 'invalid' }),
    ],
  ])('checks JSON reflection boundaries for %s', async (label, body) => {
    for (const reverse of [false, true]) {
      const rows = values.map((v, i) => exchange(v, body(v, i), 'application/json'));
      if (reverse) rows.reverse();
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((g) => g.members)).toEqual(
        [
          'whole scalar',
          'wrapped whole echo',
          'array echo',
          'multiple occurrences',
          'substring echo',
        ].includes(label)
          ? [[0, 1, 2]]
          : [[0], [1], [2]],
      );
    }
  });

  it('preserves types and hard response boundaries even in corroborated JSON cohorts', async () => {
    const rows = [false, 'false', null, 0, {}].flatMap((decision) =>
      values.map((v) => exchange(v, JSON.stringify({ echo: v, decision }), 'application/json')),
    );
    const result = await analyze(capture(rows));
    expect(result.outcomes.map((g) => g.members)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [9, 10, 11],
      [12, 13, 14],
    ]);
    const boundaries = values.map((v, i) => ({
      ...exchange(v, JSON.stringify({ echo: v, error: 'invalid' }), 'application/json'),
      response: {
        ...exchange(v, '').response,
        status: 400 + i,
        content: {
          mimeType: 'application/json',
          text: JSON.stringify({ echo: v, error: 'invalid' }),
        },
      },
    }));
    expect((await analyze(capture(boundaries))).outcomes.map((g) => g.members)).toEqual([
      [0],
      [1],
      [2],
    ]);
  });

  it('decodes query values once, retains repeated parameter positions and accepts escaped JSON strings', async () => {
    const rows = ['payload-111"', 'payload-222"', 'payload-333"'].map((v) => {
      const row = exchange(v, JSON.stringify({ echo: v, error: 'invalid' }), 'application/json');
      row.request.url = `https://example.test/echo?q=constant&q=${encodeURIComponent(v)}`;
      return row;
    });
    expect((await analyze(capture(rows))).outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
    const moved = rows.map((r, i) => ({
      ...r,
      request: {
        ...r.request,
        url:
          i === 1
            ? r.request.url.replace('?q=constant&q=', '?q=').replace(/$/, '&q=constant')
            : r.request.url,
      },
    }));
    expect((await analyze(capture(moved))).outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
  });

  it('groups the same reflected value independently of which request field supplied it', async () => {
    const rows = values.map((v) => {
      const row = exchange(v, JSON.stringify({ echo: v, error: 'invalid' }), 'application/json');
      row.request.url += `&other=${v}`;
      return row;
    });
    expect((await analyze(capture(rows))).outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
  });

  it('confirms reflection from two distinct matched JSON values', async () => {
    const result = await analyze(
      capture(
        values
          .slice(0, 2)
          .map((v) =>
            exchange(v, JSON.stringify({ echo: v, error: 'invalid' }), 'application/json'),
          ),
      ),
    );
    expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1]]);
  });

  it('retains quoted and duplicate cookie occurrences across multiple header fields', async () => {
    const rows = values.map((v) => {
      const row = exchange(v, `Rejected cookie ${v}.`);
      row.request.url = 'https://example.test/echo';
      row.request.headers = [
        { name: 'Cookie', value: `session="${v}"; session=other-123` },
        { name: 'cookie', value: 'role=admin' },
      ];
      return row;
    });
    const result = await analyze(capture(rows));
    expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
    expect(result.requestIndex!.rows.get(0)!.categories.get('Cookie')).toEqual(
      new Map([
        ['session', '["payload-111","other-123"]'],
        ['role', '["admin"]'],
      ]),
    );
    expect(result.entries[0].requestHeaders).toEqual(rows[0].request.headers);
  });

  it.each(['text/plain', 'application/json'])(
    'uses HAR cookie values only with available headers and no Cookie header in %s',
    async (mime) => {
      const rows = values.map((v) => ({
        ...exchange(
          v,
          mime === 'application/json'
            ? JSON.stringify({ echo: v, error: 'invalid' })
            : `Rejected cookie ${v}.`,
          mime,
        ),
        request: {
          method: 'GET',
          url: 'https://example.test/echo',
          headers: [],
          cookies: [{ name: 'session', value: v }],
        },
      }));
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
      expect(result.requestIndex!.rows.get(0)!.categories.get('Cookie')?.get('session')).toBe(
        '["payload-111"]',
      );
      const conflicting = rows.map((r) => ({
        ...r,
        request: { ...r.request, headers: [{ name: 'Cookie', value: 'session=constant-123' }] },
      }));
      const conflict = await analyze(capture(conflicting));
      expect(conflict.outcomes.map((g) => g.members)).toEqual([[0], [1], [2]]);
      expect(
        conflict.entries.every((e) => e.diagnostics?.some((d) => /conflict.*HAR cookies/.test(d))),
      ).toBe(true);
      expect(conflict.requestIndex!.rows.get(0)!.sources?.get('Cookie')).toBe('headers');
      expect(conflict.requestIndex!.rows.get(0)!.categories.get('Cookie')?.get('session')).toBe(
        '["constant-123"]',
      );
    },
  );

  it.each(
    ['text/plain', 'application/json'].flatMap((mime) =>
      [
        { label: 'omitted', headers: undefined },
        { label: 'null', headers: null },
        { label: 'non-array', headers: {} },
        { label: 'invalid field', headers: [{ name: 'Cookie', value: 123 }] },
      ].map((input) => ({ mime, ...input })),
    ),
  )('keeps HAR-cookie echoes separate with $label request headers in $mime', async (input) => {
    const rows = values.map((v) => ({
      ...exchange(
        '',
        input.mime === 'application/json'
          ? JSON.stringify({ echo: v, error: 'invalid' })
          : `Rejected cookie ${v}.`,
        input.mime,
      ),
      request: {
        method: 'GET',
        url: 'https://example.test/echo',
        headers: input.headers,
        cookies: [{ name: 'session', value: v }],
      },
    }));
    const result = await analyze(capture(rows));
    expect(result.outcomes.map((g) => g.members)).toEqual([[0], [1], [2]]);
    expect(result.outcomes.every((g) => g.match !== 'inferred-reflection')).toBe(true);
    expect(new Set(result.entries.map((e) => e.body.hash)).size).toBe(3);
    const categories = result.requestIndex!.rows.get(0)!.categories;
    expect(categories.has('Header')).toBe(false);
    expect(categories.get('Cookie')?.get('session')).toBe('["payload-111"]');
  });

  it.each([
    'session="unterminated',
    'bad; session=payload-111',
    'session=payload-111\r\nInjected: bad',
  ])('keeps malformed cookie syntax as raw evidence: %s', async (value) => {
    const row = exchange('', 'Rejected cookie payload-111.');
    row.request.url = 'https://example.test/echo';
    row.request.headers = [{ name: 'Cookie', value }];
    const result = await analyze(capture([row]));
    expect(result.entries[0].requestHeaders[0].value).toBe(value);
    expect(result.requestIndex!.rows.get(0)!.categories.has('Cookie')).toBe(false);
    expect(result.requestIndex!.rows.get(0)!.categories.get('Header')).toBeDefined();
    expect(result.requestIndex!.rows.get(0)!.categories.has('Incomplete')).toBe(false);
  });

  it('groups reflected cookie values while bounding excessive cookie extraction', async () => {
    const rows = ['admin', 'guest', 'staff'].map((role) => ({
      ...exchange('', `Role ${role}.`),
      request: {
        method: 'GET',
        url: 'https://example.test/echo',
        headers: [{ name: 'Cookie', value: `role=${role}` }],
      },
    }));
    const result = await analyze(capture(rows));
    expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
    expect(result.requestIndex!.rows.get(1)!.categories.get('Cookie')?.get('role')).toBe(
      '["guest"]',
    );
    const excessive = exchange('', 'ok');
    excessive.request.headers = [
      { name: 'Cookie', value: Array.from({ length: 201 }, (_, i) => `c${i}=v`).join('; ') },
    ];
    const limited = await analyze(capture([excessive]));
    expect(limited.requestIndex!.rows.get(0)!.categories.has('Cookie')).toBe(false);
    expect(limited.entries[0].requestHeaders).toEqual(excessive.request.headers);
  });

  it.each(['retainedBytes', 'work'] as const)(
    'returns the same transient reflection evidence when query %s is saturated',
    async (kind) => {
      const raw = exchange('payload-111', 'Rejected payload-111.');
      const analysis = await analyze(capture([raw]));
      const entry = analysis.entries[0];
      const fresh = createRequestIndex(),
        saturated = createRequestIndex();
      if (kind === 'work') saturated.work = REQUEST_ANALYSIS_LIMITS.work;
      else saturated.bytes = REQUEST_ANALYSIS_LIMITS.retainedBytes;
      const freshRow = indexRequest(fresh, entry, raw),
        saturatedRow = indexRequest(saturated, entry, raw);
      expect(saturatedRow).toEqual(freshRow);
      expect(saturated.rows.size).toBe(0);
      expect(saturated.pools?.fields.size ?? 0).toBe(0);
      expect(saturated.pools?.vectors.size ?? 0).toBe(0);
      expect(saturated.limited).toBe(true);
      const template = reflectSlot(entry.body.text!, slotInputs(entry, freshRow)!, () => true);
      expect(template?.parts).toContainEqual({ reflected: 0, encoding: 'literal' });
      expect(reflectSlot(entry.body.text!, slotInputs(entry, saturatedRow)!, () => true)).toEqual(
        template,
      );
    },
  );

  it('keeps later reflection observations available after substantial capture work', async () => {
    const rows = Array.from({ length: 1200 }, () =>
      exchange('payload-111', 'unrelated '.repeat(1600)),
    );
    const cohort = values.map((v) => exchange(v, `Rejected value ${v}.`));
    const result = await analyze(capture([...rows, ...cohort]));
    expect(result.outcomes.find((g) => g.members.includes(1200))?.members).toEqual([
      1200, 1201, 1202,
    ]);
    expect(result.summary.reflection?.captureLimited).toBe(0);
    expect(result.summary.reflection?.entryLimited).toBe(0);
    expect(result.summary.reflection?.work).toBeGreaterThan(0);
    expect(result.requestIndex!.limited).toBe(false);
    expect(result.summary.warnings.some((w) => /reflection.*work/.test(w))).toBe(false);
  });

  it('normalizes repeated diagnostic values while preserving malformed header boundaries', async () => {
    const rows = ['a', 'b'].flatMap((v) => [
      {
        ...exchange('', 'same'),
        response: {
          status: 200,
          headers: [
            { name: 'X-Correlation-ID', value: v },
            { name: 'X-Correlation-ID', value: 'constant' },
          ],
          content: { mimeType: 'text/plain', text: 'same' },
        },
      },
      {
        ...exchange('', 'same'),
        response: {
          status: 200,
          headers: [{ name: 'X-Correlation-ID', value: v + '\n' }],
          content: { mimeType: 'text/plain', text: 'same' },
        },
      },
    ]);
    const result = await analyze(capture(rows));
    expect(result.outcomes.map((g) => g.members)).toEqual([[0, 2], [1], [3]]);
  });

  it.each([
    Array.from({ length: 201 }, (_, i) => ({ name: `c${i}`, value: 'payload-111' })),
    [{ name: 'session', value: 'x'.repeat(8193) }],
  ])('bounds streamed HAR cookies even when the host expands metadata limits', async (cookies) => {
    const row = {
      ...exchange('', 'Rejected payload-111.'),
      request: { method: 'GET', url: 'https://example.test/echo', headers: [], cookies },
    };
    const result = await analyze(capture([row]), {
      limits: { headers: 4096, fieldChars: 1024 * 1024 },
    });
    expect(result.requestIndex!.rows.get(0)!.categories.get('Cookie')).toEqual(new Map());
    expect(result.requestIndex!.rows.get(0)!.sources?.get('Cookie')).toBe('headers');
    expect(result.requestIndex!.rows.get(0)!.categories.get('Header')).toBeDefined();
    expect(result.requestIndex!.rows.get(0)!.categories.has('Incomplete')).toBe(false);
  });

  it('groups matched values without introducing request field names into identity', async () => {
    const rows = values.map((v) => {
      const row = exchange(v, JSON.stringify({ echo: v, error: 'invalid' }), 'application/json');
      row.request.url =
        'https://example.test/echo?' +
        Array.from(
          { length: 33 },
          (_, i) => `q${i}=${i === 0 || i === 32 ? v : `unused-${i}000`}`,
        ).join('&');
      return row;
    });
    const result = await analyze(capture(rows));
    expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
    expect(result.summary.reflection?.entryLimited).toBe(0);
  });

  it.each([false, true])(
    'groups complete JSON echoes using matched leaf values, reordered=%s',
    async (reordered) => {
      const rows = values.map((value) => ({
        request: {
          method: 'POST',
          url: 'https://example.test/echo',
          headers: [],
          postData: {
            mimeType: 'application/json',
            text: JSON.stringify({ value, accepted: false }),
          },
        },
        response: {
          status: 200,
          headers: [],
          content: {
            mimeType: 'application/json',
            text: JSON.stringify(
              reordered ? { accepted: false, value } : { value, accepted: false },
            ),
          },
        },
      }));
      for (const entries of [rows, [...rows].reverse()]) {
        const result = await analyze(capture(entries), { limits: { totalBodyBytes: 0 } });
        expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
        expect(result.entries.every((e) => e.body.hash !== undefined)).toBe(true);
      }
    },
  );

  it.each([
    ['1', '1.0'],
    ['100', '1e2'],
    ['0.001', '1e-3'],
    ['-0', '0'],
    ['9007199254740993', '9007199254740993.0'],
    ['1e90071992547409930000', '10e90071992547409929999'],
  ])(
    'preserves constant numeric lexemes while grouping reflected leaves: %s to %s',
    async (before, after) => {
      const rows = values.map((value) => ({
        request: {
          method: 'POST',
          url: 'https://example.test/echo',
          headers: [],
          postData: {
            mimeType: 'application/json',
            text: `{"value":"${value}","count":${before}}`,
          },
        },
        response: {
          status: 400,
          headers: [],
          content: {
            mimeType: 'application/json',
            text: `{"request":{"value":"${value}","count":${after}}}`,
          },
        },
      }));
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
      expect(new Set(result.entries.map((e) => e.body.hash)).size).toBe(3);
    },
  );

  it.each([
    ['9007199254740992', '9007199254740993'],
    ['1e90071992547409930000', '1e90071992547409930001'],
  ])('recognizes distinct lossless response evidence %s vs %s', async (before, after) => {
    const rows = values.map((value) => ({
      request: {
        method: 'POST',
        url: 'https://example.test/echo',
        headers: [],
        postData: { mimeType: 'application/json', text: `{"value":"${value}","count":${before}}` },
      },
      response: {
        status: 400,
        headers: [],
        content: { mimeType: 'application/json', text: `{"value":"${value}","count":${after}}` },
      },
    }));
    const result = await analyze(capture(rows));
    expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
    expect(result.outcomes[0].match).toBe('inferred-reflection');
  });

  type EchoRequest = { value: string; accepted: boolean };

  it('retains a late query-reflection cohort after 8 MB of corroborated JSON responses', async () => {
    const error = 'invalid input ' + 'x'.repeat(1040);
    const row = (value: string) =>
      exchange(value, JSON.stringify({ echo: value, error }), 'application/json');
    const entries = [...Array.from({ length: 8000 }, () => row('prefix-000')), ...values.map(row)];
    const result = await analyze(capture(entries), { limits: { totalBodyBytes: 0 } });
    expect(result.outcomes.find((g) => g.members.includes(8000))?.members).toEqual(
      Array.from({ length: 8003 }, (_, i) => i),
    );
    expect(result.summary.reflection?.captureLimited).toBe(0);
  }, 15_000);

  it.each([
    'missing media type',
    'invalid media type',
    'opaque media type',
    'unavailable form',
    'exporter form',
    'invalid captured text',
    'invalid exporter fields',
  ])('uses only available request evidence for %s', async (mode) => {
    const rows = values.map((value) => ({
      request: {
        method: 'POST',
        url: `https://example.test/echo?q=${value}`,
        headers: [],
        postData:
          mode === 'invalid exporter fields'
            ? { params: { invalid: true } }
            : mode === 'exporter form'
              ? {
                  mimeType: 'application/x-www-form-urlencoded',
                  params: [{ name: 'accepted', value: 'false' }],
                }
              : {
                  ...(mode === 'invalid media type'
                    ? { mimeType: 'application/json\r\ninvalid' }
                    : mode === 'opaque media type'
                      ? { mimeType: 'text/plain' }
                      : mode === 'unavailable form'
                        ? { mimeType: 'application/x-www-form-urlencoded' }
                        : {}),
                  text:
                    mode === 'invalid captured text'
                      ? 123
                      : mode === 'unavailable form'
                        ? ' '.repeat(65536)
                        : JSON.stringify({ value, accepted: false }),
                },
      },
      response: {
        status: 400,
        headers: [],
        content: {
          mimeType: 'application/json',
          text: JSON.stringify({ request: { value, accepted: false } }),
        },
      },
    }));
    const result = await analyze(capture(rows));
    expect(result.outcomes.map((g) => g.members)).toEqual(
      [
        'missing media type',
        'opaque media type',
        'invalid media type',
        'unavailable form',
      ].includes(mode)
        ? [[0, 1, 2]]
        : [[0], [1], [2]],
    );
    expect(new Set(result.entries.map((e) => e.body.hash)).size).toBe(3);
  });

  it('allows JSON query reflection with a captured empty opaque body', async () => {
    const rows = values.map((value) => ({
      ...exchange(
        value,
        JSON.stringify({ echo: value, error: 'invalid input' }),
        'application/json',
      ),
      request: { ...exchange(value, '').request, postData: { mimeType: 'text/plain', text: '' } },
    }));
    expect((await analyze(capture(rows))).outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
  });

  it.each([
    {
      label: 'structure byte limit',
      text: (v: string) => ' '.repeat(65536) + JSON.stringify({ value: v, accepted: false }),
    },
    {
      label: 'structure field limit',
      text: (v: string) =>
        JSON.stringify({
          value: v,
          accepted: false,
          ...Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i])),
        }),
    },
    {
      label: 'structure depth limit',
      text: (v: string) =>
        '{"nested":'.repeat(34) + JSON.stringify({ value: v, accepted: false }) + '}'.repeat(34),
    },
    { label: 'malformed JSON', text: (v: string) => `{"value":"${v}","accepted":false` },
    {
      label: 'duplicate keys',
      text: (v: string) => `{"value":"unused","value":"${v}","accepted":false}`,
    },
    {
      label: 'body admission limit',
      text: (v: string) => ' '.repeat(1024) + JSON.stringify({ value: v, accepted: false }),
      bodyBytes: 128,
    },
    { label: 'missing declared JSON', text: (_v: string) => undefined },
    { label: 'missing header-declared JSON', text: (_v: string) => undefined, header: true },
  ])('uses complete query evidence without partial JSON fields for $label', async (input) => {
    const rows = values.map((value) => ({
      request: {
        method: 'POST',
        url: `https://example.test/echo?q=${value}`,
        headers: input.header ? [{ name: 'Content-Type', value: 'application/problem+json' }] : [],
        postData: {
          ...(!input.header && { mimeType: 'application/json' }),
          text: input.text(value),
        },
      },
      response: {
        status: 400,
        headers: [],
        content: {
          mimeType: 'application/json',
          text: JSON.stringify({ request: { value, accepted: false } }),
        },
      },
    }));
    const result = await analyze(capture(rows), {
      limits: { totalBodyBytes: 0, ...(input.bodyBytes && { bodyBytes: input.bodyBytes }) },
    });
    expect(result.outcomes.map((g) => g.members)).toEqual(
      [
        'structure field limit',
        'structure depth limit',
        'malformed JSON',
        'duplicate keys',
      ].includes(input.label)
        ? [[0, 1, 2]]
        : [[0], [1], [2]],
    );
    expect(new Set(result.entries.map((e) => e.body.hash)).size).toBe(3);
    const categories = result.requestIndex!.rows.get(0)!.categories;
    expect(categories.get('Query parameter')?.get('q')).toBe('["payload-111"]');
    expect(categories.has('JSON')).toBe(false);
  });

  it.each(['{}', '{"unrelated":true}'])(
    'allows query reflection with an available JSON request body %s',
    async (text) => {
      const rows = values.map((value) => ({
        ...exchange(
          value,
          JSON.stringify({ echo: value, error: 'invalid input' }),
          'application/json',
        ),
        request: {
          ...exchange(value, '').request,
          method: 'POST',
          postData: { mimeType: 'application/json', text },
        },
      }));
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
      expect(result.outcomes[0].match).toBe('inferred-reflection');
    },
  );

  it('retains unavailable-JSON protection independently of query retention', async () => {
    const rows = values.map((value) => ({
      request: {
        method: 'POST',
        url: `https://example.test/echo?q=${value}`,
        headers: [],
        postData: {
          mimeType: 'application/json',
          text: ' '.repeat(65536) + JSON.stringify({ value, accepted: false }),
        },
      },
      response: {
        status: 400,
        headers: [],
        content: {
          mimeType: 'application/json',
          text: JSON.stringify({ request: { value, accepted: false } }),
        },
      },
    }));
    const original = REQUEST_ANALYSIS_LIMITS.retainedBytes;
    try {
      REQUEST_ANALYSIS_LIMITS.retainedBytes = 0;
      const result = await analyze(capture(rows), { limits: { totalBodyBytes: 0 } });
      expect(result.requestIndex!.rows.size).toBe(0);
      expect(result.outcomes.map((g) => g.members)).toEqual([[0], [1], [2]]);
      expect(new Set(result.entries.map((e) => e.body.hash)).size).toBe(3);
    } finally {
      REQUEST_ANALYSIS_LIMITS.retainedBytes = original;
    }
  });

  it.each([
    ['object envelope', (request: EchoRequest) => ({ request })],
    ['nested envelope', (request: EchoRequest) => ({ result: { request } })],
    [
      'renamed fields',
      (request: EchoRequest) => ({ submitted: request.value, flag: request.accepted }),
    ],
    ['echoed sibling', (request: EchoRequest) => ({ request, accepted: request.accepted })],
    [
      'echoed array metadata',
      (request: EchoRequest) => ({ request, metadata: [request.accepted] }),
    ],
  ])('groups matched request leaves inside a %s', async (_label, wrap) => {
    const rows = values.map((value) => {
      const request = { value, accepted: false };
      return {
        request: {
          method: 'POST',
          url: 'https://example.test/echo',
          headers: [],
          postData: { mimeType: 'application/json', text: JSON.stringify(request) },
        },
        response: {
          status: 400,
          headers: [],
          content: { mimeType: 'application/json', text: JSON.stringify(wrap(request)) },
        },
      };
    });
    for (const entries of [rows, [...rows].reverse()]) {
      const result = await analyze(capture(entries), { limits: { totalBodyBytes: 0 } });
      expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
      expect(new Set(result.entries.map((e) => e.body.hash)).size).toBe(3);
      expect(result.entries.every((e) => e.body.hash !== undefined)).toBe(true);
    }
  });

  it.each([false, true])(
    'infers a wrapped request slot with independent response evidence, evicted=%s',
    async (evicted) => {
      const rows = values.map((value) => {
        const request = { value, accepted: false };
        return {
          request: {
            method: 'POST',
            url: 'https://example.test/echo',
            headers: [],
            postData: { mimeType: 'application/json', text: JSON.stringify(request) },
          },
          response: {
            status: 400,
            headers: [],
            content: {
              mimeType: 'application/json',
              text: JSON.stringify({ request, error: 'invalid input' }),
            },
          },
        };
      });
      const original = REQUEST_ANALYSIS_LIMITS.retainedBytes;
      try {
        if (evicted) REQUEST_ANALYSIS_LIMITS.retainedBytes = 0;
        const result = await analyze(capture(rows), { limits: { totalBodyBytes: 0 } });
        expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
        expect(result.outcomes[0].match).toBe('inferred-reflection');
        expect(new Set(result.entries.map((e) => e.body.hash)).size).toBe(3);
        if (evicted) expect(result.requestIndex!.rows.size).toBe(0);
      } finally {
        REQUEST_ANALYSIS_LIMITS.retainedBytes = original;
      }
    },
  );

  it('still infers a JSON request value slot when the response adds independent evidence', async () => {
    const rows = values.map((value) => ({
      request: {
        method: 'POST',
        url: 'https://example.test/echo',
        headers: [],
        postData: { mimeType: 'application/json', text: JSON.stringify({ value }) },
      },
      response: {
        status: 400,
        headers: [],
        content: {
          mimeType: 'application/json',
          text: JSON.stringify({ value, error: 'invalid input' }),
        },
      },
    }));
    expect((await analyze(capture(rows))).outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
  });

  it.each([7, 9])(
    'bounds HAR cookie extraction by UTF-8 bytes across %s multibyte values',
    async (count) => {
      const row = {
        ...exchange('', 'same'),
        request: {
          method: 'GET',
          url: 'https://example.test/echo',
          headers: [],
          cookies: Array.from({ length: count }, (_, i) => ({
            name: `c${i}`,
            value: 'é'.repeat(4096),
          })),
        },
      };
      const result = await analyze(capture([row]));
      const categories = result.requestIndex!.rows.get(0)!.categories;
      expect(categories.get('Cookie')?.size).toBe(count === 7 ? 7 : 0);
      expect(result.requestIndex!.rows.get(0)!.sources?.get('Cookie')).toBe(
        count === 7 ? 'har' : 'headers',
      );
      expect(categories.get('Header')).toEqual(new Map());
      expect(categories.has('Incomplete')).toBe(false);
    },
  );

  it.each(['text/plain', 'application/json'])(
    'groups request-correlated Unicode words in %s responses',
    async (mime) => {
      const rows = ['Français', 'Português', 'Ελληνικά'].map((value) => {
        const row = exchange(
          value,
          mime === 'application/json'
            ? JSON.stringify({ language: value, accepted: true })
            : `Selected language ${value}.`,
          mime,
        );
        row.request.url = `https://example.test/echo?language=${encodeURIComponent(value)}`;
        return row;
      });
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
    },
  );

  it('finds the JSON query slot behind realistic browser headers and analytics cookies', async () => {
    const rows = values.map((value) => ({
      ...exchange(
        value,
        JSON.stringify({ query: value, error: 'invalid input' }),
        'application/json',
      ),
      request: {
        ...exchange(value, '').request,
        headers: [
          ...[
            'User-Agent',
            'Accept',
            'Accept-Language',
            'Accept-Encoding',
            'Referer',
            'Origin',
            'Sec-CH-UA',
            'Sec-Fetch-Site',
            'Sec-Fetch-Mode',
            'X-Request-ID',
            'X-CSRF-Token',
          ].map((name, i) => ({ name, value: `browser-${i}-value` })),
          {
            name: 'Cookie',
            value: Array.from({ length: 25 }, (_, i) => `analytics${i}=tracking-${i}-token`).join(
              '; ',
            ),
          },
        ],
      },
    }));
    const result = await analyze(capture(rows));
    expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
    expect(result.outcomes[0].match).toBe('inferred-reflection');
    expect(result.summary.reflection?.entryLimited).toBe(0);
  });

  it('distinguishes matching-candidate exhaustion from work exhaustion', async () => {
    const rows = values.map((value) => {
      const row = exchange(
        value,
        JSON.stringify({ query: value, error: 'invalid input' }),
        'application/json',
      );
      row.request.url =
        'https://example.test/echo?' +
        Array.from({ length: 200 }, (_, i) => `q${i}=${value}`).join('&');
      return row;
    });
    const result = await analyze(capture(rows));
    expect(result.outcomes.map((g) => g.members)).toEqual([[0], [1], [2]]);
    expect(result.summary.reflection).toMatchObject({
      entryLimited: 0,
      captureLimited: 0,
      candidateLimited: 3,
    });
    expect(result.summary.warnings.some((w) => /candidate limit/i.test(w))).toBe(true);
    expect(result.summary.warnings.some((w) => /reflection work limit/i.test(w))).toBe(false);
  });

  it.each([false, true])(
    'preserves a late JSON reflection cohort after 8 MB of irrelevant JSON, requestValue=%s',
    async (requestValue) => {
      const text = JSON.stringify({ message: 'x'.repeat(1040) });
      const prefix = Array.from({ length: 8000 }, () => ({
        request: {
          method: 'GET',
          url: 'https://example.test/bulk' + (requestValue ? '?q=unrelated-token' : ''),
          headers: [],
        },
        response: { status: 200, headers: [], content: { mimeType: 'application/json', text } },
      }));
      const cohort = values.map((v) =>
        exchange(v, JSON.stringify({ echo: v, error: 'invalid input' }), 'application/json'),
      );
      const result = await analyze(capture([...prefix, ...cohort]), {
        limits: { totalBodyBytes: 0 },
      });
      expect(result.outcomes.find((g) => g.members.includes(8000))?.members).toEqual([
        8000, 8001, 8002,
      ]);
      expect(result.outcomes.find((g) => g.members.includes(8000))?.match).toBe(
        'inferred-reflection',
      );
      expect(result.summary.reflection?.work).toBeLessThan(12 * 1024 * 1024);
      expect(result.summary.reflection?.captureLimited).toBe(0);
      expect(result.summary.warnings.some((w) => /reflection.*limit/.test(w))).toBe(false);
    },
  );

  it.each(['unicode', 'solidus', 'quote'])(
    'keeps exact JSON reflection matching through %s escapes',
    async (encoding) => {
      const rows = values.map((v) => {
        const value = encoding === 'solidus' ? v + '/end' : encoding === 'quote' ? v + '"end' : v;
        const json = JSON.stringify({ echo: value, error: 'invalid input' });
        const text =
          encoding === 'unicode'
            ? json.replaceAll('payload', '\\u0070ayload')
            : encoding === 'solidus'
              ? json.replaceAll('/', '\\/')
              : json;
        const row = exchange(value, text, 'application/json');
        row.request.url = `https://example.test/echo?q=${encodeURIComponent(value)}`;
        return row;
      });
      expect((await analyze(capture(rows))).outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
    },
  );

  it.each(['\\q', '\\u00xx'])(
    'preserves exact fallback for invalid JSON escape %s before lexical matching',
    async (escape) => {
      const rows = values.map((value) =>
        exchange(value, `{"echo":"${value}${escape}","error":"invalid input"}`, 'application/json'),
      );
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((g) => g.members)).toEqual([[0], [1], [2]]);
      expect(result.entries.every((e) => e.body.hash && e.body.shapeWarning)).toBe(true);
    },
  );

  it.each(['text/plain', 'text/html'])(
    'skips partial templates above the matching-source cap for %s',
    async (mime) => {
      const rows = values.map((value) => {
        const row = exchange(
          value,
          mime === 'text/html' ? `<p>Rejected ${value}.</p>` : `Rejected ${value}.`,
          mime,
        );
        row.request.url =
          'https://example.test/echo?' +
          Array.from({ length: 200 }, (_, i) => `q${i}=${value}`).join('&');
        return row;
      });
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((g) => g.members)).toEqual([[0], [1], [2]]);
      expect(result.summary.reflection).toMatchObject({
        candidateLimited: 3,
        entryLimited: 0,
        captureLimited: 0,
      });
      expect(result.entries.every((e) => e.body.hash)).toBe(true);
    },
  );

  it('groups a 500-request capture despite varying transport noise while preserving raw header differences', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => {
      const id = createHash('sha256')
        .update('request-' + i)
        .digest('hex')
        .slice(0, 32);
      const span = createHash('sha256')
        .update('span-' + i)
        .digest('hex')
        .slice(0, 16);
      const text =
        i % 2 ? '{ "error": "rejected", "ok": false }' : '{"ok":false,"error":"rejected"}';
      return {
        request: { method: 'GET', url: `https://example.test/batch?q=payload-${i}`, headers: [] },
        response: {
          status: 400,
          headers: [
            { name: 'Date', value: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toUTCString() },
            { name: 'Content-Length', value: String(new TextEncoder().encode(text).length) },
            { name: 'Example-Request', value: id },
            {
              name: 'Example-Correlation',
              value: createHash('sha256')
                .update('other-' + i)
                .digest('hex')
                .slice(0, 32),
            },
            { name: 'traceparent', value: `00-${id}-${span}-01` },
            { name: 'tracestate', value: `vendor=trace-${id}` },
            { name: 'Example-Context', value: id },
          ],
          content: { mimeType: 'application/json', text },
        },
      };
    });
    const result = await analyze(capture(rows));
    expect(result.outcomes.map((g) => g.members)).toEqual([
      Array.from({ length: 500 }, (_, i) => i),
    ]);
    expect(result.outcomes[0].match).toBe('inferred-noise');
    expect(new Set(result.entries.map((e) => e.body.hash)).size).toBe(2);
    expect(result.entries[0].responseHeaders).toEqual(rows[0].response.headers);
    expect(result.entries[499].responseHeaders).toEqual(rows[499].response.headers);
    const differences = compare(result.entries[0], result.entries[1]).headers;
    expect(differences).toHaveLength(7);
    expect(differences[0].reference).toBe('Date: Thu, 01 Jan 2026 00:00:00 GMT');
    expect(differences[1].reference).toBe(
      `Content-Length: ${rows[0].response.content.text.length}`,
    );
  });

  describe('public API reflection evidence', () => {
    const capture = (entries: unknown[]) => new Blob([JSON.stringify({ log: { entries } })]);

    const row = (text = 'ok', mimeType = 'text/plain', request = {}) => ({
      request: { method: 'POST', url: 'https://example.test/items', headers: [], ...request },
      response: { status: 200, headers: [], content: { mimeType, text } },
    });

    it('keeps reflection grouping equivalent for plain and base64 request bytes', async () => {
      for (const totalBodyBytes of [0, 10000]) {
        for (const encoded of [false, true]) {
          const entries = ['payload-111', 'payload-222', 'payload-333'].map((value) =>
            row(`Rejected value ${value}.`, 'text/plain', {
              postData: {
                mimeType: 'application/x-www-form-urlencoded',
                text: encoded ? Buffer.from(`name=${value}`).toString('base64') : `name=${value}`,
                ...(encoded ? { encoding: 'base64' } : {}),
              },
            }),
          );
          const analysis = await analyzeCore(capture(entries), { limits: { totalBodyBytes } });
          expect(analysis.outcomes.map((group) => group.members)).toEqual([[0, 1, 2]]);
          expect(analysis.outcomes[0].match).toBe('inferred-reflection');
        }
      }
    });
  });

  describe('reflection safeguards', () => {
    const capture = (rows: unknown[]) => new Blob([JSON.stringify({ log: { entries: rows } })]);

    const values = ['payload-111', 'payload-222', 'payload-333'];

    const row = (value: string, mime: string, text: string) => ({
      request: {
        method: 'GET',
        url: 'https://example.test/echo?q=' + encodeURIComponent(value),
        headers: [] as { name: string; value: string }[],
      },
      response: { status: 400, headers: [], content: { mimeType: mime, text } },
      time: 0,
    });

    const groups = async (rows: unknown[]) =>
      (await analyze(capture(rows))).outcomes.map((g) => g.members);

    const dates = ['Sun, 01 Jun 2025', 'Mon, 02 Jun 2025', 'Tue, 03 Jun 2025'];

    const percentLetters = (value: string) =>
      [...value].map((char) => '%' + char.charCodeAt(0).toString(16)).join('');

    it.each(['unsupported encoding', 'invalid UTF-8', 'excessive body', 'unsupported charset'])(
      'keeps response differences significant with %s request bytes',
      async (kind) => {
        const rows = values.map((value) => ({
          ...row(value, 'application/xml', `<r>Rejected ${value}</r>`),
          request: {
            method: 'POST',
            url: 'https://example.test/echo?q=' + value,
            headers: [],
            postData: {
              mimeType:
                kind === 'unsupported charset' ? 'text/plain; charset=iso-8859-1' : 'text/plain',
              text:
                kind === 'invalid UTF-8'
                  ? '/w=='
                  : kind === 'excessive body'
                    ? 'x'.repeat(65 * 1024)
                    : 'unknown',
              ...(kind === 'invalid UTF-8'
                ? { encoding: 'base64' }
                : kind === 'unsupported encoding'
                  ? { encoding: 'unknown' }
                  : {}),
            },
          },
        }));
        expect(await groups(rows)).toEqual([[0], [1], [2]]);
      },
    );

    it.each([
      ['JSON', 'application/json', (s: string) => JSON.stringify({ echo: s })],
      ['plain', 'text/plain', (s: string) => s],
      [
        'HTML',
        'text/html',
        (s: string) => `<p>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`,
      ],
      [
        'XML',
        'application/xml',
        (s: string) => `<r>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</r>`,
      ],
      ['form', 'application/x-www-form-urlencoded', (s: string) => `echo=${encodeURIComponent(s)}`],
      [
        'multipart',
        'multipart/form-data; boundary=x',
        (s: string) =>
          `--x\r\nContent-Disposition: form-data; name="echo"\r\n\r\n${s}\r\n--x--\r\n`,
      ],
    ] as const)(
      'groups captured input reflections inside %s raw-body wrappers',
      async (format, mime, render) => {
        for (const structured of [false, true]) {
          for (const encoded of [false, true]) {
            for (const independent of [false, true]) {
              const rows = values.map((value) => {
                const body = structured
                  ? JSON.stringify({ message: 'xxxx' + value })
                  : 'xxxx' + value;
                return {
                  ...row(
                    value,
                    mime,
                    render((independent ? 'Independent server verdict: ' : '') + body),
                  ),
                  request: {
                    method: 'POST',
                    url: 'https://example.test/echo?q=' + value,
                    headers: [],
                    postData: {
                      mimeType: structured ? 'application/json' : 'text/plain',
                      text: encoded ? btoa(body) : body,
                      ...(encoded ? { encoding: 'base64' } : {}),
                    },
                  },
                };
              });
              for (const totalBodyBytes of [0, 32 * 1024 * 1024]) {
                const a = await analyze(capture(rows), { limits: { totalBodyBytes } });
                expect(
                  a.outcomes.map((g) => g.members),
                  `${structured}/${encoded}/${independent}`,
                ).toEqual([[0, 1, 2]]);
              }
            }
          }
        }
      },
    );

    it.each([
      ['JSON', 'application/json', (s: string) => JSON.stringify({ echo: s })],
      ['plain text', 'text/plain', (s: string) => s],
      ['HTML', 'text/html', (s: string) => `<p>${s.replace(/&/g, '&amp;')}</p>`],
      ['XML', 'application/xml', (s: string) => `<r>${s.replace(/&/g, '&amp;')}</r>`],
      ['form', 'application/x-www-form-urlencoded', (s: string) => `echo=${encodeURIComponent(s)}`],
      [
        'multipart',
        'multipart/form-data; boundary=x',
        (s: string) =>
          `--x\r\nContent-Disposition: form-data; name="echo"\r\n\r\n${s}\r\n--x--\r\n`,
      ],
    ] as const)(
      'groups reflected values within captured URLs while retaining their literal scaffolding',
      async (_name, mime, render) => {
        for (const relative of [false, true]) {
          for (const encode of [
            (s: string) => s,
            encodeURIComponent,
            (s: string) => encodeURIComponent(encodeURIComponent(s)),
          ]) {
            for (const independent of [false, true]) {
              const rows = values.map((value) => {
                const url = `https://example.test/echo?q=${value}&x=0`;
                const text = (independent ? 'Independent server verdict: ' : '') + encode(url);
                const e = row(value, mime, render(text));
                e.request.url = relative ? url.slice('https://example.test'.length) : url;
                if (relative)
                  e.request.headers = [
                    { name: ':scheme', value: 'https' },
                    { name: ':authority', value: 'example.test' },
                  ];
                return e;
              });
              for (const totalBodyBytes of [0, 32 * 1024 * 1024]) {
                const a = await analyze(capture(rows), { limits: { totalBodyBytes } });
                expect(
                  a.outcomes.map((g) => g.members),
                  `${relative}/${independent}/${encode.name}`,
                ).toEqual([[0, 1, 2]]);
              }
            }
          }
        }
      },
    );

    it.each([
      ['JSON', 'application/json', (v: string) => JSON.stringify({ echo: v, state: 'rejected' })],
      ['plain text', 'text/plain', (v: string) => v + ' rejected'],
      ['HTML', 'text/html', (v: string) => `<p>${v}</p><p>rejected</p>`],
      ['XML', 'application/xml', (v: string) => `<r state="rejected">${v}</r>`],
      ['form', 'application/x-www-form-urlencoded', (v: string) => `echo=${v}&state=rejected`],
      [
        'multipart',
        'multipart/form-data; boundary=x',
        (v: string) =>
          `--x\r\nContent-Disposition: form-data; name="echo"\r\n\r\n${v}\r\n--x\r\nContent-Disposition: form-data; name="state"\r\n\r\nrejected\r\n--x--\r\n`,
      ],
    ])(
      'retains constant copied query text alongside varying %s reflections',
      async (_name, mime, body) => {
        const rows = values.map((v) => {
          const e = row(v, mime, body(v));
          e.request.url += '&state=rejected';
          return e;
        });
        expect(await groups(rows)).toEqual([[0, 1, 2]]);
      },
    );

    it.each(['header', 'cookie', 'path'])(
      'retains constant copied %s text alongside varying JSON reflections',
      async (source) => {
        const rows = values.map((v) => {
          const e = row(v, 'application/json', JSON.stringify({ echo: v, state: 'rejected' }));
          if (source === 'header') e.request.headers = [{ name: 'X-State', value: 'rejected' }];
          if (source === 'cookie')
            e.request.headers = [{ name: 'Cookie', value: 'state=rejected' }];
          if (source === 'path') e.request.url = e.request.url.replace('/echo?', '/rejected/echo?');
          return e;
        });
        expect(await groups(rows)).toEqual([[0, 1, 2]]);
      },
    );

    it.each(['short value', 'field name'])(
      'retains encoded constant query %s text alongside varying reflections',
      async (source) => {
        const rows = values.map((v) => {
          const e = row(
            v,
            'application/json',
            JSON.stringify({
              echo: v,
              state: source === 'short value' ? '&quot;deny&quot;' : 'a&amp;b',
            }),
          );
          e.request.url +=
            source === 'short value'
              ? '&state=' + encodeURIComponent('"deny"')
              : '&' + encodeURIComponent('a&b') + '=0';
          return e;
        });
        expect(await groups(rows)).toEqual([[0, 1, 2]]);
      },
    );

    it.each(['method', 'version', 'hostname', 'field name'])(
      'retains copied request %s text as a literal slot alongside reflections',
      async (source) => {
        const copied =
          source === 'method'
            ? 'GET'
            : source === 'version'
              ? 'HTTP/2.0'
              : source === 'hostname'
                ? 'example.test'
                : 'q';
        const rows = values.map((v) => {
          const e = row(v, 'application/json', JSON.stringify({ echo: v, metadata: copied }));
          if (source === 'version') (e.request as Record<string, unknown>).httpVersion = copied;
          return e;
        });
        expect(await groups(rows)).toEqual([[0, 1, 2]]);
      },
    );

    it.each([
      [
        'JSON',
        'application/json',
        (v: string, prefix: string) => JSON.stringify({ echo: v, state: `[${prefix}rejected]` }),
      ],
      ['plain text', 'text/plain', (v: string, prefix: string) => `${v} [${prefix}rejected]`],
      ['HTML', 'text/html', (v: string, prefix: string) => `<p>${v}</p><p>[${prefix}rejected]</p>`],
      [
        'XML',
        'application/xml',
        (v: string, prefix: string) => `<r state="[${prefix}rejected]">${v}</r>`,
      ],
      [
        'form',
        'application/x-www-form-urlencoded',
        (v: string, prefix: string) =>
          `echo=${v}&state=${encodeURIComponent(`[${prefix}rejected]`)}`,
      ],
      [
        'multipart',
        'multipart/form-data; boundary=x',
        (v: string, prefix: string) =>
          `--x\r\nContent-Disposition: form-data; name="echo"\r\n\r\n${v}\r\n--x\r\nContent-Disposition: form-data; name="state"\r\n\r\n[${prefix}rejected]\r\n--x--\r\n`,
      ],
    ])(
      'groups supported %s reflections independently of constant wrapper text',
      async (_name, mime, body) => {
        for (const prefix of ['', 'Request ']) {
          const rows = values.map((v) => {
            const e = row(v, mime, body(v, prefix));
            e.request.url += '&state=rejected';
            return e;
          });
          expect(await groups(rows)).toEqual(prefix ? [[0, 1, 2]] : [[0, 1, 2]]);
        }
      },
    );

    it('retains wrapped input-name text literally alongside confirmed JSON reflections', async () => {
      const rows = values.map((v) =>
        row(v, 'application/json', JSON.stringify({ echo: v, name: '[q]' })),
      );
      expect(await groups(rows)).toEqual([[0, 1, 2]]);
    });

    it.each(['application/json', 'text/plain', 'text/html'])(
      'retains constant Unicode text alongside supported %s reflections',
      async (mime) => {
        for (const copied of ['🧪q🧪', 'X🧪XX']) {
          const rows = values.map((v) => {
            const e = row(
              v,
              mime,
              mime === 'application/json'
                ? JSON.stringify({ echo: v, copied })
                : mime === 'text/html'
                  ? `<p>${v}</p><p>${copied}</p>`
                  : `${v} ${copied}`,
            );
            if (copied === 'X🧪XX') e.request.url += '&state=' + encodeURIComponent('🧪');
            return e;
          });
          expect(await groups(rows)).toEqual([[0, 1, 2]]);
        }
      },
    );

    it('makes longest-match provenance independent of request field order', async () => {
      for (const order of [
        ['shortA', 'shortB', 'long'],
        ['long', 'shortA', 'shortB'],
      ]) {
        const rows = values.map((v) => {
          const e = row(
            v,
            'application/json',
            JSON.stringify({ echo: v + '-suffix', error: 'invalid' }),
          );
          e.request.url =
            'https://example.test/echo?' +
            order
              .map((name) => name + '=' + encodeURIComponent(name === 'long' ? v + '-suffix' : v))
              .join('&');
          return e;
        });
        expect(await groups(rows)).toEqual([[0, 1, 2]]);
      }
    });

    it('composes timestamp variation with confirmed reflection', async () => {
      expect(
        await groups(
          values.map((v, i) => row(v, 'text/html', `<p>${v}</p><p>${dates[i]} 12:34:56 GMT</p>`)),
        ),
      ).toEqual([[0, 1, 2]]);
    });

    it('counts encoded path representations as one source per path position', async () => {
      const rows = values.map((v) => {
        const parts = Array.from({ length: 17 }, (_, i) => `part-${i}-${v}?`);
        const e = row(v, 'application/json', JSON.stringify({ error: 'invalid', echoes: parts }));
        e.request.url = 'https://example.test/' + parts.map(encodeURIComponent).join('/');
        return e;
      });
      const result = await analyze(capture(rows), { contexts: [[0, 1, 2]] });
      expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
      expect(result.summary.reflection?.candidateLimited).toBe(0);
    });

    it('does not bridge raw and escaped reflection cohorts through an identical encoded-looking echo', async () => {
      const payloads = [1, 2, 3, 4].map((i) => `payload-${i}&`);
      const rows = [false, true].flatMap((escape) =>
        payloads.map((v) =>
          row(
            v,
            'application/json',
            JSON.stringify({ echo: escape ? v.replace(/&/g, '&amp;') : v, error: 'invalid' }),
          ),
        ),
      );
      rows.push(row('payload-1&amp;', 'application/json', rows[4].response.content.text));
      rows.forEach((e, i) => (e.time = i));
      const expected = ['0,1,2,3', '4,8', '5,6,7'];
      for (const ordered of [rows, [...rows].reverse(), [rows[8], ...rows.slice(0, 8)]]) {
        const result = await analyze(capture(ordered));
        const memberships = result.outcomes
          .map((g) =>
            g.members
              .map((id) => result.entries[id].time)
              .sort((a, b) => a! - b!)
              .join(','),
          )
          .sort();
        expect(memberships).toEqual(expected);
        expect(result.summary.warnings).toContain(
          'Inference skipped for 1 response group with conflicting reflection explanations.',
        );
      }
    });

    it('preserves incompatible encoding clusters across chained aliases and deterministic permutations', async () => {
      const payloads = [1, 2, 3, 4].map((i) => `payload-${i}&`);
      const rows = [0, 1, 2].flatMap((layers) =>
        payloads.map((v) => {
          let echo = v;
          for (let i = 0; i < layers; i++) echo = echo.replace(/&/g, '&amp;');
          return row(v, 'application/json', JSON.stringify({ echo, error: 'invalid' }));
        }),
      );
      rows.push(row('payload-1&amp;', 'application/json', rows[4].response.content.text));
      rows.push(row('payload-2&amp;', 'application/json', rows[9].response.content.text));
      rows.forEach((e, i) => (e.time = i));
      const expected = ['0,1,2,3', '4,12', '5,6,7', '8,10,11', '9,13'].sort();
      for (let seed = 1; seed <= 20; seed++) {
        let state = seed;
        const ordered = [...rows];
        for (let i = ordered.length - 1; i > 0; i--) {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          const j = state % (i + 1);
          [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
        }
        const formatted = ordered.map((e, i) => ({
          ...e,
          response: {
            ...e.response,
            content: {
              ...e.response.content,
              text:
                i % 2
                  ? JSON.stringify({
                      error: 'invalid',
                      echo: JSON.parse(e.response.content.text).echo,
                    })
                  : e.response.content.text,
            },
          },
        }));
        const result = await analyze(capture(formatted));
        expect(
          result.outcomes
            .map((g) =>
              g.members
                .map((id) => result.entries[id].time)
                .sort((a, b) => a! - b!)
                .join(','),
            )
            .sort(),
        ).toEqual(expected);
      }
    });

    it.each([
      [
        'JSON',
        'application/json',
        (v: string, decision: string) => JSON.stringify({ echo: v, error: 'rejected', decision }),
      ],
      [
        'plain',
        'text/plain',
        (v: string, decision: string) => `Rejected ${v}. Decision ${decision}.`,
      ],
      [
        'HTML',
        'text/html',
        (v: string, decision: string) =>
          `<p>Rejected ${v}</p><b data-decision="${decision}">${decision}</b>`,
      ],
      [
        'XML',
        'application/xml',
        (v: string, decision: string) => `<r decision="${decision}">Rejected ${v}</r>`,
      ],
      [
        'form',
        'application/x-www-form-urlencoded',
        (v: string, decision: string) => `error=Rejected&echo=${v}&decision=${decision}`,
      ],
      [
        'multipart',
        'multipart/form-data; boundary=x',
        (v: string, decision: string) =>
          `--x\r\nContent-Disposition: form-data; name="result"\r\n\r\nRejected ${v}. Decision ${decision}.\r\n--x--\r\n`,
      ],
    ])(
      'preserves application decisions when %s responses also reflect input',
      async (_name, mime, body) => {
        const rows = ['allow', 'deny'].flatMap((decision) =>
          values.map((v) => row(v, mime, body(v, decision))),
        );
        rows.forEach((e, i) => (e.time = i));
        for (const ordered of [rows, [...rows].reverse()]) {
          const result = await analyze(capture(ordered));
          expect(
            result.outcomes
              .map((g) =>
                g.members
                  .map((id) => result.entries[id].time)
                  .sort((a, b) => a! - b!)
                  .join(','),
              )
              .sort(),
          ).toEqual(['0,1,2', '3,4,5']);
        }
      },
    );

    it('does not interpret marker-looking JSON application arrays as fingerprint instructions', async () => {
      const rows = ['allow', 'deny'].flatMap((decision) =>
        values.map((v) =>
          row(
            v,
            'application/json',
            JSON.stringify({ echo: v, metadata: ['request-value', decision, 'literal'] }),
          ),
        ),
      );
      expect(await groups(rows)).toEqual([
        [0, 1, 2],
        [3, 4, 5],
      ]);
    });

    it('handles many empty XML values and short captured header witnesses within its work allowance', async () => {
      const rows = values.map((v) => {
        const e = row(
          v,
          'application/xml',
          '<r ' +
            Array.from({ length: 185 }, (_, i) => `a${i}=""`).join(' ') +
            `>Rejected input <echo>${v}</echo></r>`,
        );
        e.request.headers = Array.from({ length: 190 }, (_, i) => ({
          name: `X-${i}`,
          value: `${i.toString().padStart(3, '0')}&<>`,
        }));
        e.request.headers.push({ name: 'X-Empty', value: ' ' });
        return e;
      });
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
      expect(result.summary.reflection).toMatchObject({ entryLimited: 0, captureLimited: 0 });
    });

    it.each(['XML', 'form', 'plain', 'HTML', 'multipart'])(
      'groups captured reflections within long copied %s wrappers',
      async (format) => {
        const rows = (independent: boolean) =>
          values.map((value) => {
            const message = 'x'.repeat(520) + value + 'y'.repeat(520);
            const requestMime =
              format === 'XML' ? 'application/xml' : 'application/x-www-form-urlencoded';
            const requestText =
              format === 'XML'
                ? `<r><input>${value}</input><message>${message}</message></r>`
                : `input=${value}&message=${message}`;
            const suffix = independent ? 'rejected' : '';
            const mime =
              format === 'XML'
                ? requestMime
                : format === 'form'
                  ? requestMime
                  : format === 'HTML'
                    ? 'text/html'
                    : format === 'multipart'
                      ? 'multipart/form-data; boundary=x'
                      : 'text/plain';
            const text =
              format === 'XML'
                ? `<r>\n<input>${value}</input>\n<message>${message}</message>\n${suffix}</r>`
                : format === 'form'
                  ? `message=${message}&input=${value}${suffix ? '&state=' + suffix : ''}`
                  : format === 'HTML'
                    ? `<p>${message}</p><p>${suffix}</p>`
                    : format === 'multipart'
                      ? `--x\r\nContent-Disposition: form-data; name="message"\r\n\r\n${message}\r\n--x\r\nContent-Disposition: form-data; name="state"\r\n\r\n${suffix}\r\n--x--\r\n`
                      : message + suffix;
            return {
              ...row(value, mime, text),
              request: {
                method: 'POST',
                url: 'https://example.test/echo',
                headers: [],
                postData: { mimeType: requestMime, text: requestText },
              },
            };
          });
        expect(await groups(rows(false))).toEqual([[0, 1, 2]]);
        expect(await groups(rows(true))).toEqual([[0, 1, 2]]);
      },
    );

    it.each([
      ['text/plain', (value: string) => 'Operation ' + value],
      ['text/html', (value: string) => `<p>Operation ${value}</p>`],
      [
        'application/json',
        (value: string) => JSON.stringify({ result: value, message: 'Operation' }),
      ],
      ['application/xml', (value: string) => `<r>Operation ${value}</r>`],
      ['application/x-www-form-urlencoded', (value: string) => `result=${value}&message=Operation`],
      [
        'multipart/form-data; boundary=x',
        (value: string) =>
          `--x\r\nContent-Disposition: form-data; name="result"\r\n\r\nOperation ${value}\r\n--x--\r\n`,
      ],
    ])('groups captured decoded word reflections in %s', async (mime, body) => {
      for (const encoded of [false, true]) {
        const rows = ['accepted', 'rejected', 'disabled'].map((value) =>
          row(encoded ? percentLetters(value) : value, mime, body(value)),
        );
        expect(await groups(rows)).toEqual([[0, 1, 2]]);
      }
      const distinct = values.map((value) => row(percentLetters(value), mime, body(value)));
      expect(await groups(distinct)).toEqual([[0, 1, 2]]);
    });

    it('retains constant decoded request text alongside varying JSON reflections', async () => {
      const rows = values.map((value) => {
        const entry = row(
          value,
          'application/json',
          JSON.stringify({ echo: value, state: 'accepted' }),
        );
        entry.request.url += '&state=' + encodeURIComponent(percentLetters('accepted'));
        return entry;
      });
      expect(await groups(rows)).toEqual([[0, 1, 2]]);
    });

    it.each(
      ['filename', 'part type'].flatMap((metadata) =>
        ['JSON', 'plain', 'HTML', 'XML', 'form', 'multipart'].map((format) => ({
          metadata,
          format,
        })),
      ),
    )(
      'retains constant multipart $metadata alongside $format reflections',
      async ({ metadata, format }) => {
        const rows = (independent: boolean) =>
          values.map((value) => {
            const copied = metadata === 'filename' ? 'sample.txt' : 'text/plain';
            const suffix = independent ? ' rejected' : '';
            const mime =
              format === 'JSON'
                ? 'application/json'
                : format === 'HTML'
                  ? 'text/html'
                  : format === 'XML'
                    ? 'application/xml'
                    : format === 'form'
                      ? 'application/x-www-form-urlencoded'
                      : format === 'multipart'
                        ? 'multipart/form-data; boundary=y'
                        : 'text/plain';
            const text =
              format === 'JSON'
                ? JSON.stringify({ input: value, metadata: copied + suffix })
                : format === 'HTML'
                  ? `<p>${value}</p><p>${copied}${suffix}</p>`
                  : format === 'XML'
                    ? `<r><input>${value}</input><metadata>${copied}${suffix}</metadata></r>`
                    : format === 'form'
                      ? `input=${value}&metadata=${encodeURIComponent(copied + suffix)}`
                      : format === 'multipart'
                        ? `--y\r\nContent-Disposition: form-data; name="result"\r\n\r\n${value} ${copied}${suffix}\r\n--y--\r\n`
                        : `${value} ${copied}${suffix}`;
            return {
              ...row(value, mime, text),
              request: {
                method: 'POST',
                url: 'https://example.test/echo',
                headers: [],
                postData: {
                  mimeType: 'multipart/form-data; boundary=x',
                  text: `--x\r\nContent-Disposition: form-data; name="input"\r\n\r\n${value}\r\n--x\r\nContent-Disposition: form-data; name="file"; filename="sample.txt"\r\nContent-Type: text/plain\r\n\r\nfixed\r\n--x--\r\n`,
                },
              },
            };
          });
        expect(await groups(rows(false))).toEqual([[0, 1, 2]]);
        expect(await groups(rows(true))).toEqual([[0, 1, 2]]);
      },
    );

    it.each(['filename', 'part type'])(
      'keeps multipart %s ineligible as a placeholder',
      async (metadata) => {
        const rows = values.map((value) => {
          const filename = metadata === 'filename' ? value + '.txt' : 'fixed.txt';
          const type = metadata === 'part type' ? 'application/x-' + value : 'text/plain';
          return {
            ...row(
              value,
              'application/json',
              JSON.stringify({
                echo: metadata === 'filename' ? filename : type,
                message: 'Rejected',
              }),
            ),
            request: {
              method: 'POST',
              url: 'https://example.test/echo',
              headers: [],
              postData: {
                mimeType: 'multipart/form-data; boundary=x',
                text: `--x\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\nfixed\r\n--x--\r\n`,
              },
            },
          };
        });
        const analysis = await analyze(capture(rows));
        expect(analysis.outcomes.every((group) => group.match !== 'inferred-reflection')).toBe(
          true,
        );
        expect(analysis.entries.map((e) => e.body.text)).toEqual(
          rows.map((e) => e.response.content.text),
        );
      },
    );

    it.each(['XML', 'HTML', 'form', 'JSON', 'multipart', 'plain'])(
      'groups captured reflection spans across supported %s syntax',
      async (format) => {
        const rows = (independent: boolean) =>
          values.map((value) => {
            const mime =
              format === 'XML'
                ? 'application/xml'
                : format === 'HTML'
                  ? 'text/html'
                  : format === 'form'
                    ? 'application/x-www-form-urlencoded'
                    : format === 'JSON'
                      ? 'application/json'
                      : format === 'multipart'
                        ? 'multipart/form-data; boundary=y'
                        : 'text/plain';
            const copy =
              format === 'XML' || format === 'HTML'
                ? `xxxx<b>${value}</b>`
                : format === 'form'
                  ? `state=xxxx&input=${value}`
                  : format === 'JSON'
                    ? JSON.stringify({ state: 'xxxx', count: 771, input: value })
                    : format === 'multipart'
                      ? `xxxx\r\n--y\r\nContent-Disposition: form-data; name="input"\r\n\r\n${value}`
                      : 'xxxx' + value;
            const text =
              format === 'XML' || format === 'HTML'
                ? `<r>${copy}${independent ? '<p>rejected</p>' : ''}</r>`
                : format === 'JSON'
                  ? independent
                    ? `{"copy":${copy},"status":"rejected"}`
                    : copy
                  : format === 'form'
                    ? copy + (independent ? '&status=rejected' : '')
                    : format === 'multipart'
                      ? `--y\r\nContent-Disposition: form-data; name="state"\r\n\r\n${copy}${independent ? '\r\n--y\r\nContent-Disposition: form-data; name="status"\r\n\r\nrejected' : ''}\r\n--y--\r\n`
                      : copy + (independent ? ' rejected' : '');
            const entry = row(value, mime, text);
            entry.request.url += '&message=' + encodeURIComponent(copy);
            return entry;
          });
        expect(await groups(rows(false))).toEqual([[0, 1, 2]]);
        expect(await groups(rows(true))).toEqual([[0, 1, 2]]);
      },
    );

    it.each(
      ['JSON object', 'JSON array object', 'form', 'multipart'].flatMap((format) =>
        ['771', '#state', '@state', 'a/b~c', '', 'state'].map((name) => ({ format, name })),
      ),
    )(
      'retains literal $format field name $name alongside reflected values',
      async ({ format, name }) => {
        const rows = values.map((value) => {
          const postData =
            format === 'form'
              ? {
                  mimeType: 'application/x-www-form-urlencoded',
                  text: encodeURIComponent(name) + '=' + value,
                }
              : format === 'multipart'
                ? {
                    mimeType: 'multipart/form-data; boundary=x',
                    text: `--x\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n--x--\r\n`,
                  }
                : {
                    mimeType: 'application/json',
                    text: JSON.stringify(
                      format === 'JSON object' ? { [name]: value } : [{ [name]: value }],
                    ),
                  };
          return {
            ...row(value, 'application/json', JSON.stringify({ echo: value, name })),
            request: {
              method: 'POST',
              url: 'https://example.test/echo',
              headers: [],
              postData,
            },
          };
        });
        expect(await groups(rows)).toEqual([[0, 1, 2]]);
      },
    );

    it.each(['JSON array', 'XML occurrence', 'XML text marker'])(
      'does not invent request names from a %s',
      async (format) => {
        const rows = values.map((value) => ({
          ...row(
            value,
            'application/json',
            JSON.stringify({ echo: value, server: format === 'XML text marker' ? '#text' : '0' }),
          ),
          request: {
            method: 'POST',
            url: 'https://example.test/echo',
            headers: [],
            postData:
              format === 'JSON array'
                ? { mimeType: 'application/json', text: JSON.stringify([value]) }
                : { mimeType: 'application/xml', text: `<r>${value}</r>` },
          },
        }));
        expect(await groups(rows)).toEqual([[0, 1, 2]]);
      },
    );

    it('retains literal XML attribute-name text alongside reflected values', async () => {
      const rows = values.map((value) => ({
        ...row(value, 'application/json', JSON.stringify({ echo: value, name: 'state' })),
        request: {
          method: 'POST',
          url: 'https://example.test/echo',
          headers: [],
          postData: { mimeType: 'application/xml', text: `<r state="${value}"/>` },
        },
      }));
      expect(await groups(rows)).toEqual([[0, 1, 2]]);
    });

    it.each(['JSON', 'form', 'multipart'])(
      'keeps literal @ prefixes on %s field names when judging independent text',
      async (format) => {
        const rows = values.map((value) => ({
          ...row(value, 'application/json', JSON.stringify({ echo: value, server: 'state' })),
          request: {
            method: 'POST',
            url: 'https://example.test/echo',
            headers: [],
            postData:
              format === 'JSON'
                ? { mimeType: 'application/json', text: JSON.stringify({ '@state': value }) }
                : format === 'form'
                  ? { mimeType: 'application/x-www-form-urlencoded', text: '%40state=' + value }
                  : {
                      mimeType: 'multipart/form-data; boundary=x',
                      text: `--x\r\nContent-Disposition: form-data; name="@state"\r\n\r\n${value}\r\n--x--\r\n`,
                    },
          },
        }));
        expect(await groups(rows)).toEqual([[0, 1, 2]]);
      },
    );

    it.each(
      ['self closing', 'explicit empty', 'nested empty', 'empty tree'].flatMap((shape) =>
        ['JSON', 'plain', 'HTML', 'XML', 'form', 'multipart'].map((format) => ({ shape, format })),
      ),
    )(
      'retains constant $shape XML names alongside $format reflections',
      async ({ shape, format }) => {
        for (const encoded of [false, true]) {
          const rows = (independent: boolean) =>
            values.map((value) => {
              const name = shape === 'nested empty' ? 'inner' : 'status';
              const empty =
                shape === 'self closing'
                  ? '<status/>'
                  : shape === 'explicit empty'
                    ? '<status></status>'
                    : '<status><inner/></status>';
              const request =
                shape === 'empty tree' ? '<status/>' : `<r>${empty}<input>${value}</input></r>`;
              const suffix = independent ? ' Rejected' : '';
              const mime =
                format === 'JSON'
                  ? 'application/json'
                  : format === 'HTML'
                    ? 'text/html'
                    : format === 'XML'
                      ? 'application/xml'
                      : format === 'form'
                        ? 'application/x-www-form-urlencoded'
                        : format === 'multipart'
                          ? 'multipart/form-data; boundary=y'
                          : 'text/plain';
              const text =
                format === 'JSON'
                  ? JSON.stringify({ echo: value, name: name + suffix })
                  : format === 'HTML' || format === 'XML'
                    ? `<r>${value}<p>${name}${suffix}</p></r>`
                    : format === 'form'
                      ? `echo=${value}&name=${encodeURIComponent(name + suffix)}`
                      : format === 'multipart'
                        ? `--y\r\nContent-Disposition: form-data; name="result"\r\n\r\n${value} ${name}${suffix}\r\n--y--\r\n`
                        : `${value} ${name}${suffix}`;
              return {
                ...row(value, mime, text),
                request: {
                  method: 'POST',
                  url: 'https://example.test/echo' + (shape === 'empty tree' ? '?q=' + value : ''),
                  headers: [],
                  postData: {
                    mimeType: 'application/xml',
                    text: encoded ? btoa(request) : request,
                    ...(encoded ? { encoding: 'base64' } : {}),
                  },
                },
              };
            });
          const memberships = async (independent: boolean) =>
            (
              await analyze(capture(rows(independent)), {
                limits: { totalBodyBytes: encoded ? 0 : 32 * 1024 * 1024 },
              })
            ).outcomes.map((group) => group.members);
          expect(await memberships(false)).toEqual([[0, 1, 2]]);
          expect(await memberships(true)).toEqual([[0, 1, 2]]);
        }
      },
    );

    it.each(['malformed', 'excessive'])(
      'uses complete query evidence without partial XML names from %s requests',
      async (kind) => {
        const rows = values.map((value) => ({
          ...row(value, 'text/plain', `${value} status`),
          request: {
            method: 'POST',
            url: 'https://example.test/echo?q=' + value,
            headers: [],
            postData: {
              mimeType: 'application/xml',
              text:
                kind === 'malformed'
                  ? '<r><status/><bad></r>'
                  : '<r><status/>' + '<empty/>'.repeat(2100) + '</r>',
            },
          },
        }));
        const result = await analyze(capture(rows));
        expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
        expect(result.requestIndex!.rows.get(0)!.categories.has('XML')).toBe(false);
      },
    );
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

    it.each([false, true])(
      'corroborates distinctive reflected path inputs in an associated context: explicit=%s',
      async (explicit) => {
        const values = [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333',
        ];
        const rows = values.map((value, i) => {
          const row = exchange(`Unknown item ${value}.`, 'text/plain');
          return {
            ...row,
            request: {
              ...row.request,
              url: `https://${explicit ? `host${i}` : 'example'}.test/items/${explicit ? value.replaceAll('-', '%2D') : value}`,
            },
          };
        });
        const result = await analyze(
          capture(rows),
          undefined,
          undefined,
          explicit ? { contexts: [[0, 1, 2]] } : undefined,
        );
        expect(result.outcomes.map((group) => group.members)).toEqual([[0, 1, 2]]);
        expect(result.outcomes[0].match).toBe('inferred-reflection');
        const numbers = values.map((_value, i) => {
          const value = String(12345678 + i),
            row = exchange(`Balance ${value}.`, 'text/plain');
          return {
            ...row,
            request: { ...row.request, url: `https://example.test/items/${value}` },
          };
        });
        expect((await analyze(capture(numbers))).outcomes.map((group) => group.members)).toEqual([
          [0, 1, 2],
        ]);
      },
    );

    it.each([
      ['<p>', '</p>', false],
      ['<p title="a long attribute">', '</p>', false],
      ['<p>abc ', '</p>', false],
      ['<p>', '&nbsp;</p>', false],
      ['<p>', '&#160;</p>', false],
      ['<p>', '&#x20;</p>', false],
      ['<p>', '&nbsp</p>', false],
      ['<b>E</b><i>cho</i><p>', '</p>', true],
    ])('checks the HTML reflection scaffold in %s…%s', async (before, after, inferred) => {
      const rows = Array.from({ length: 3 }, (_, id) => {
        const payload = `payload-${id}abc`;
        const row = exchange(`${before}${payload}${after}`, 'text/html');
        row.request.url += `?q=${payload}`;
        return row;
      });
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((group) => group.members)).toEqual([[0, 1, 2]]);
      if (inferred) expect(result.outcomes[0].match).toBe('inferred-reflection');
    });

    it('keeps adversarial shared-prefix reflections separate when matching work is exhausted', async () => {
      const rows = Array.from({ length: 3 }, (_, rowId) => {
        const values = Array.from(
          { length: 199 },
          (_, id) => 'a'.repeat(27) + rowId + id.toString(36).padStart(3, '0'),
        );
        const row = exchange(
          'a'.repeat(1000) + ' Rejected values: ' + values.join(' '),
          'text/plain',
        );
        return {
          ...row,
          request: {
            ...row.request,
            queryString: values.map((value, id) => ({ name: `input${id}`, value })),
          },
        };
      });
      const result = await analyze(capture([...rows, rows[0]]));
      expect(result.outcomes.map((group) => group.members)).toEqual([[0, 3], [1], [2]]);
      expect(result.entries.every((entry) => entry.body.hash && entry.body.state === 'text')).toBe(
        true,
      );
      expect(result.summary.warnings).toEqual(
        expect.arrayContaining([expect.stringMatching(/reflection.*work/i)]),
      );
      expect(result.summary.reflection?.entryLimited).toBe(4);
      expect(result.summary.reflection?.captureLimited).toBe(0);
    });

    it('keeps bounded reflection work independent of earlier successful entries', async () => {
      const rows = ['probe-111', 'probe-222'].map((value) => {
        const row = exchange(`Rejected value ${value}.`, 'text/plain');
        row.request.url += `?q=${value}`;
        return row;
      });
      const result = await analyze(capture(rows));
      let totalWork = 32 * 1024 * 1024 - 4096;
      const templates = [];
      for (let i = 0; i < 64; i++) {
        let entryWork = 0;
        const entry = result.entries[i % 2];
        templates.push(
          reflectSlot(
            entry.body.text!,
            slotInputs(entry, result.requestIndex!.rows.get(i % 2))!,
            (n) => {
              entryWork += n;
              totalWork += n;
              return entryWork <= 1024 * 1024;
            },
          ),
        );
      }
      expect(
        templates.every((value) => value?.parts.some((part) => typeof part !== 'string')),
      ).toBe(true);
      expect(totalWork).toBeGreaterThan(32 * 1024 * 1024);
    });

    it('preserves malformed response header names and framing instead of folding them into noise', async () => {
      for (const headers of [
        [[{ name: 'X-İ', value: 'same' }], [{ name: 'x-i\u0307', value: 'same' }]],
        [[{ name: 'Date', value: 'bad-one' }], [{ name: 'Date', value: 'bad-two' }]],
        [[{ name: 'Content-Length', value: 'invalid' }], [{ name: 'Content-Length', value: '2' }]],
        [
          [{ name: 'X-Request-ID', value: 'one\r\ninjected' }],
          [{ name: 'X-Request-ID', value: 'two\r\ninjected' }],
        ],
      ]) {
        const rows = headers.map((fields) => {
          const row = exchange();
          row.response.headers = fields;
          return row;
        });
        expect.soft((await analyze(capture(rows))).outcomes.length).toBe(2);
      }
    });

    it('keeps malformed and unsupported traceparents significant while ignoring valid version 00 fields', async () => {
      const trace = '4bf92f3577b34da6a3ce929d0e0e4736';
      const parent = '00f067aa0ba902b7';
      const rejected = [
        'not-a-traceparent',
        'another-invalid-traceparent',
        `00-${'0'.repeat(32)}-${parent}-01`,
        `00-${trace}-${'0'.repeat(16)}-01`,
        `00-${trace.toUpperCase()}-${parent}-01`,
        `ff-${trace}-${parent}-01`,
        `00-${trace}-${parent}-01-extra`,
        `01-${trace}-${parent}-01`,
      ];
      const values = [...rejected, `00-${trace}-${parent}-01`, `00-${trace}-b9c7c989f97918e1-00`];
      const rows = values.map((value) => {
        const row = exchange();
        row.response.headers = [{ name: 'traceparent', value }];
        return row;
      });
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((group) => group.members)).toEqual([
        ...rejected.map((_, id) => [id]),
        [8, 9],
      ]);
      expect(result.entries.map((entry) => entry.responseHeaders[0].value)).toEqual(values);
    });

    it('preserves malformed tracestate lists while ignoring valid vendor members', async () => {
      const rejected = [
        'not-a-member',
        'also-invalid',
        'Vendor=one',
        'vendor=one,vendor=two',
        'vendor=bad=value',
        'vendor=' + 'x'.repeat(257),
        '1vendor=one',
        Array.from({ length: 33 }, (_, id) => `v${id}=x`).join(','),
      ];
      const values = [
        ...rejected,
        'rojo=00f067aa0ba902b7,congo=t61rcWkgMzE',
        ' 1tenant@vendor=opaque value, rojo=updated',
      ];
      const rows = values.map((value) => {
        const row = exchange();
        row.response.headers = [{ name: 'tracestate', value }];
        return row;
      });
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((group) => group.members)).toEqual([
        ...rejected.map((_, id) => [id]),
        [8, 9],
      ]);
      expect(result.entries.map((entry) => entry.responseHeaders[0].value)).toEqual(values);
    });

    it('preserves single-digit Date fields while allowing fixed-width HTTP dates to vary', async () => {
      const dates = [
        'Thu, 1 Jan 2026 00:00:00 GMT',
        'Fri, 2 Jan 2026 00:00:00 GMT',
        'Thu, 01 Jan 2026 00:00:00 GMT',
        'Fri, 02 Jan 2026 00:00:00 GMT',
      ];
      const rows = dates.map((value) => {
        const row = exchange();
        row.response.headers = [{ name: 'Date', value }];
        return row;
      });
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((group) => group.members)).toEqual([[0], [1], [2, 3]]);
      expect(result.entries.map((entry) => entry.responseHeaders[0].value)).toEqual(dates);
    });

    it('preserves impossible dates and weekday mismatches while ignoring valid leap dates', async () => {
      const dates = [
        'Mon, 31 Feb 2026 00:00:00 GMT',
        'Tue, 31 Feb 2026 00:00:00 GMT',
        'Fri, 01 Jan 2026 00:00:00 GMT',
        'Sat, 29 Feb 2025 00:00:00 GMT',
        'Tue, 29 Feb 2000 00:00:00 GMT',
        'Thu, 29 Feb 2024 00:00:00 GMT',
        'Wed, 01 Mar 2000 00:00:00 GMT',
        'Sat, 29 Feb 2100 00:00:00 GMT',
      ];
      const rows = dates.map((value) => {
        const row = exchange();
        row.response.headers = [{ name: 'Date', value }];
        return row;
      });
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((group) => group.members)).toEqual([
        [0],
        [1],
        [2],
        [3],
        [4, 5, 6],
        [7],
      ]);
      expect(result.entries.map((entry) => entry.responseHeaders[0].value)).toEqual(dates);
    });

    it('requires reflection corroboration within each captured transport-error boundary', async () => {
      const errors = ['reset', 'reset', 'timeout', 'closed', 'closed', 'closed', 7, 7, 7];
      const rows = errors.map((_error, i) => {
        const value = `probe-${i}00`;
        const row = exchange(`Rejected value ${value}.`, 'text/plain');
        return {
          ...row,
          request: { ...row.request, url: `https://example.test/items?q=${value}` },
          response: { ...row.response, _error },
        };
      });
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((group) => group.members)).toEqual([
        [0, 1],
        [2],
        [3, 4, 5],
        [6],
        [7],
        [8],
      ]);
      expect(
        result.outcomes
          .filter((group) => group.match === 'inferred-reflection')
          .map((group) => group.members),
      ).toEqual([
        [0, 1],
        [3, 4, 5],
      ]);
    });

    it('shares base media-type identity between reflection corroboration and partition boundaries', async () => {
      const mimes = [
        'text/plain; charset=utf-8',
        'TEXT/PLAIN;charset=utf-8',
        'text/plain; charset=UTF-8',
      ];
      const rows = mimes.map((mime, i) => {
        const value = `probe-${i}00`,
          row = exchange(`Rejected value ${value}.`, mime);
        return {
          ...row,
          request: { ...row.request, url: `https://example.test/items?q=${value}` },
        };
      });
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((group) => group.members)).toEqual([[0, 1, 2]]);
      expect(result.outcomes[0].match).toBe('inferred-reflection');
      for (const ordered of [rows, [...rows].reverse()]) {
        const grouped = await analyze(capture(ordered));
        const group = groupPage(grouped, 'outcomes', 0, '').rows[0];
        expect(group.representative).toBe(0);
        expect(group.mime).toBe(ordered[0].response.content.mimeType);
        expect(group.label).toBe(`200 · ${group.mime} · likely matching response pattern`);
      }
      const separateType = {
        ...rows[2],
        response: {
          ...rows[2].response,
          content: { ...rows[2].response.content, mimeType: 'text/html' },
        },
      };
      expect(
        (await analyze(capture([rows[0], rows[1], separateType]))).outcomes.map(
          (group) => group.members,
        ),
      ).toEqual([[0, 1], [2]]);
    });

    it('unifies corroborated reflection scaffolds connected by an exact body in any arrival order', async () => {
      const first = ['token-111', 'token-222', 'token-333'].map((value) => {
        const row = exchange(`Rejected value ${value}.`, 'text/plain; charset=utf-8');
        return {
          ...row,
          request: { ...row.request, url: `https://example.test/items?first=${value}` },
        };
      });
      const second = ['token-111', 'token-444', 'token-555'].map((value) => {
        const row = exchange(`Rejected value ${value}.`, 'TEXT/PLAIN; charset=UTF-8');
        return {
          ...row,
          request: { ...row.request, url: `https://example.test/items?second=${value}` },
        };
      });
      for (const rows of [
        [...first, ...second],
        [first[1], second[1], first[0], second[0], first[2], second[2]],
        [first[0], second[1], second[2], first[1], second[0], first[2]],
      ]) {
        const result = await analyze(
          capture([...rows, exchange('Independent result', 'text/plain')]),
        );
        expect(result.outcomes.map((group) => group.members)).toEqual([[0, 1, 2, 3, 4, 5], [6]]);
        expect(result.entries.slice(0, 6).map((entry) => entry.outcome)).toEqual(
          Array(6).fill(result.outcomes[0].id),
        );
        expect(result.entries[6].outcome).toBe(result.outcomes[1].id);
        expect(result.outcomes[0]).toMatchObject({ match: 'inferred-reflection', number: 1 });
        expect(result.outcomes[0].mime).toBe(rows[0].response.content.mimeType);
        expect(result.outcomes[0].label).toBe(
          `200 · ${rows[0].response.content.mimeType} · likely matching response pattern`,
        );
        expect(result.outcomes[1].number).toBe(2);
        expect(result.endpoints[0].variants).toBe(2);
      }
    });
  });

  describe('short reflections in established error templates', () => {
    const strong = ['payload-111', 'payload-222', 'payload-333'];
    const short = ['1', '+0.0', 'admin'];
    const render = (value: string) => `Rejected value '${value}': invalid input.`;
    const rows = (
      values: string[],
      mime = 'application/json',
      body: (v: string) => string = (v) => JSON.stringify({ detail: render(v), status: 400 }),
    ) =>
      values.map((value) => ({
        request: {
          method: 'GET',
          url: 'https://example.test/validation?input=' + encodeURIComponent(value),
          headers: [],
        },
        response: { status: 400, headers: [], content: { mimeType: mime, text: body(value) } },
      }));
    const run = (entries: unknown[], totalBodyBytes = 32 * 1024 * 1024) =>
      analyze(new Blob([JSON.stringify({ log: { entries } })]), { limits: { totalBodyBytes } });
    it.each([
      [
        'JSON',
        'application/json',
        (v: string) => JSON.stringify({ detail: render(v), status: 400 }),
      ],
      ['plain', 'text/plain', render],
      ['HTML', 'text/html', (v: string) => `<p>${render(v)}</p>`],
      ['XML', 'application/xml', (v: string) => `<r>${render(v)}</r>`],
      [
        'form',
        'application/x-www-form-urlencoded',
        (v: string) => 'detail=' + encodeURIComponent(render(v)),
      ],
      [
        'multipart',
        'multipart/form-data; boundary=x',
        (v: string) =>
          `--x\r\nContent-Disposition: form-data; name="detail"\r\n\r\n${render(v)}\r\n--x--\r\n`,
      ],
    ] as const)(
      'extends an established %s error template without depending on order or text retention',
      async (_format, mime, body) => {
        for (const reverse of [false, true])
          for (const evicted of [false, true])
            for (const encoded of [false, true]) {
              const entries = rows([...strong, ...short], mime, body);
              if (reverse) entries.reverse();
              const wire = encoded
                ? entries.map((e) => ({
                    ...e,
                    response: {
                      ...e.response,
                      content: {
                        ...e.response.content,
                        text: btoa(e.response.content.text),
                        encoding: 'base64',
                      },
                    },
                  }))
                : entries;
              const a = await run(wire, evicted ? 0 : 32 * 1024 * 1024);
              expect(a.outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4, 5]]);
              expect(a.outcomes[0].match).toBe('inferred-reflection');
            }
      },
    );
    it('confirms short reflections without requiring a long-value bootstrap', async () => {
      expect((await run(rows(short))).outcomes).toHaveLength(1);
      expect((await run(rows([...strong.slice(0, 2), ...short]))).outcomes).toHaveLength(1);
    });
    it.each(['unicode apostrophe', 'escaped double quote'])(
      'recognizes established JSON slots with %s delimiters',
      async (kind) => {
        const entries = rows([...strong, ...short]);
        for (const entry of entries)
          entry.response.content.text =
            kind === 'unicode apostrophe'
              ? entry.response.content.text.replaceAll("'", '\\u0027')
              : JSON.stringify({
                  detail: JSON.parse(entry.response.content.text).detail.replaceAll("'", '"'),
                  status: 400,
                });
        expect((await run(entries)).outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4, 5]]);
      },
    );
    it.each(['success', 'status', 'unquoted', 'decision', 'provenance'])(
      'preserves the %s boundary around short inputs',
      async (kind) => {
        const longRows = rows(strong),
          shortRows = rows(short);
        if (kind === 'success')
          for (const e of [...longRows, ...shortRows]) e.response.status = 200;
        if (kind === 'status') for (const e of shortRows) e.response.status = 401;
        if (kind === 'unquoted')
          for (const [i, e] of shortRows.entries())
            e.response.content.text = JSON.stringify({
              detail: render(short[i]).replaceAll("'", ''),
              status: 400,
            });
        if (kind === 'decision')
          for (const e of shortRows)
            e.response.content.text = e.response.content.text.replace(
              '"status":400',
              '"status":403',
            );
        if (kind === 'provenance')
          for (const e of shortRows) e.request.url = e.request.url.replace('?input=', '?other=');
        const a = await run([...longRows, ...shortRows]);
        expect(a.outcomes.map((g) => g.members.length).sort()).toEqual(
          ['success', 'provenance'].includes(kind) ? [6] : [3, 3],
        );
      },
    );
  });

  describe('repeated JSON error reflections', () => {
    const strong = ['payload-111', 'payload-222', 'payload-333'];
    const small = ['Data', '1', '!', '"', '<', '\\x22'];
    const row = (value: string) => ({
      request: {
        method: 'GET',
        url: 'https://example.test/items?input=' + encodeURIComponent(value),
        headers: [],
      },
      response: {
        status: 400,
        headers: [],
        content: {
          mimeType: 'application/json',
          text: JSON.stringify({
            title: 'Bad Request',
            detail: value + ' is invalid',
            causes: [{ key: value, source: 'parameter', message: 'Invalid query parameter' }],
          }),
        },
      },
    });
    const run = (entries: unknown[], evicted = false) =>
      analyze(new Blob([JSON.stringify({ log: { entries } })]), {
        limits: { totalBodyBytes: evicted ? 0 : 32 * 1024 * 1024 },
      });
    it('admits repeated exact and unquoted slots only after strong corroboration', async () => {
      for (const reverse of [false, true])
        for (const evicted of [false, true]) {
          const rows = [...strong, ...small].map(row);
          if (reverse) rows.reverse();
          const a = await run(rows, evicted);
          expect(a.outcomes.map((g) => g.members.length)).toEqual([9]);
          expect(a.outcomes[0].match).toBe('inferred-reflection');
          expect(new Set(a.entries.map((e) => e.body.hash)).size).toBe(9);
        }
    });
    it('retains changed response structure and decisions across short reflections', async () => {
      expect((await run(small.map(row))).outcomes).toHaveLength(1);
      for (const variant of ['single slot', 'decision', 'source', 'ambiguous source', 'success']) {
        const rows = [...strong, ...small].map(row);
        for (const r of rows.slice(3)) {
          if (variant === 'single slot') {
            const body = JSON.parse(r.response.content.text);
            delete body.causes;
            r.response.content.text = JSON.stringify(body);
          }
          if (variant === 'decision')
            r.response.content.text = r.response.content.text.replace(
              'Invalid query parameter',
              'Accepted query parameter',
            );
          if (variant === 'source') r.request.url = r.request.url.replace('?input=', '?other=');
          if (variant === 'ambiguous source')
            r.request.url += '&other=' + r.request.url.split('?input=')[1];
          if (variant === 'success') r.response.status = 200;
        }
        expect((await run(rows)).outcomes.map((g) => g.members.length).sort()).toEqual(
          ['source', 'ambiguous source'].includes(variant) ? [9] : [3, 6],
        );
      }
    });
  });

  it('normalizes bounded long inputs copied into multiple JSON fields', async () => {
    const values = [522, 822, 1022].map((n) => 'payload-' + 'A'.repeat(n));
    const entries = values.map((value) => ({
      request: {
        method: 'GET',
        url: 'https://example.test/items?input=' + encodeURIComponent(value),
        headers: [],
      },
      response: {
        status: 400,
        headers: [],
        content: {
          mimeType: 'application/json',
          text: JSON.stringify({
            detail: value + ' is invalid',
            causes: [{ key: value, message: 'Invalid query parameter' }],
          }),
        },
      },
    }));
    const a = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
    expect(a.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
    expect(a.outcomes[0].match).toBe('inferred-reflection');
  });

  it.each(['absolute', 'origin', 'encoded', 'double-encoded'])(
    'retains constant copied %s paths alongside response reflections',
    async (target) => {
      const path = '/a/b/c/d/e';
      const rawPath =
        target === 'encoded'
          ? '/' + encodeURIComponent(path)
          : target === 'double-encoded'
            ? '/' + encodeURIComponent(encodeURIComponent(path))
            : path;
      for (const kind of ['JSON', 'XML', 'Form', 'Multipart', 'plain', 'HTML']) {
        for (const independent of [false, true]) {
          const entries = values.map((value) => {
            const copied = path + (independent ? ' Rejected request.' : '');
            let mime = 'text/plain',
              text = value + '\n' + copied;
            if (kind === 'JSON') {
              mime = 'application/json';
              text = JSON.stringify({ echo: value, path: copied });
            }
            if (kind === 'XML') {
              mime = 'application/xml';
              text = `<r><echo>${value}</echo><path>${copied}</path></r>`;
            }
            if (kind === 'Form') {
              mime = 'application/x-www-form-urlencoded';
              text = new URLSearchParams({ echo: value, path: copied }).toString();
            }
            if (kind === 'Multipart') {
              mime = 'multipart/form-data; boundary=b';
              text = `--b\r\nContent-Disposition: form-data; name="echo"\r\n\r\n${value}\r\n--b\r\nContent-Disposition: form-data; name="path"\r\n\r\n${copied}\r\n--b--\r\n`;
            }
            if (kind === 'HTML') {
              mime = 'text/html';
              text = `<p>${value}</p><p>${copied}</p>`;
            }
            return {
              request: {
                method: 'GET',
                url: (target === 'origin' ? '' : 'https://example.test') + rawPath + '?q=' + value,
                headers: target === 'origin' ? [{ name: 'Host', value: 'example.test' }] : [],
              },
              response: { status: 400, headers: [], content: { mimeType: mime, text } },
            };
          });
          expect(
            (await analyze(capture(entries))).outcomes.map((g) => g.members),
            `${kind}/${independent}`,
          ).toEqual([[0, 1, 2]]);
        }
      }
    },
  );

  it.each(['literal', 'url', 'entities'])(
    'groups reflected values within compact %s formatted-request copies',
    async (encoding) => {
      for (const independent of [false, true]) {
        const entries = values.map((value) => {
          const data = { alpha: value, beta: 'copied-b' };
          const compact = JSON.stringify(data);
          const copied =
            encoding === 'url'
              ? encodeURIComponent(compact)
              : encoding === 'entities'
                ? compact.replaceAll('"', '&quot;')
                : compact;
          return {
            request: {
              method: 'POST',
              url: 'https://example.test/items',
              headers: [{ name: 'Content-Type', value: 'application/json' }],
              postData: { mimeType: 'application/json', text: JSON.stringify(data, null, 2) },
            },
            response: {
              status: 400,
              headers: [],
              content: {
                mimeType: 'application/json',
                text: JSON.stringify({
                  echo: (independent ? 'Rejected input: ' : '') + copied + '.',
                }),
              },
            },
          };
        });
        expect((await analyze(capture(entries))).outcomes.map((g) => g.members)).toEqual([
          [0, 1, 2],
        ]);
      }
    },
  );

  it.each([
    'name',
    'value',
    'encoded value',
    'boundary',
    'disposition token',
    'body media type',
    'part media type',
    'part media parameter',
  ])('retains copied multipart %s metadata alongside response reflections', async (source) => {
    const boundary = 'captured-boundary-token';
    const copied =
      source === 'name'
        ? 'X-Part-Status'
        : source === 'boundary'
          ? boundary
          : source === 'disposition token'
            ? 'form-data'
            : source === 'body media type'
              ? 'multipart/form-data'
              : source === 'part media type'
                ? 'text/plain'
                : source === 'part media parameter'
                  ? 'utf-8'
                  : 'rejected';
    const header = source === 'encoded value' ? '%72ejected' : 'rejected';
    for (const kind of ['JSON', 'XML', 'Form', 'Multipart', 'plain', 'HTML']) {
      for (const independent of [false, true]) {
        const entries = values.map((value) => {
          const message = (independent ? 'Rejected request: ' : '') + copied;
          let mime = 'text/plain',
            text = value + '\n' + message;
          if (kind === 'JSON') {
            mime = 'application/json';
            text = JSON.stringify({ echo: value, message });
          }
          if (kind === 'XML') {
            mime = 'application/xml';
            text = `<r><echo>${value}</echo><message>${message}</message></r>`;
          }
          if (kind === 'Form') {
            mime = 'application/x-www-form-urlencoded';
            text = new URLSearchParams({ echo: value, message }).toString();
          }
          if (kind === 'Multipart') {
            mime = 'multipart/form-data; boundary=r';
            text = `--r\r\nContent-Disposition: form-data; name="echo"\r\n\r\n${value}\r\n--r\r\nContent-Disposition: form-data; name="message"\r\n\r\n${message}\r\n--r--\r\n`;
          }
          if (kind === 'HTML') {
            mime = 'text/html';
            text = `<p>${value}</p><p>${message}</p>`;
          }
          return {
            request: {
              method: 'POST',
              url: 'https://example.test/items',
              headers: [
                { name: 'Content-Type', value: 'multipart/form-data; boundary=' + boundary },
              ],
              postData: {
                mimeType: 'multipart/form-data; boundary=' + boundary,
                text: `--${boundary}\r\nContent-Disposition: form-data; name="q"\r\nContent-Type: text/plain; charset="utf-8"\r\nX-Part-Status: ${header}\r\n\r\n${value}\r\n--${boundary}--\r\n`,
              },
            },
            response: { status: 400, headers: [], content: { mimeType: mime, text } },
          };
        });
        expect(
          (await analyze(capture(entries))).outcomes.map((g) => g.members),
          `${kind}/${independent}`,
        ).toEqual([[0, 1, 2]]);
      }
    }
  });

  it.each(['application/json', 'text/plain'])(
    'retains constant case-changed copies alongside %s reflections',
    async (mime) => {
      const seed = 'abcdef0123456789abcdef0123456789';
      for (const prefix of ['', 'İ 🧪 ', 'Rejected input: ']) {
        const rows = values.map((value) => {
          const message = prefix + seed.toUpperCase() + '.';
          const row = exchange(
            value,
            mime === 'application/json'
              ? JSON.stringify({ echo: value, message })
              : `${value} ${message}`,
            mime,
          );
          row.request.url += '&seed=' + seed;
          return row;
        });
        const result = await analyze(capture(rows));
        expect(result.outcomes.length, prefix).toBe(1);
      }
    },
  );
  it.each(['query', 'headers', 'oversized headers', 'unavailable body'])(
    'requires complete request evidence before learning reflection: %s',
    async (missing) => {
      const rows = values.map((value) => {
        const row = exchange(
          value,
          JSON.stringify({ echo: value, message: 'Rejected input' }),
          'application/json',
        );
        if (missing === 'query') {
          row.request.url = 'https://example.test/echo?hidden=%ZZ';
          row.request.headers = [{ name: 'X-Input', value }];
        } else if (missing === 'headers') {
          Object.assign(row.request, { headers: undefined });
        } else if (missing === 'oversized headers') {
          row.request.headers = [{ name: 'X-Input', value: 'a'.repeat(8193) }];
        } else {
          Object.assign(row.request, { bodySize: 128 });
        }
        return row;
      });
      const result = await analyze(capture(rows));
      expect(result.outcomes).toHaveLength(3);
    },
  );

  it.each(['escaped', 'base64-display'])(
    'does not infer reflection from unsupported exporter body display encoding: %s',
    async (encoding) => {
      const rows = values.map((value) => ({
        ...exchange(
          value,
          JSON.stringify({ echo: value, error: 'Rejected input' }),
          'application/json',
        ),
        request: {
          method: 'POST',
          url: `https://example.test/echo?q=${value}`,
          headers: [],
          postData: {
            mimeType: 'application/json',
            text: '{"other":"captured"}',
            _displayEncoding: encoding,
          },
        },
      }));
      const result = await analyze(capture(rows));
      expect(result.outcomes).toHaveLength(3);
    },
  );

  it('retains constant authority text alongside request reflections', async () => {
    for (const independent of [false, true]) {
      const rows = values.map((value) => {
        const row = exchange(
          value,
          JSON.stringify({
            echo: value,
            port: 8080,
            ...(independent ? { message: 'Rejected input' } : {}),
          }),
          'application/json',
        );
        row.request.url = `http://example.test:8080/echo?q=${value}`;
        return row;
      });
      expect((await analyze(capture(rows))).outcomes.length).toBe(1);
    }
  });
});

describe('capture isolation and deterministic memberships', () => {
  const rows = () =>
    Array.from({ length: 12 }, (_, i) => ({
      time: i,
      request: {
        method: i % 2 ? 'OPTIONS' : 'GET',
        url: `https://example.test/items?${i % 2 ? 'sort' : 'q'}=payload-${i}`,
        headers: [],
      },
      response: {
        status: 400,
        headers: [{ name: 'X-Generated', value: token(i) }],
        content: {
          mimeType: 'application/json',
          text: JSON.stringify({
            state: i < 6 ? 'DENIED' : 'LOCKED',
            echo: `payload-${i}`,
            again: `payload-${i}`,
            id: token(i + 20),
          }),
        },
      },
    }));
  const run = (entries: ReturnType<typeof rows>) =>
    analyze(new Blob([JSON.stringify({ log: { entries } })]));
  it('keeps membership stable under permutations and duplicated complete observations', async () => {
    const entries = rows();
    const shuffled = [10, 2, 7, 1, 11, 0, 6, 4, 8, 3, 9, 5].map((i) => entries[i]);
    for (const input of [entries, shuffled, [...shuffled, ...entries, ...shuffled]]) {
      const result = await run(input);
      const membership = result.outcomes
        .map((g) => [...new Set(g.members.map((id) => input[id].time))].sort((a, b) => a - b))
        .sort((a, b) => a[0] - b[0]);
      expect(membership).toEqual([
        [0, 1, 2, 3, 4, 5],
        [6, 7, 8, 9, 10, 11],
      ]);
      expect(result.entries.map((e) => e.body.text)).toEqual(
        input.map((e) => e.response.content.text),
      );
    }
  });
  it('does not lend population evidence to a concurrent or subsequent singleton', async () => {
    const entries = rows();
    const [population, singleton] = await Promise.all([run(entries), run([entries[0]])]);
    expect(population.outcomes).toHaveLength(2);
    expect(singleton.outcomes[0].match).toBe('canonical');
    expect(singleton.outcomes[0].normalizations).toBeUndefined();
    const subsequent = await run([entries[1]]);
    expect(subsequent.outcomes[0].match).toBe('canonical');
    expect(subsequent.outcomes[0].normalizations).toBeUndefined();
  });
  it('rejects exhausted metadata atomically and recovers with fresh analysis state', async () => {
    const file = new Blob([JSON.stringify({ log: { entries: rows() } })]);
    await expect(analyze(file, { limits: { metadataBytes: 1 } })).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
    expect((await analyze(file)).outcomes).toHaveLength(2);
  });
});

it('normalizes valid response clocks independently of malformed captured request syntax', async () => {
  const entries = [0, 1, 2].map((i) =>
    entry(
      i,
      { error: 'Bad Request', timestamp: `2026-10-03T07:31:2${i}Z` },
      {
        method: 'POST',
        query: '',
        postData: { mimeType: 'application/json', text: `%22name${i}%22` },
      },
    ),
  );
  const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
  expect(result.outcomes).toHaveLength(1);
  expect(result.entries.map((e) => e.body.text)).toEqual(
    entries.map((e) => e.response.content.text),
  );
});

it('groups identical many-field bodies without spending input preparation per field', async () => {
  const entries = [0, 1, 2, 3].map((i) => {
    const e = entry(
      i,
      Object.fromEntries(
        Array.from({ length: 180 }, (_, n) => [`f${n}`, i < 2 ? 'same' : `state${i}`]),
      ),
      {
        query: '',
        headers: [{ name: 'X-Any-Id', value: token(i) }],
      },
    );
    e.request.headers.push({
      name: 'Authorization',
      value: 'Bearer ' + token(99).repeat(45),
    } as never);
    return e;
  });
  const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
  expect(result.entries[0].outcome).toBe(result.entries[1].outcome);
  expect(result.outcomes).toHaveLength(3);
  expect(result.summary.reflection?.entryLimited ?? 0).toBe(0);
});

describe('input-independent response cohorts', () => {
  const run = (entries: unknown[]) => analyze(new Blob([JSON.stringify({ log: { entries } })]));
  it.each([
    ['text/plain', (v: string) => `Rejected input: ${v}`],
    ['text/plain', (v: string) => `Error (${v})`],
    ['text/plain', (v: string) => `[${v}]`],
    ['text/plain', (v: string) => `key=${v}`],
    ['text/html', (v: string) => `<input value="${v}">`],
    ['application/xml', (v: string) => `<error>${v}</error>`],
    [
      'multipart/form-data; boundary=demo',
      (v: string) =>
        `--demo\r\nContent-Disposition: form-data; name="error"\r\n\r\n${v}\r\n--demo--\r\n`,
    ],
  ] as const)(
    'extends an established %s reflection to an explicit empty value: %s',
    async (mime, render) => {
      const rows = ['alpha one', 'bravo two', ''].map((v, i) =>
        entry(i, render(v), { mime, query: 'q=' + encodeURIComponent(v) }),
      );
      expect((await run(rows)).outcomes).toHaveLength(1);
      rows[2].request.url = 'https://example.test/items';
      expect((await run(rows)).outcomes).toHaveLength(2);
    },
  );
  it('does not change static single-member JSON keys when a request happens to match one', async () => {
    const rows = ['message', 'other', 'third'].map((v, i) =>
      entry(i, { error: { message: 'Forbidden' }, trace: token(i) }, { query: 'q=' + v }),
    );
    expect((await run(rows)).outcomes).toHaveLength(1);
  });
  it('keeps static multiword text in the cohort when one request happens to match it', async () => {
    const rows = ['Invalid parameter', 'other', 'third'].map((v, i) =>
      entry(i, `Invalid parameter value ${token(i)}`, {
        mime: 'text/plain',
        query: 'q=' + encodeURIComponent(v),
      }),
    );
    expect((await run(rows)).outcomes).toHaveLength(1);
  });
  it.each(['large-input', 'many-fields', 'invalid-path', 'encoding-collision'])(
    'normalizes response noise despite request-side %s',
    async (mode) => {
      const rows = [0, 1, 2].map((i) => {
        const row = entry(
          i,
          { error: 'Rejected', trace: token(i) },
          {
            headers: [{ name: 'X-Generated', value: token(i + 20) }],
            query:
              mode === 'large-input'
                ? 'q=' + 'x'.repeat(5000)
                : mode === 'many-fields'
                  ? Array.from({ length: 210 }, (_, n) => `f${n}=v${n}`).join('&')
                  : mode === 'encoding-collision'
                    ? 'q=a%20b&other=a%2520b'
                    : '',
          },
        );
        if (mode === 'invalid-path') row.request.url = 'https://example.test/items/%ZZ';
        return row;
      });
      expect((await run(rows)).outcomes).toHaveLength(1);
    },
  );
  it('does not infer two numeric business IDs as epochs', async () => {
    const rows = [1000000001, 1000000002].map((id, i) => entry(i, { id }, { query: '' }));
    expect((await run(rows)).outcomes).toHaveLength(2);
  });
  it('keeps constant expiry out of normalization explanations', async () => {
    const rows = [0, 1].map((i) =>
      entry(
        i,
        { error: 'Rejected', trace: token(i) },
        {
          query: '',
          headers: [
            { name: 'Date', value: new Date(Date.UTC(2026, 10, 9, 16, 0, i)).toUTCString() },
            { name: 'Set-Cookie', value: 'sid=fixed; Expires=Mon, 09 Nov 2026 17:00:00 GMT' },
          ],
        },
      ),
    );
    const result = await run(rows);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].normalizations).toEqual(['response-telemetry']);
  });
  it('does not let reflected observations inflate unmatched numeric-token variance', async () => {
    const values = ['fuzz1001', 'fuzz1002', 'fuzz1003', 'fuzz1004', 'rate1234', 'rate5678'];
    const rows = values.map((v, i) => entry(i, { detail: v }, { query: i < 4 ? 'q=' + v : '' }));
    const result = await run(rows);
    expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3], [4], [5]]);
  });
  it('does not strand a server token because one request coincidentally contains it', async () => {
    const rows = [0, 1, 2].map((i) =>
      entry(i, { trace: token(i) }, { query: i === 0 ? 'q=' + token(i) : '' }),
    );
    expect((await run(rows)).outcomes).toHaveLength(1);
  });
});
it('uses independent format-noise evidence when multiple requests happen to copy server identifiers', async () => {
  const entries = [0, 1, 2, 3].map((i) =>
    entry(
      i,
      { error: 'Rejected' },
      { query: i < 2 ? 'q=' + token(i) : '', headers: [{ name: 'X-Generated', value: token(i) }] },
    ),
  );
  const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
  expect(result.outcomes).toHaveLength(1);
  expect(result.outcomes[0].normalizations).toEqual(['response-headers']);
});

describe('typed JSON and local reflection recovery', () => {
  const run = (entries: unknown[]) => analyze(new Blob([JSON.stringify({ log: { entries } })]));
  it.each(['text/plain', ''])(
    'normalizes typed detected JSON under %s despite layout changes',
    async (mime) => {
      const rows = [0, 1, 2].map((i) =>
        entry(i, i % 2 ? `{ "id":"${token(i)}", "a":1 }` : `{"a":1,"id":"${token(i)}"}`, {
          mime,
          query: '',
        }),
      );
      const result = await run(rows);
      expect(result.outcomes).toHaveLength(1);
      expect(result.entries.map((e) => e.body.text)).toEqual(
        rows.map((r) => r.response.content.text),
      );
    },
  );
  it.each(['text/plain', ''])(
    'matches parsed detected JSON string echoes under %s',
    async (mime) => {
      const rows = ['hello world', 'foo', 'a"b'].map((value, i) =>
        entry(i, JSON.stringify({ detail: `Rejected '${value}'` }), {
          mime,
          query: 'q=' + encodeURIComponent(value),
        }),
      );
      expect((await run(rows)).outcomes).toHaveLength(1);
    },
  );
  it.each(['text/plain', 'text/html', 'application/json'])(
    'keeps valid %s echoes alongside incidental clock matches',
    async (mime) => {
      const rows = ['alpha one', 'bravo', 'charlie "quoted"'].map((value, i) => {
        const message = `Rejected query '${value}' at Tue, 1 Sep 2026 14:08:20 GMT`;
        const body =
          mime === 'application/json'
            ? JSON.stringify({ detail: message })
            : mime === 'text/html'
              ? `<p>${message}</p>`
              : message;
        return entry(i, body, { mime, query: 'page=1&q=' + encodeURIComponent(value) });
      });
      expect((await run(rows)).outcomes).toHaveLength(1);
    },
  );
  it('recovers an established reflection when another parameter matches a static word', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      entry(
        i,
        { error: `Invalid value: p${i}` },
        { query: `field=${i === 0 ? 'value' : 'name'}&q=p${i}` },
      ),
    );
    const result = await run(rows);
    expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4]]);
  });
  it('does not erase changed error messages while recovering a valid reflection subset', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      entry(
        i,
        { error: `${i === 0 ? 'Accepted' : 'Invalid'} value: p${i}` },
        { query: `field=${i === 0 ? 'value' : 'name'}&q=p${i}` },
      ),
    );
    expect((await run(rows)).outcomes.map((g) => g.members)).toEqual([[0], [1, 2, 3, 4]]);
  });
  it('normalizes ordinary large HTML forms without phantom tag-gap slots', async () => {
    const rows = ['alpha', 'bravo'].map((value, i) =>
      entry(
        i,
        `<html><head></head><body><form>${'<input value="fixed">'.repeat(210)}<input value="${value}"><p>Rejected request</p></form></body></html>`,
        { mime: 'text/html', query: 'q=' + value },
      ),
    );
    expect((await run(rows)).outcomes).toHaveLength(1);
  });
});
it('retains a discarded known copy when recovering a confirmed reflection subset', async () => {
  const entries = [0, 1, 2].map((i) =>
    entry(
      i,
      { detail: `Rejected ${token(i)}; observed ${i === 0 ? token(i) : token(100 + i)}` },
      { query: 'q=' + token(i) },
    ),
  );
  const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
  expect(result.outcomes.map((g) => g.members)).toEqual([[0], [1, 2]]);
});
it('keeps detected JSON types and explicit JSON syntax boundaries', async () => {
  for (const mime of ['text/plain', '']) {
    const entries = [1, '1', true, 'true'].map((value, i) =>
      entry(i, { value }, { mime, query: '' }),
    );
    expect((await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes).toHaveLength(
      4,
    );
  }
  const entries = ['alpha', 'bravo', ''].map((value, i) =>
    entry(i, `[${value}]`, { mime: 'application/json', query: 'q=' + value }),
  );
  expect((await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes).toHaveLength(
    3,
  );
});
it('keeps the generic-text empty extension local and independent of observation order', async () => {
  const entries = ['alpha one', 'bravo two', ''].map((value, i) =>
    entry(i, `[${value}]`, { mime: 'text/plain', query: 'q=' + encodeURIComponent(value) }),
  );
  for (const ordered of [entries, [...entries].reverse(), [...entries, ...entries]]) {
    expect(
      (await analyze(new Blob([JSON.stringify({ log: { entries: ordered } })]))).outcomes,
    ).toHaveLength(1);
  }
  const singleton = await analyze(new Blob([JSON.stringify({ log: { entries: [entries[2]] } })]));
  expect(singleton.outcomes[0].match).toBe('canonical');
});
it('keeps variance evidence stable when identical responses have different request-copy exclusions', async () => {
  const base = [0, 1, 2, 3].map((i) =>
    entry(i, { detail: `Rejected p${i}; seen ${10 + i}` }, { query: 'q=p' + i }),
  );
  const copied = structuredClone(base[2]);
  copied.request.url += '&limit=12';
  const inputs = [
    [base[0], base[1], copied, base[2], base[3]],
    [base[0], base[1], base[2], copied, base[3]],
  ];
  const memberships = [];
  for (const entries of inputs) {
    const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
    memberships.push(
      result.outcomes
        .map((g) => g.members.map((id) => entries[id].response.content.text))
        .map((g) => [...new Set(g)].sort())
        .sort((a, b) => a[0].localeCompare(b[0])),
    );
  }
  expect(memberships[0]).toHaveLength(4);
  expect(memberships[0]).toEqual(memberships[1]);
});
it('preserves literal suffixes after runtime UUIDs', async () => {
  const entries = [0, 1].map((i) =>
    entry(
      i,
      {
        detail: `Trace ${token(i).slice(0, 8)}-e89b-42d3-a456-426614174000/${i ? 'denied' : 'allowed'}`,
      },
      { query: '' },
    ),
  );
  expect((await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes).toHaveLength(
    2,
  );
});
it('normalizes equivalent supported leading-dot measurement syntax', async () => {
  const entries = ['.5ms', '0.6ms'].map((v, i) =>
    entry(i, { detail: 'Elapsed ' + v }, { query: '' }),
  );
  expect((await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes).toHaveLength(
    1,
  );
});
it.each([
  ['text/html', (value: string) => `<p>Rejected ${value}</p>`],
  ['application/xml', (value: string) => `<error>Rejected ${value}</error>`],
  ['application/x-www-form-urlencoded', (value: string) => `error=Rejected+${value}`],
] as const)(
  'uses the declared %s base type when a parameter ends in +json',
  async (mime, render) => {
    const entries = ['alpha', 'bravo'].map((value, i) =>
      entry(i, render(value), { mime: mime + '; arbitrary=example+json', query: 'q=' + value }),
    );
    expect((await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes).toHaveLength(
      1,
    );
  },
);

it.each(['query', 'path', 'form'])(
  'groups replacement-decoded invalid UTF-8 reflections from captured %s inputs',
  async (kind) => {
    const entries = ['%C0%AEa', '%E0%80%80b', '%F0%80%80%AEc'].map((encoded, i) => {
      const decoded = new URLSearchParams('q=' + encoded).get('q')!;
      const e = entry(
        i,
        { detail: `Rejected ${decoded}` },
        { query: kind === 'query' ? 'q=' + encoded : '' },
      );
      if (kind === 'path') e.request.url = 'https://example.test/items/' + encoded;
      if (kind === 'form')
        Object.assign(e.request, {
          method: 'POST',
          postData: { mimeType: 'application/x-www-form-urlencoded', text: 'q=' + encoded },
        });
      return e;
    });
    const result = await analyze(
      new Blob([JSON.stringify({ log: { entries } })]),
      kind === 'path' ? { contexts: [[0, 1, 2]] } : undefined,
    );
    expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
  },
);

it.each(['query', 'form', 'path'])(
  'groups raw malformed-byte percent reflections from %s without losing original spelling',
  async (kind) => {
    const entries = ['%FFa', '%C0%AFb', '%E0%80%80c'].map((encoded, i) => {
      const e = entry(
        i,
        { detail: 'Rejected ' + encoded },
        { query: kind === 'query' ? 'q=' + encoded : '' },
      );
      if (kind === 'path') e.request.url = 'https://example.test/items/' + encoded;
      if (kind === 'form')
        Object.assign(e.request, {
          method: 'POST',
          postData: { mimeType: 'application/x-www-form-urlencoded', text: 'q=' + encoded },
        });
      return e;
    });
    const result = await analyze(
      new Blob([JSON.stringify({ log: { entries } })]),
      kind === 'path' ? { contexts: [[0, 1, 2]] } : undefined,
    );
    expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
    expect(result.entries.map((e) => e.url)).toEqual(entries.map((e) => e.request.url));
  },
);

describe('uncorroborated copy exclusions', () => {
  it.each(['number', 'text', 'timestamp'])(
    'does not let a lone copied %s value establish server-noise support',
    async (kind) => {
      const values =
        kind === 'timestamp'
          ? ['2026-11-09T10:00:01Z', '2026-11-09T10:00:02Z']
          : ['21', '34', '55', '89'];
      for (const source of ['query', 'header', 'body']) {
        const rows = values.map((value, i) => {
          const row = entry(
            i,
            kind === 'number'
              ? { count: Number(value) }
              : kind === 'timestamp'
                ? { stamp: value }
                : 'Observed ' + value,
            {
              query: i === 0 && source === 'query' ? 'q=' + encodeURIComponent(value) : '',
              mime: kind === 'text' ? 'text/plain' : 'application/json',
            },
          );
          if (i === 0 && source === 'header') row.request.headers = [{ name: 'X-Probe', value }];
          if (i === 0 && source === 'body')
            Object.assign(row.request, {
              method: 'POST',
              postData: { mimeType: 'application/json', text: JSON.stringify({ input: value }) },
            });
          return row;
        });
        for (const entries of [rows, [...rows].reverse()]) {
          const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
          expect(
            result.outcomes.map((g) => g.members.length),
            source,
          ).toEqual(values.map(() => 1));
        }
      }
    },
  );
  it('keeps duplicate response exclusions independent of which request arrives first', async () => {
    const rows = [21, 34, 55, 89].map((count, i) =>
      entry(i, { count }, { query: i === 0 ? 'q=21' : '' }),
    );
    const duplicate = structuredClone(rows[0]);
    duplicate.request.url = 'https://example.test/items';
    for (const entries of [
      [...rows, duplicate],
      [duplicate, ...rows],
    ]) {
      const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
      expect(result.outcomes.map((g) => g.members.length).sort()).toEqual([1, 1, 1, 2]);
    }
  });
  it('normalizes independently supported numeric noise while retaining a lone copied value', async () => {
    const entries = [21, 34, 55, 89, 144].map((count, i) =>
      entry(i, { count }, { query: i === 0 ? 'q=21' : '' }),
    );
    expect(
      (await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes.map(
        (g) => g.members,
      ),
    ).toEqual([[0], [1, 2, 3, 4]]);
  });
  it('retains independently supported format noise around a complete copied token', async () => {
    const entries = [1, 2, 3].map((i) => {
      const stamp = `2026-11-09T10:00:0${i}Z`;
      return entry(i, { stamp }, { query: i === 1 ? 'q=' + encodeURIComponent(stamp) : '' });
    });
    expect(
      (await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes.map(
        (g) => g.members,
      ),
    ).toEqual([[0, 1, 2]]);
  });
});
