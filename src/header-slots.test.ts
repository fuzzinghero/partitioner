import { expect, it, describe } from 'vitest';
import { analyze } from './analyze.js';
import { createHash } from 'node:crypto';
import { analyzeReport } from './core.js';

describe('learned response evidence', () => {
  const ids = [
    'a04bd877dfe3eaca8bbb89677f2f63e3',
    '18626d7941a871908bbb89677f2f62c6',
    'cc972df77c7611758bbb89677f2f699d',
    '40df5a7270139d9cd2c4e4df45a98955',
    '4b7f75ff6d76b33ed2c4e4df45a9843e',
    '34cbfb0fccda9120d2c4e4df45a98554',
    '0f22a567374e26c74e345482e3af0a16',
    'af8455f9e2eee2471ac9848239e55bb4',
  ];

  const capture = (entries: unknown[]) => new Blob([JSON.stringify({ log: { entries } })]);

  const stamp = (i: number) => `2026-10-28T10:00:0${i}.123456789+00:00`;

  const exchange = (i: number, data: unknown, extra: { name: string; value: string }[] = []) => ({
    time: 100 + i,
    request: {
      method: 'GET',
      url: 'https://example.test/items',
      headers: [] as { name: string; value: string }[],
    },
    response: {
      status: 400,
      headers: [{ name: 'Date', value: new Date(stamp(i)).toUTCString() }, ...extra],
      content: { mimeType: 'application/json', text: JSON.stringify(data) },
    },
  });

  const run = (entries: unknown[]) => analyze(capture(entries));

  it.each(['traceparent', 'low-diversity traceparent', 'tracestate', 'content-length'])(
    'keeps protocol-ignored %s identity stable through learned normalization',
    async (kind) => {
      for (const companion of ['none', 'opaque header', 'cookie']) {
        for (const missingBody of [false, true]) {
          if (companion === 'cookie' && missingBody) continue;
          const entries = Array.from({ length: 17 }, (_, i) => {
            const n = i % 8;
            const name = kind === 'low-diversity traceparent' ? 'traceparent' : kind;
            const value = kind.includes('traceparent')
              ? `00-${kind.startsWith('low') ? '1'.repeat(32) : ids[n]}-${ids[(n + 1) % 8].slice(0, 16)}-${i < 8 ? '01' : '03'}`
              : kind === 'tracestate'
                ? 'vendor=' + ids[n]
                : String(Math.floor(new Date(stamp(n)).valueOf() / 1000));
            const extra = [
              ...(i < 16 ? [{ name, value }] : []),
              ...(companion === 'opaque header'
                ? [{ name: 'Anonymous-Identifier', value: ids[n] }]
                : []),
              ...(companion === 'cookie'
                ? [{ name: 'Set-Cookie', value: 'arbitrary=' + ids[n] }]
                : []),
            ];
            const e = exchange(n, { message: 'Rejected' }, extra);
            return missingBody
              ? { ...e, response: { ...e.response, content: { mimeType: 'application/json' } } }
              : e;
          });
          expect((await run(entries)).outcomes.map((g) => g.members)).toEqual([
            Array.from({ length: 17 }, (_, i) => i),
          ]);
        }
      }
    },
  );

  it('keeps malformed and duplicate trace metadata significant', async () => {
    for (const name of ['traceparent', 'tracestate']) {
      const entries = ids.map((id, i) =>
        exchange(i, { message: 'Rejected' }, [
          { name, value: id },
          { name: 'Anonymous-Identifier', value: ids[(i + 1) % 8] },
        ]),
      );
      expect((await run(entries)).outcomes).toHaveLength(8);
      for (const e of entries) e.response.headers.push({ ...e.response.headers[1] });
      expect((await run(entries)).outcomes).toHaveLength(8);
    }
  });

  it('learns arbitrary diagnostic header components and composes with anonymous body clocks', async () => {
    const entries = ids.map((id, i) =>
      exchange(i, { message: 'Rejected input', opaque: stamp(i) }, [
        {
          name: 'Example-Instrumentation',
          value: `a=${Math.floor(new Date(stamp(i)).valueOf() / 1000)}; b=${10 + i}; c=${id};`,
        },
        { name: 'Unfamiliar-Trace', value: ids[(i + 1) % ids.length] },
      ]),
    );
    const a = await run(entries);
    expect(a.outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
    expect(a.entries[0].responseHeaders[1].value).toContain(ids[0]);
  });

  it('learns arbitrary cookie names and isolates an uninterpretable other-origin request', async () => {
    const entries = ids.map((id, i) =>
      exchange(i, { message: 'Rejected' }, [
        { name: 'Set-Cookie', value: `arbitrary=${id}; Path=/; HttpOnly` },
      ]),
    );
    const other = {
      request: {
        method: 'POST',
        url: 'https://other.test/unknown',
        headers: [],
        postData: { mimeType: 'text/plain', text: 'unknown', encoding: 'unsupported' },
      },
      response: {
        status: 400,
        headers: [{ name: 'Set-Cookie', value: `arbitrary=${ids[0]}; Path=/; HttpOnly` }],
        content: { mimeType: 'text/plain', text: 'Rejected' },
      },
    };
    for (const ordered of [
      [...entries, other],
      [other, ...entries],
    ]) {
      const a = await run(ordered);
      expect(a.outcomes.map((g) => g.members.length).sort((a, b) => b - a)).toEqual([8, 1]);
    }
  });

  it('groups equivalent cookie outcomes across request authentication changes', async () => {
    const entries = ['first', 'second'].flatMap((auth) =>
      ids.map((id, i) => {
        const e = exchange(i, { message: 'Rejected' }, [
          { name: 'Set-Cookie', value: `arbitrary=${id}; Path=/; HttpOnly` },
        ]);
        e.request.headers = [{ name: 'Authorization', value: 'Bearer ' + auth }];
        return e;
      }),
    );
    expect((await run(entries)).outcomes.map((g) => g.members.length)).toEqual([16]);
  });

  it('normalizes unreflected diagnostic labels inside a compound header', async () => {
    const entries = ids.map((id, i) =>
      exchange(i, { message: 'Rejected' }, [
        {
          name: 'Arbitrary-Metadata',
          value: `a=${Math.floor(new Date(stamp(i)).valueOf() / 1000)}; b=${i % 2}; c=${id};`,
        },
      ]),
    );
    const a = await run(entries);
    expect(a.outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
  });

  it('groups equivalent successful responses across arbitrary request credentials', async () => {
    const entries = [
      '58d350966dc92f78a31eb0476a1fcc90',
      '89b0a247e13b753c1829cd36a09e7f42',
    ].flatMap((credential) =>
      ids.map((id, i) => {
        const e = exchange(i, { message: 'Rejected' }, [{ name: 'Generated-Value', value: id }]);
        e.response.status = 200;
        e.request.headers = [{ name: 'Unfamiliar-Credential', value: credential }];
        return e;
      }),
    );
    expect((await run(entries)).outcomes.map((g) => g.members.length)).toEqual([16]);
  });

  it('keeps header noise independent of a same-route input admission failure', async () => {
    const make = (i: number) =>
      exchange(
        i,
        { message: 'Rejected' },
        Array.from({ length: 10 }, (_, n) => ({
          name: `Observation-${n}`,
          value: ids[(i + n) % 8],
        })),
      );
    const entries = ids.map((_, i) => make(i));
    const expensive = make(0);
    expensive.request.headers = Array.from({ length: 28 }, (_, i) => ({
      name: `Input-${i}`,
      value: 'Z'.repeat(1995) + '-' + String(i).padStart(3, '0'),
    }));
    for (const h of expensive.response.headers.slice(1)) h.value = h.value.toUpperCase();
    for (const rows of [
      [...entries, expensive],
      [expensive, ...entries],
    ]) {
      const a = await run(rows);
      expect(a.outcomes.map((g) => g.members.length)).toEqual([9]);
    }
  });

  it('normalizes high-variance numeric components without timing correlation', async () => {
    const entries = ids.map((id, i) => {
      const e = exchange(i, { message: 'Rejected' }, [
        {
          name: 'Anonymous-Components',
          value: `a=${Math.floor(new Date(stamp(i)).valueOf() / 1000)}; b=${10 + i}; c=${id};`,
        },
      ]);
      e.time = 100;
      return e;
    });
    expect((await run(entries)).outcomes).toHaveLength(1);
  });

  it('uses supplied request associations for anonymous compound identifier evidence', async () => {
    const entries = ids.map((id, i) => {
      const e = exchange(i, { message: 'Rejected' }, [
        {
          name: 'Unnamed-Identifier-Pair',
          value: `${id}/${18446744073709551000n + BigInt(i) * 101n};f=1`,
        },
      ]);
      e.request.url += '/mutation-' + i;
      return e;
    });
    const a = await analyze(capture(entries), { contexts: [[0, 1, 2, 3, 4, 5, 6, 7]] });
    expect(a.outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
  });

  it('normalizes response headers around identical bodies with complete malformed request bytes', async () => {
    for (const copied of [false, true]) {
      const entries = ids.map((id, i) => {
        const e = exchange(i, { message: 'Rejected' }, [
          { name: 'Anonymous-Identifier', value: id },
        ]);
        return {
          ...e,
          request: {
            ...e.request,
            method: 'POST',
            postData: {
              mimeType: 'application/json',
              text: copied ? encodeURIComponent(JSON.stringify({ x: id }).slice(0, -1)) : '{broken',
            },
          },
        };
      });
      const a = await run(entries);
      expect(a.outcomes).toHaveLength(1);
      expect(a.entries[0].requestBody.text).toBe(entries[0].request.postData.text);
    }
  });

  it('normalizes matching compound response diagnostics across successful request mutations', async () => {
    for (const status of [200, 201]) {
      const entries = ids.map((id, i) => {
        const text = JSON.stringify({ value: 'x'.repeat(i) });
        const e = exchange(i, { message: 'Accepted' }, [
          { name: 'Anonymous-A', value: id },
          { name: 'Anonymous-B', value: ids[(i + 1) % 8] },
        ]);
        e.response.status = status;
        return {
          ...e,
          request: {
            ...e.request,
            method: 'POST',
            headers: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'Content-Length', value: String(text.length) },
            ],
            postData: { mimeType: 'application/json', text },
          },
        };
      });
      expect((await run(entries)).outcomes).toHaveLength(1);
    }
  });

  it('learns a single anonymous identifier across varied requests with identical captured responses', async () => {
    const entries = ids.map((id, i) => {
      const e = exchange(i, { message: 'Accepted' }, [{ name: 'Anonymous-Identifier', value: id }]);
      e.response.status = 200;
      e.request.url += '?mutation=' + i;
      e.request.headers = i % 2 ? [{ name: 'Host', value: 'example.test' }] : [];
      return e;
    });
    expect((await run(entries)).outcomes.map((g) => g.members.length)).toEqual([8]);
    for (let i = 0; i < entries.length; i++) entries[i].request.url += '&copied=' + ids[i];
    expect((await run(entries)).outcomes).toHaveLength(1);
  });

  it('keeps header comparison independent of unsupported escaped application syntax', async () => {
    for (const long of [false, true]) {
      const entries = ids.map((id, i) => {
        const e = exchange(i, { message: 'Rejected' }, [
          { name: 'Anonymous-Identifier', value: id },
        ]);
        const encoded = [...id]
          .map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
          .join('');
        return {
          ...e,
          request: {
            ...e.request,
            method: 'POST',
            postData: {
              mimeType: 'application/json',
              text: '{"q":"' + (long ? '\\"'.repeat(20000) : encoded),
            },
          },
        };
      });
      expect((await run(entries)).outcomes).toHaveLength(1);
    }
  });

  it.each(['header', 'cookie'])(
    'normalizes a coincidentally copied %s value with independently varying server values',
    async (kind) => {
      const copied = '0123456789abcdef0123456789abcdef';
      const make = (value: string, etag: string) => {
        const e = exchange(0, { message: 'Rejected' }, [
          { name: 'ETag', value: '"' + etag + '"' },
          kind === 'header'
            ? { name: 'Anonymous-Identifier', value }
            : { name: 'Set-Cookie', value: 'arbitrary=' + value },
        ]);
        e.request.headers.push({ name: 'Seed', value: copied });
        return e;
      };
      for (const fillers of [0, 16, 80]) {
        for (const reverse of [false, true]) {
          const entries = [
            make(copied, 'target'),
            ...Array.from({ length: fillers }, (_, i) => make(ids[0], 'filler-' + i)),
            ...ids.map((id) => make(id, 'target')),
          ];
          if (reverse) entries.reverse();
          const a = await run(entries);
          const targets = a.entries.filter((e) =>
            e.responseHeaders.some(
              (h) => h.name.toLowerCase() === 'etag' && h.value === '"target"',
            ),
          );
          expect(new Set(targets.map((e) => e.outcome)).size).toBe(1);
        }
      }
    },
  );

  it('admits a later repeated cohort after sparse response profiles fill its scope', async () => {
    const sparse = Array.from({ length: 80 }, (_, i) =>
      exchange(0, { message: 'Rejected' }, [
        { name: 'Content-Security-Policy', value: 'report-uri /policy-' + i },
        { name: 'Anonymous-Identifier', value: ids[0] },
      ]),
    );
    const cohort = ids.map((id, i) =>
      exchange(i, { message: 'Rejected' }, [
        { name: 'Content-Security-Policy', value: "default-src 'none'" },
        { name: 'Anonymous-Identifier', value: id },
      ]),
    );
    const a = await run([...sparse, ...cohort]);
    expect(a.outcomes.find((g) => g.members.includes(80))?.members).toEqual([
      80, 81, 82, 83, 84, 85, 86, 87,
    ]);
    expect(new Set(a.entries.slice(0, 80).map((e) => e.outcome)).size).toBe(80);
  });

  it('retains HTTP authorization values even when they resemble generated response identifiers', async () => {
    for (const name of ['Authorization', 'Proxy-Authorization']) {
      const entries = ids.map((id, i) =>
        exchange(i, { message: 'Accepted' }, [
          { name, value: id },
          { name: 'Anonymous-Identifier', value: ids[(i + 1) % 8] },
        ]),
      );
      expect((await run(entries)).outcomes).toHaveLength(8);
    }
  });

  it('normalizes cookie rotation across differing captured request inputs', async () => {
    for (const mutation of ['query', 'body']) {
      const rows = ids.map((id, i) => {
        const e = exchange(i, { message: 'Accepted' }, [
          { name: 'Set-Cookie', value: 'arbitrary=' + id + '; Path=/; HttpOnly' },
        ]);
        return {
          ...e,
          request: {
            ...e.request,
            url: e.request.url + (mutation === 'query' ? '?choice=' + i : ''),
            ...(mutation === 'body'
              ? {
                  method: 'POST',
                  postData: { mimeType: 'application/json', text: JSON.stringify({ choice: i }) },
                }
              : {}),
          },
        };
      });
      const a = await run([rows[0], rows[0], ...rows]);
      expect(a.outcomes.map((g) => g.members.length).sort((a, b) => b - a)).toEqual([10]);
    }
  });
});

describe('automatic response normalization', () => {
  const nonce = (i: number) =>
    createHash('sha256')
      .update('fixed-fixture-' + i)
      .digest('hex')
      .slice(0, 32);

  const capture = (rows: unknown[]) => new Blob([JSON.stringify({ log: { entries: rows } })]);

  const row = (mime: string, text: string, headers: { name: string; value: string }[] = []) => ({
    request: { method: 'GET', url: 'https://example.test/result', headers: [] },
    response: { status: 400, headers, content: { mimeType: mime, text } },
  });

  const groups = async (rows: unknown[]) =>
    (await analyze(capture(rows))).outcomes.map((g) => g.members);

  it('learns opaque cookie rotation from two valid varying values', async () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      row('application/json', '{"error":"Rejected"}', [
        {
          name: 'Set-Cookie',
          value: `PHPSESSID=${nonce(i + 1)}; Path=/; Secure; HttpOnly`,
        },
      ]),
    );
    expect(await groups(rows)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
    expect(await groups(rows.slice(0, 7))).toEqual([[0, 1, 2, 3, 4, 5, 6]]);
    const report = await analyzeReport(capture(rows));
    expect(report.contexts[0].partitions[0].grouping.normalizations).toContain('cookie-rotation');
    expect(report.contexts[0].partitions[0].sample?.response.headers).toEqual(
      rows[0].response.headers,
    );
  });

  it.each([
    'business-name',
    'business-value',
    'copied',
    'secure',
    'path',
    'deletion',
    'expiry',
    'duplicate-attribute',
    'authorization',
    'policy',
  ])('preserves cookie %s boundaries', async (variant) => {
    const rows = Array.from({ length: 8 }, (_, i) => {
      const value = nonce(i + 1);
      let cookie = `${variant === 'business-name' ? 'tenant_id' : 'PHPSESSID'}=${variant === 'business-value' && i === 7 ? 'admin' : value}; Path=/; HttpOnly`;
      if (variant === 'secure' && i % 2) cookie += '; Secure';
      if (variant === 'path' && i % 2) cookie = cookie.replace('Path=/', 'Path=/admin');
      if (variant === 'deletion') cookie += '; Max-Age=0';
      if (variant === 'expiry') cookie += '; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
      if (variant === 'duplicate-attribute') cookie += '; Path=/';
      const e = row('application/json', '{"error":"Rejected"}', [
        { name: 'Set-Cookie', value: cookie },
        ...(variant === 'policy'
          ? [{ name: 'Access-Control-Allow-Origin', value: i % 2 ? '*' : 'https://other.test' }]
          : []),
      ]);
      if (variant === 'copied') e.request.url += '?q=' + value;
      if (variant === 'authorization')
        e.request.headers = [{ name: 'Authorization', value: 'Bearer ' + i }];
      return e;
    });
    expect(await groups(rows)).toEqual(
      ['business-value', 'duplicate-attribute'].includes(variant)
        ? [[0], [1], [2], [3], [4], [5], [6], [7]]
        : ['secure', 'path', 'policy'].includes(variant)
          ? [
              [0, 2, 4, 6],
              [1, 3, 5, 7],
            ]
          : [[0, 1, 2, 3, 4, 5, 6, 7]],
    );
  });

  it('keeps equivalent cookie responses order independent across request authentication changes', async () => {
    const rows = ['first', 'second'].flatMap((auth) =>
      Array.from({ length: 8 }, (_, i) => {
        const e = row('application/json', '{"error":"Rejected"}', [
          {
            name: 'Set-Cookie',
            value: `PHPSESSID=${nonce(i + 1)}; Path=/; HttpOnly`,
          },
        ]);
        e.request.headers = [{ name: 'Authorization', value: 'Bearer ' + auth }];
        return e;
      }),
    );
    for (const ordered of [rows, [...rows].reverse()])
      expect((await groups(ordered)).map((g) => g.length).sort()).toEqual([16]);
  });

  it('normalizes coincidental cookie copies and retains nonopaque values', async () => {
    for (const copied of [false, true]) {
      const rows = Array.from({ length: 9 }, (_, i) => {
        const value = i === 8 && !copied ? 'administrator' : nonce(i + 1);
        const e = row('application/json', '{"error":"Rejected"}', [
          { name: 'Set-Cookie', value: `PHPSESSID=${value}; Path=/` },
        ]);
        if (copied && i === 8) e.request.url += '?q=' + value;
        return e;
      });
      for (const ordered of [rows, [...rows].reverse()])
        expect((await groups(ordered)).map((g) => g.length).sort((a, b) => b - a)).toEqual(
          copied ? [9] : Array(9).fill(1),
        );
    }
  });

  it('keeps completed cookie cohorts intact across many unrelated routes', async () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      row('text/plain', 'Rejected', [{ name: 'Set-Cookie', value: `PHPSESSID=${nonce(i + 1)}` }]),
    );
    for (let i = 0; i < 512; i++) {
      const e = row('text/plain', 'Rejected', [
        { name: 'Set-Cookie', value: 'PHPSESSID=' + 'a'.repeat(32) },
      ]);
      e.request.url += '/' + i;
      rows.push(e);
    }
    const result = await analyze(capture(rows));
    expect(result.outcomes.find((g) => g.members.includes(0))?.members).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(result.outcomes.flatMap((group) => group.members)).toHaveLength(rows.length);
  });
});

describe('timing-aware header evidence', () => {
  const ids = Array.from({ length: 8 }, (_, i) =>
    createHash('sha256')
      .update('timing-case-' + i)
      .digest('hex')
      .slice(0, 32),
  );
  const entries = (timing = true, correlated = true) =>
    ids.map((id, i) => ({
      time: 50 + i * 7,
      request: {
        method: 'GET',
        url: 'https://example.test/clockless',
        headers: [] as { name: string; value: string }[],
      },
      response: {
        status: 400,
        headers: [
          { name: 'Anonymous-Identifier', value: id },
          ...(timing
            ? [
                {
                  name: 'Server-Timing',
                  value: `render;dur=${i + 1}.25;desc="view, cached", app;dur=${i * 2 + 3}.5`,
                },
                {
                  name: 'Unnamed-Measurement',
                  value: ((correlated ? i * 2 + 5 : [10, 2, 8, 4, 6, 12, 3, 7][i]) / 1000).toFixed(
                    6,
                  ),
                },
              ]
            : []),
        ],
        content: { mimeType: 'text/plain', text: 'The operation was rejected.' },
      },
    }));
  const run = (rows: unknown[]) => analyze(new Blob([JSON.stringify({ log: { entries: rows } })]));

  it('learns opaque identifiers without requiring a response Date', async () => {
    expect((await run(entries(false))).outcomes.map((g) => g.members)).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7],
    ]);
  });
  it('combines standard durations and corroborated anonymous fractional runtimes without Date', async () => {
    const rows = entries();
    const a = await run(rows);
    expect(a.outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
    expect(a.entries[0].responseHeaders).toEqual(rows[0].response.headers);
    expect(a.outcomes[0].normalizations).toContain('response-headers');
  });
  it('normalizes high-variance decimals and corroborated copied measurements', async () => {
    expect((await run(entries(true, false))).outcomes).toHaveLength(1);
    const rows = entries();
    for (const row of rows)
      row.request.headers.push({ name: 'Input-Value', value: row.response.headers[2].value });
    expect((await run(rows)).outcomes).toHaveLength(1);
  });
  it.each(['description', 'metric', 'unknown parameter'])(
    'groups diagnostic Server-Timing %s variation while preserving raw values',
    async (kind) => {
      const rows = [...entries(), ...entries()];
      for (const row of rows.slice(8))
        row.response.headers[1].value =
          kind === 'description'
            ? row.response.headers[1].value.replace('view, cached', 'view, changed')
            : row.response.headers[1].value + (kind === 'metric' ? ', other;dur=1' : ';app=other');
      expect((await run(rows)).outcomes.map((g) => g.members.length).sort()).toEqual([16]);
    },
  );
  it.each(['app;dur=-1', 'app;dur=1;dur=2', 'app;dur=NaN', 'app;dur="2"', 'app;dur=2,'])(
    'groups opaque diagnostic timing syntax %s without rewriting evidence',
    async (value) => {
      const rows = entries();
      for (const [i, row] of rows.entries())
        row.response.headers[1].value = value + (i % 2 ? ';' : '');
      const result = await run(rows);
      expect(result.outcomes.map((g) => g.members.length)).toEqual([8]);
      expect(result.entries.map((e) => e.responseHeaders[1].value)).toEqual(
        rows.map((r) => r.response.headers[1].value),
      );
    },
  );
});

describe('clock-relative expiry evidence', () => {
  const rows = (cookie = false, fixed = false) =>
    Array.from({ length: 8 }, (_, i) => {
      const clock = Date.UTC(2026, 10, 8, 10, 0, i);
      return {
        request: { method: 'GET', url: 'https://example.test/expiry', headers: [] },
        response: {
          status: 200,
          headers: [
            { name: 'Date', value: new Date(clock).toUTCString() },
            {
              name: 'Anonymous-Identifier',
              value: createHash('sha256')
                .update('expiry-' + i)
                .digest('hex')
                .slice(0, 32),
            },
            {
              name: cookie ? 'Set-Cookie' : 'Expires',
              value: cookie
                ? 'arbitrary=stable; Expires=' +
                  new Date((fixed ? Date.UTC(2026, 10, 8, 10) : clock) + 86400000).toUTCString() +
                  '; Path=/; Secure; SameSite=Lax'
                : new Date((fixed ? Date.UTC(2026, 10, 8, 10) : clock) + 3600000).toUTCString(),
            },
          ],
          content: { mimeType: 'text/plain', text: 'Operation completed.' },
        },
      };
    });
  const run = (entries: unknown[]) => analyze(new Blob([JSON.stringify({ log: { entries } })]));
  it.each([false, true])(
    'compares validated moving expiry lifetimes, cookie=%s',
    async (cookie) => {
      const entries = rows(cookie);
      const a = await run(entries);
      expect(a.outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
      expect(a.entries[0].responseHeaders).toEqual(entries[0].response.headers);
      expect(a.outcomes[0].normalizations).toContain('response-headers');
    },
  );
  it.each([false, true])(
    'preserves fixed absolute expiry while learning identifiers, cookie=%s',
    async (cookie) => {
      expect((await run(rows(cookie, true))).outcomes.map((g) => g.members)).toEqual([
        [0, 1, 2, 3, 4, 5, 6, 7],
      ]);
    },
  );
  it('keeps literal expiry learning compatible when some responses omit Date', async () => {
    const entries = rows(false, true);
    for (const entry of entries.slice(4)) entry.response.headers.shift();
    expect((await run(entries)).outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
  });
  it.each([
    'lifetime',
    'value',
    'path',
    'secure',
    'same-site',
    'duplicate attribute',
    'deletion',
    'invalid date',
  ])('retains cookie %s differences', async (kind) => {
    const first = rows(true),
      second = rows(true);
    for (const e of second) {
      let v = e.response.headers[2].value;
      if (kind === 'lifetime')
        v = v.replace(
          /Expires=([^;]+)/,
          (_, date) => 'Expires=' + new Date(Date.parse(date) + 60_000).toUTCString(),
        );
      if (kind === 'value') v = v.replace('arbitrary=stable', 'arbitrary=other');
      if (kind === 'path') v = v.replace('Path=/', 'Path=/other');
      if (kind === 'secure') v = v.replace('; Secure', '');
      if (kind === 'same-site') v = v.replace('SameSite=Lax', 'SameSite=None');
      if (kind === 'duplicate attribute') v += '; Path=/';
      if (kind === 'deletion') v += '; Max-Age=0';
      if (kind === 'invalid date') v = v.replace(/Expires=[^;]+/, 'Expires=not-a-date');
      e.response.headers[2].value = v;
    }
    const a = await run([...first, ...second]);
    expect(a.outcomes.find((g) => g.members.includes(0))?.members).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(
      a.outcomes.every((g) => g.members.every((id) => id < 8) || g.members.every((id) => id >= 8)),
    ).toBe(true);
  });
  it('combines cookie rotation with moving expiry without losing either projection', async () => {
    const entries = rows(true);
    for (const [i, e] of entries.entries())
      e.response.headers[2].value = e.response.headers[2].value.replace(
        '=stable',
        '=a' +
          createHash('sha256')
            .update('cookie-' + i)
            .digest('hex')
            .slice(0, 31),
      );
    expect((await run(entries)).outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
  });
});

describe('bounded profile admission', () => {
  it.each([false, true])(
    'retains interleaved rate-limit policy cohorts beyond sixteen profiles, reversed=%s',
    async (reverse) => {
      const rows = Array.from({ length: 8 }, (_, round) =>
        Array.from({ length: 24 }, (_, policy) => ({
          request: { method: 'GET', url: 'https://example.test/rate-limited', headers: [] },
          response: {
            status: 429,
            headers: [
              { name: 'Retry-After', value: String(policy + 1) },
              {
                name: 'Anonymous-Identifier',
                value: createHash('sha256')
                  .update('admission-' + round + '-' + policy)
                  .digest('hex')
                  .slice(0, 32),
              },
            ],
            content: { mimeType: 'text/plain', text: 'Too many requests.' },
          },
        })),
      ).flat();
      if (reverse) rows.reverse();
      const a = await analyze(new Blob([JSON.stringify({ log: { entries: rows } })]));
      expect(a.outcomes).toHaveLength(24);
      expect(a.outcomes.every((g) => g.members.length === 8)).toBe(true);
      for (const group of a.outcomes) {
        expect(
          new Set(
            group.members.map(
              (id) => a.entries[id].responseHeaders.find((h) => h.name === 'Retry-After')!.value,
            ),
          ).size,
        ).toBe(1);
      }
    },
  );
});

describe('opaque headers on identical method errors', () => {
  const ids = [
    '04ea2ef4-7fa8-4374-9fc8-ecbc75ebfc71',
    '075d0498-9de8-4d85-93ba-6ffa2547d4e4',
    '0be5ca62-e8ea-4481-86a1-1204ced8a01e',
    '27e7d761-742b-49f3-9828-5d1afeb94c05',
    'b0b593e3-4ef1-4108-9215-af7753cad509',
    '5788f394-5219-45a8-a773-608ec914d279',
  ];
  const rows = () =>
    ['OPTIONS', 'TRACE', 'PUT', 'DELETE', 'PATCH', 'POST'].map((method, i) => ({
      request: {
        method,
        url: 'https://example.test/items',
        headers: [] as { name: string; value: string }[],
      },
      response: {
        status: 502,
        headers: [{ name: 'Arbitrary-Identifier', value: ids[i] }],
        content: {
          mimeType: 'application/json',
          text: JSON.stringify({ fault: { message: 'Method rejected by upstream' } }),
        },
      },
    }));
  const run = (entries: unknown[]) => analyze(new Blob([JSON.stringify({ log: { entries } })]));
  it('groups an exact error across diverse methods with distinct UUID header evidence', async () => {
    for (const reversed of [false, true]) {
      const entries = rows();
      if (reversed) entries.reverse();
      const a = await run(entries);
      expect(a.outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4, 5]]);
      expect(a.outcomes[0].normalizations).toContain('response-headers');
      expect(new Set(a.entries.map((e) => e.method)).size).toBe(6);
      expect(a.entries.map((e) => e.responseHeaders[0].value)).toEqual(
        entries.map((e) => e.response.headers[0].value),
      );
    }
  });
  it.each([
    'same method',
    'different body',
    'success',
    'request copy',
    'protected header',
    'non-UUID',
    'empty body',
    'two methods',
  ])('retains meaningful response differences across %s variations', async (kind) => {
    const entries = rows();
    for (const [i, e] of entries.entries()) {
      if (kind === 'same method') e.request.method = 'GET';
      if (kind === 'different body')
        e.response.content.text = JSON.stringify({
          fault: { message: 'Method rejected by upstream' },
          decision: ['Denied', 'Locked', 'Missing', 'Expired', 'Unknown', 'Invalid'][i],
        });
      if (kind === 'success') e.response.status = 200;
      if (kind === 'empty body') e.response.content.text = '';
      if (kind === 'two methods') e.request.method = i % 2 ? 'OPTIONS' : 'TRACE';
      if (kind === 'request copy')
        e.request.headers.push({ name: 'Arbitrary-Identifier', value: ids[i] });
      if (kind === 'protected header') e.response.headers[0].name = 'Content-Security-Policy';
      if (kind === 'non-UUID') e.response.headers[0].value = ids[i].replaceAll('-', '');
    }
    expect((await run(entries)).outcomes).toHaveLength(
      ['protected header', 'different body'].includes(kind) ? 6 : 1,
    );
  });
  it('keeps actual method policy boundaries while learning each supported cohort', async () => {
    const entries = rows();
    for (const [i, e] of entries.entries())
      e.response.headers.push({ name: 'Allow', value: i < 3 ? 'GET' : 'GET, POST' });
    expect((await run(entries)).outcomes.map((g) => g.members)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
  });
});

it('groups two valid UUID observations while retaining a changed upstream policy', async () => {
  const ids = ['04ea2ef4-7fa8-4374-9fc8-ecbc75ebfc71', '075d0498-9de8-4d85-93ba-6ffa2547d4e4'];
  const entries = ['OPTIONS', 'TRACE', 'PUT', 'DELETE', 'PATCH', 'POST'].map((method, i) => ({
    request: { method, url: 'https://example.test/items', headers: [] },
    response: {
      status: 502,
      headers: [{ name: 'Some-Identifier', value: ids[i % 2] }],
      content: { mimeType: 'text/plain', text: 'Upstream method rejected' },
    },
  }));
  const run = () => analyze(new Blob([JSON.stringify({ log: { entries } })]));
  expect((await run()).outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4, 5]]);
  for (const [i, e] of entries.entries())
    e.response.headers[0].value = `${ids[i % 2].slice(0, -1)}${i}`;
  entries[5].response.content.text = 'Different upstream policy';
  expect((await run()).outcomes).toHaveLength(2);
});

it.each([false, true])(
  'keeps metadata-only grouping independent of request method variations: %s',
  async (vary) => {
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'TRACE', 'PATCH', 'CUSTOM'];
    const entries = methods.map((method, i) => ({
      request: { method: vary ? method : 'GET', url: 'https://example.test/items', headers: [] },
      response: {
        status: 400,
        headers: [
          {
            name: 'Arbitrary-Result',
            value: createHash('sha256')
              .update('result-' + i)
              .digest('hex')
              .slice(0, 32),
          },
        ],
        content: { mimeType: 'application/json' },
      },
    }));
    const a = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
    expect(a.outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
  },
);

it.each(['same', 'body', 'policy'])(
  'preserves raw header equivalence across Date-dependent eligibility (%s)',
  async (difference) => {
    const clock = (i: number) => new Date(Date.UTC(2026, 10, 8, 10, 0, i));
    for (const reverse of [false, true]) {
      const entries = [1, 2, 3, 3601].map((i, at) => ({
        request: { method: 'GET', url: 'https://example.test/items', headers: [] },
        response: {
          status: 400,
          headers: [
            { name: 'Date', value: clock(i).toUTCString() },
            { name: 'Arbitrary-Clock', value: clock(at === 3 ? 1 : i).toISOString() },
            {
              name: 'Content-Security-Policy',
              value:
                difference === 'policy' && at === 3 ? "default-src 'none'" : "default-src 'self'",
            },
          ],
          content: {
            mimeType: 'text/plain',
            text: difference === 'body' && at === 3 ? 'Different response' : 'Rejected request',
          },
        },
      }));
      if (reverse) entries.reverse();
      const a = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
      expect(a.outcomes.map((g) => g.members.length).sort()).toEqual(
        difference === 'same' ? [4] : [1, 3],
      );
      expect(a.entries.map((e) => e.responseHeaders)).toEqual(
        entries.map((e) => e.response.headers),
      );
    }
  },
);

it('charges learned-header aliases to the existing metadata budget', async () => {
  const entries = [1, 2, 3].map((i) => {
    const clock = new Date(Date.UTC(2026, 10, 8, 10, 0, i));
    return {
      request: { method: 'GET', url: 'https://example.test/items', headers: [] },
      response: {
        status: 400,
        headers: [
          { name: 'Date', value: clock.toUTCString() },
          { name: 'Arbitrary-Clock', value: clock.toISOString() },
        ],
        content: { mimeType: 'text/plain', text: 'Rejected request' },
      },
    };
  });
  const capture = () => new Blob([JSON.stringify({ log: { entries } })]);
  const complete = await analyze(capture());
  expect(
    (
      await analyze(capture(), { limits: { metadataBytes: complete.summary.metadataEstimate } })
    ).outcomes.map((g) => g.members),
  ).toEqual([[0, 1, 2]]);
  await expect(
    analyze(capture(), { limits: { metadataBytes: complete.summary.metadataEstimate - 1 } }),
  ).rejects.toThrow('metadata budget');
});

it.each(['route', 'status', 'MIME', 'transport', 'provided'])(
  'keeps header-equivalence learning inside its %s association',
  async (difference) => {
    for (const reverse of [false, true]) {
      const entries = Array.from({ length: 10 }, (_, i) => ({
        request: {
          method: 'GET',
          url: 'https://example.test/' + (difference === 'route' && i >= 8 ? 'b' : 'a'),
          headers: [],
        },
        response: {
          status: difference === 'status' && i >= 8 ? 403 : 400,
          headers: [
            {
              name: 'Arbitrary-Identifier',
              value: createHash('sha256')
                .update('value-' + (i % 8))
                .digest('hex')
                .slice(0, 32),
            },
          ],
          content: {
            mimeType: difference === 'MIME' && i >= 8 ? 'text/html' : 'text/plain',
            text: 'Rejected request',
          },
          ...(difference === 'transport' && i >= 8 ? { _error: 'different upstream error' } : {}),
        },
      }));
      const sparse = new Set(entries.slice(8));
      if (reverse) entries.reverse();
      const contexts =
        difference === 'provided'
          ? [
              entries.flatMap((e, i) => (sparse.has(e) ? [] : [i])),
              entries.flatMap((e, i) => (sparse.has(e) ? [i] : [])),
            ]
          : undefined;
      const a = await analyze(
        new Blob([JSON.stringify({ log: { entries } })]),
        contexts ? { contexts } : undefined,
      );
      expect(a.outcomes.map((g) => g.members.length).sort()).toEqual([2, 8]);
    }
  },
);

it.each([
  ['missing', false],
  ['missing', true],
  ['malformed', false],
  ['malformed', true],
] as const)(
  'normalizes response noise independently of missing or malformed methods (%s, cookies: %s)',
  async (method, cookies) => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
      request: {
        url: 'https://example.test/items',
        headers: [],
        ...(method === 'malformed' ? { method: 'GET invalid' } : {}),
      },
      response: {
        status: 400,
        headers: [
          {
            name: cookies ? 'Set-Cookie' : 'Arbitrary-Identifier',
            value:
              (cookies ? 'session=' : '') +
              createHash('sha256')
                .update('method-' + i)
                .digest('hex')
                .slice(0, 32) +
              (cookies ? '; Path=/; HttpOnly' : ''),
          },
        ],
        content: cookies
          ? { mimeType: 'text/plain', text: 'Rejected request' }
          : { mimeType: 'application/json' },
      },
    }));
    expect(
      (await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes.map(
        (g) => g.members,
      ),
    ).toEqual([entries.map((_, i) => i)]);
  },
);

it.each([
  ['%', false],
  ['%', true],
  ['%ff', false],
  ['%ff', true],
] as const)(
  'normalizes response noise independently of unavailable decoded query inputs (%s, cookies: %s)',
  async (bad, cookies) => {
    const ids = Array.from({ length: 8 }, (_, i) =>
      createHash('sha256')
        .update('query-' + i)
        .digest('hex')
        .slice(0, 32),
    );
    const encoded = [...JSON.stringify(ids)]
      .map((char) => '%' + char.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('');
    const entries = ids.map((value) => ({
      request: {
        method: 'GET',
        url: 'https://example.test/items?q=' + encoded + '&bad=' + bad,
        headers: [],
      },
      response: {
        status: 400,
        headers: [
          {
            name: cookies ? 'Set-Cookie' : 'Arbitrary-Identifier',
            value: (cookies ? 'session=' : '') + value + (cookies ? '; Path=/; HttpOnly' : ''),
          },
        ],
        content: { mimeType: 'text/plain', text: 'Rejected request' },
      },
    }));
    expect(
      (await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes.map(
        (g) => g.members,
      ),
    ).toEqual([entries.map((_, i) => i)]);
  },
);

it.each(['copied', 'static', 'late copied'])(
  'classifies constant, reflected and varying header slots independently: %s',
  async (mode) => {
    const seeds = Array.from({ length: 8 }, (_, i) =>
      createHash('sha256')
        .update('compound-seed-' + i)
        .digest('hex')
        .slice(0, 32),
    );
    const count = mode === 'late copied' ? 16 : 8;
    const entries = Array.from({ length: count }, (_, i) => {
      const seed = mode === 'late copied' ? seeds[i % 8] : seeds[0];
      return {
        request: {
          method: 'GET',
          url: 'https://example.test/items?q=' + i,
          headers:
            mode === 'copied' || (mode === 'late copied' && i >= 8)
              ? [{ name: 'X-Seed', value: seed }]
              : [],
        },
        response: {
          status: 400,
          headers: [
            { name: 'X-Echo-Seed', value: seed },
            {
              name: 'X-Result-ID',
              value: createHash('sha256')
                .update('compound-result-' + i)
                .digest('hex')
                .slice(0, 32),
            },
          ],
          content: { mimeType: 'text/plain' },
        },
      };
    });
    expect(
      (await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes.map(
        (g) => g.members,
      ),
    ).toEqual([entries.map((_, i) => i)]);
  },
);

it.each(['Application/JSON', 'application/json; charset=utf-8'])(
  'preserves header equality across equivalent HAR MIME declarations: %s',
  async (mimeType) => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
      request: { method: 'GET', url: 'https://example.test/items', headers: [] },
      response: {
        status: 400,
        headers: [{ name: 'X-ID', value: createHash('sha256').update(String(i)).digest('hex') }],
        content: { mimeType: 'application/json', text: '{"error":"Rejected"}' },
      },
    }));
    entries.push({
      ...entries[0],
      response: { ...entries[0].response, content: { ...entries[0].response.content, mimeType } },
    });
    const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
    expect(result.outcomes.map((g) => g.members)).toEqual([Array.from({ length: 9 }, (_, i) => i)]);
    const different = {
      ...entries[0],
      response: {
        ...entries[0].response,
        content: { ...entries[0].response.content, mimeType: 'text/plain' },
      },
    };
    const control = await analyze(
      new Blob([JSON.stringify({ log: { entries: [...entries, different] } })]),
    );
    expect(control.outcomes.map((g) => g.members.length)).toEqual([9, 1]);
  },
);
it('preserves distinct CORS origins even when their host tokens resemble generated identifiers', async () => {
  const entries = Array.from({ length: 4 }, (_, i) => ({
    request: { method: 'GET', url: 'https://example.test/items', headers: [] },
    response: {
      status: 400,
      headers: [
        {
          name: 'Access-Control-Allow-Origin',
          value: 'https://tenant-' + createHash('sha256').update(String(i)).digest('hex') + '.test',
        },
      ],
      content: { mimeType: 'application/json', text: '{"error":"Rejected"}' },
    },
  }));
  expect((await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes).toHaveLength(
    4,
  );
});
it('compares identical response bodies when complete request bytes use unsupported application syntax', async () => {
  const entries = Array.from({ length: 3 }, (_, i) => ({
    request: {
      method: 'POST',
      url: 'https://example.test/',
      headers: [],
      postData: { mimeType: 'application/json', text: '{"input":"broken-' + i + '"' },
    },
    response: {
      status: 400,
      headers: [
        { name: 'X-Generated', value: createHash('sha256').update(String(i)).digest('hex') },
      ],
      content: { mimeType: 'application/json', text: '{"error":"Malformed JSON"}' },
    },
  }));
  const capture = () => new Blob([JSON.stringify({ log: { entries } })]);
  expect((await analyze(capture())).outcomes).toHaveLength(1);
  entries.forEach((e, i) => (e.response.content.text = JSON.stringify({ echo: 'broken-' + i })));
  expect((await analyze(capture())).outcomes).toHaveLength(3);
});

it('groups matching bodies across optional and repeated infrastructure headers', async () => {
  const entries = Array.from({ length: 24 }, (_, i) => ({
    request: { method: 'GET', url: 'https://service.invalid/api/check', headers: [] },
    response: {
      status: 400,
      headers:
        i % 3
          ? [
              { name: 'Alt-Svc', value: `h3=":${8000 + i}"` },
              {
                name: 'X-Diagnostic',
                value: `execution=${i % 4}; cache=${i % 2 ? 'hit' : 'miss'}`,
              },
              { name: 'X-Span', value: `node-${i}` },
              { name: 'X-Span', value: `hop-${i}` },
            ]
          : [],
      content: { mimeType: 'application/json', text: '{"error":"rejected"}' },
    },
  }));
  const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
  expect(result.outcomes.map((g) => g.members.length)).toEqual([24]);
  expect(result.outcomes[0].normalizations).toContain('response-headers');
  expect(result.entries[1].responseHeaders).toEqual(entries[1].response.headers);
});
it('keeps confirmed repeated header reflections distinct from unreflected matching bodies', async () => {
  const entries = ['alpha', 'bravo', 'charlie'].map((value) => ({
    request: { method: 'GET', url: 'https://service.invalid/api/check?q=' + value, headers: [] },
    response: {
      status: 400,
      headers: [
        { name: 'X-Captured', value: 'stable' },
        { name: 'X-Captured', value: `Rejected ${value}` },
      ],
      content: { mimeType: 'application/json', text: '{"error":"rejected"}' },
    },
  }));
  const unreflected = structuredClone(entries[0]);
  unreflected.response.headers[1].value = 'not reflected';
  entries.push(unreflected);
  const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
  expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2], [3]]);
});

it.each([
  'Location',
  'Refresh',
  'WWW-Authenticate',
  'Content-Security-Policy',
  'Referrer-Policy',
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Embedder-Policy',
  'Cross-Origin-Resource-Policy',
  'Content-Security-Policy-Report-Only',
  'Content-Encoding',
  'Transfer-Encoding',
  'Access-Control-Allow-Origin',
  'Set-Cookie',
])('keeps %s as a real response boundary despite arbitrary diagnostic changes', async (name) => {
  const entries = ['one', 'two'].map((value) => ({
    request: { method: 'GET', url: 'https://boundary.invalid/api/check', headers: [] },
    response: {
      status: 400,
      headers: [
        { name, value },
        { name: 'X-Diagnostic', value },
      ],
      content: { mimeType: 'text/plain', text: 'Rejected' },
    },
  }));
  const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
  expect(result.outcomes.map((g) => g.members)).toEqual([[0], [1]]);
});
it('preserves shared reflection relationships between response bodies and headers', async () => {
  const entries = ['alpha', 'bravo', 'charlie', 'delta'].map((value, i) => ({
    request: {
      method: 'GET',
      url: 'https://bindings.invalid/api/check?a=' + value + '&b=other-' + value,
      headers: [],
    },
    response: {
      status: 400,
      headers: [{ name: 'X-Echo', value: 'Rejected ' + (i < 2 ? value : 'other-' + value) }],
      content: {
        mimeType: 'application/json',
        text: JSON.stringify({ detail: 'Rejected ' + value }),
      },
    },
  }));
  expect(
    (await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes.map(
      (g) => g.members,
    ),
  ).toEqual([
    [0, 1],
    [2, 3],
  ]);
});
it('keeps confirmed header template syntax and encoding significant', async () => {
  const entries = ['alpha', 'bravo', 'charlie', 'delta'].map((value, i) => ({
    request: { method: 'GET', url: 'https://headers.invalid/api/check?q=' + value, headers: [] },
    response: {
      status: 400,
      headers: [{ name: 'X-Echo', value: (i < 2 ? 'Rejected ' : 'Accepted ') + value }],
      content: { mimeType: 'text/plain', text: 'same' },
    },
  }));
  expect(
    (await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes.map(
      (g) => g.members,
    ),
  ).toEqual([
    [0, 1],
    [2, 3],
  ]);
});

it('keeps complete header evidence when shared reflection matching work is exhausted', async () => {
  const entries = ['alpha', 'bravo'].map((value) => ({
    request: {
      method: 'GET',
      url: 'https://bounded.invalid/api/check?q=' + value,
      headers: Array.from({ length: 14 }, (_, i) => ({
        name: 'Input-' + i,
        value: 'Z'.repeat(1995) + '-' + String(i).padStart(3, '0'),
      })),
    },
    response: {
      status: 400,
      headers: Array.from({ length: 8 }, (_, i) => ({
        name: 'X-Diagnostic-' + i,
        value: 'Rejected ' + value + '; ' + 'x'.repeat(7000),
      })),
      content: { mimeType: 'text/plain', text: 'Rejected' },
    },
  }));
  const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
  expect(result.entries.every((e) => e.responseHeadersAvailable && e.requestHeadersHash)).toBe(
    true,
  );
  expect(result.summary.reflection?.candidateLimited).toBe(0);
  expect(result.summary.reflection?.entryLimited).toBe(2);
  expect(result.outcomes.map((g) => g.members)).toEqual([[0], [1]]);
  expect(result.entries.map((e) => e.responseHeaders)).toEqual(
    entries.map((e) => e.response.headers),
  );
});
