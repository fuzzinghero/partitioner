import { analyze } from './analyze.js';
import { createHash } from 'node:crypto';
import { analyzeReport } from './core.js';
import { expect, it, describe } from 'vitest';
import { classifyVariance } from './cohort-slots.js';
import type { ResponseSlot } from './response-slots.js';
const slots = (values: string[], type: ResponseSlot['type'] = 'string') =>
  values.map((value) => ({ path: 'test', type, value }));
it('normalizes two valid varying clock observations without a Date header', () => {
  expect(classifyVariance(slots(['2026-11-09T16:00:01Z', '2026-11-09T16:00:02Z']))).toBe(
    'volatile',
  );
  expect(classifyVariance(slots(['12.4ms', '14.1ms']))).toBe('volatile');
});
it('keeps constants and incompatible measurements', () => {
  expect(classifyVariance(slots(['12.4ms', '12.4ms']))).toBe('constant');
  expect(classifyVariance(slots(['12.4ms', '14.1s']))).toBe('behavioral');
});
it('requires four distinct values for generic numeric inference', () => {
  expect(classifyVariance(slots(['11', '14', '9'], 'number'))).toBe('behavioral');
  expect(classifyVariance(slots(['11', '14', '9', '18', '12'], 'number'))).toBe('volatile');
  expect(classifyVariance(slots(['11', '11', '14', '9'], 'number'))).toBe('behavioral');
});
it('keeps boolean flips, different enum states, and mixed types', () => {
  expect(classifyVariance(slots(['false', 'true'], 'boolean'))).toBe('behavioral');
  expect(classifyVariance(slots(['ERROR_100', 'ERROR_200', 'ERROR_300', 'ERROR_400']))).toBe(
    'behavioral',
  );
  expect(classifyVariance([...slots(['11'], 'number'), ...slots(['14'])])).toBe('behavioral');
});

import { classifyCohort } from './cohort-slots.js';
const cohort = (values: string[], inputs: string[]) =>
  values.map((value, id) => ({
    id,
    observation: value,
    slots: slots([value]),
    inputs: [{ source: 'query:q', value: inputs[id] }],
  }));
it('confirms short reflection while preserving an unmatched minority', () => {
  const result = classifyCohort(
    cohort(['Invalid: a', 'Invalid: b', 'Invalid: c', 'ACCOUNT_LOCKED'], ['a', 'b', 'c', 'd']),
  );
  expect(new Set([...result.values()].map((v) => v.key)).size).toBe(2);
  expect(result.get(3)?.reflection).toBe(false);
});
it('extends established reflection to an explicitly empty input but not a missing input', () => {
  const rows = cohort(
    ["Invalid: 'a'", "Invalid: 'b'", "Invalid: ''", "Invalid: ''"],
    ['a', 'b', '', ''],
  );
  rows[3].inputs = [];
  const result = classifyCohort(rows);
  expect(result.get(0)?.key).toBe(result.get(2)?.key);
  expect(result.get(0)?.key).not.toBe(result.get(3)?.key);
});
it('deduplicates statistical observations so repeated captures cannot change variance', () => {
  const rows = cohort(['11', '14', '9', '18', '12'], ['', '', '', '', '']);
  rows.forEach((r) => {
    r.slots = slots([r.observation], 'number');
  });
  const a = classifyCohort(rows);
  const b = classifyCohort([...rows, ...rows.map((r) => ({ ...r, id: r.id + 5 }))]);
  expect([...a.values()].map((v) => v.key)).toEqual([...b.values()].slice(0, 5).map((v) => v.key));
  expect(new Set([...a.values()].map((v) => v.key)).size).toBe(1);
});
it('does not erase unit differences through generic high-variance admission', () => {
  expect(classifyVariance(slots(['123456ms', '223456ms', '323456us', '423456us']))).toBe(
    'behavioral',
  );
});

describe('body cohort integration', () => {
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

    it.each(['x', 'ok', 'denied'])(
      'groups opaque variation alongside literal response state %s',
      async (state) => {
        for (const count of [3, 7, 8]) {
          for (const encoded of [false, true]) {
            const entries = ids.slice(0, count).map((id, i) => {
              const value = 'payload-' + i;
              const e = exchange(i, { echo: value, clock: stamp(i), identity: id, state });
              e.request.url += '?q=' + value;
              return encoded
                ? {
                    ...e,
                    response: {
                      ...e.response,
                      content: {
                        ...e.response.content,
                        text: btoa(e.response.content.text),
                        encoding: 'base64',
                      },
                    },
                  }
                : e;
            });
            for (const totalBodyBytes of [0, 32 * 1024 * 1024]) {
              const a = await analyze(capture(entries), { limits: { totalBodyBytes } });
              expect(
                a.outcomes.map((g) => g.members.length),
                `${count}/${encoded}/${totalBodyBytes}`,
              ).toEqual([count]);
              expect(new Set(a.entries.map((e) => e.body.hash)).size).toBe(count);
            }
          }
        }
      },
    );

    it('normalizes two valid varying opaque identities alongside clocks and reflection', async () => {
      const entries = ids.map((_, i) => {
        const value = 'payload-' + i;
        const e = exchange(i, { echo: value, clock: stamp(i), identity: ids[i % 2], state: 'x' });
        e.request.url += '?q=' + value;
        return e;
      });
      const a = await run(entries);
      expect(a.outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
    });

    it('normalizes standalone format-recognized diagnostics without witness text', async () => {
      const entries = ids.map((identity, i) =>
        exchange(i, { clock: stamp(i), identity, state: 'x' }),
      );
      expect((await run(entries)).outcomes.map((g) => g.members)).toEqual([ids.map((_, i) => i)]);
    });

    it('normalizes anonymous nested object slots using captured clock and opaque variation evidence', async () => {
      for (const names of [
        ['clock', 'nonce'],
        ['arbitrary/field', 'unrelated~property'],
        ['0', '7'],
      ]) {
        const entries = ids.map((id, i) =>
          exchange(i, {
            message: 'Rejected input',
            bucket: { [names[0]]: stamp(i), [names[1]]: id },
          }),
        );
        for (const totalBodyBytes of [0, 32 * 1024 * 1024]) {
          const a = await analyze(capture(entries), { limits: { totalBodyBytes } });
          expect(a.outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
        }
      }
    });

    it('uses parsed JSON keys consistently through escaping', async () => {
      const entries = ids.map((id, i) =>
        exchange(i, { message: 'Rejected input', arbitrary: stamp(i), another: id }),
      );
      for (const e of entries)
        e.response.content.text = e.response.content.text.replace('arbitrary', 'arbitr\\u0061ry');
      expect((await run(entries)).outcomes).toHaveLength(1);
    });

    it('preserves literal decisions and protocol boundaries while classifying eligible values', async () => {
      for (const variant of [
        'business-id',
        'business-time',
        'array',
        'decision',
        'copied',
        'policy',
      ]) {
        const entries = ids.map((id, i) => {
          const data =
            variant === 'business-id'
              ? { message: 'Rejected', account: id }
              : variant === 'business-time'
                ? { message: 'Rejected', at: `2027-10-28T10:00:0${i}Z` }
                : variant === 'array'
                  ? { message: 'Rejected', items: [{ a: stamp(i), b: id }] }
                  : {
                      message: 'Rejected',
                      a: stamp(i),
                      b: id,
                      ...(variant === 'decision' ? { decision: String.fromCodePoint(65 + i) } : {}),
                    };
          const e = exchange(
            i,
            data,
            variant === 'policy' ? [{ name: 'Location', value: 'https://example.test/' + id }] : [],
          );
          if (variant === 'copied')
            e.request.url += '?a=' + encodeURIComponent(stamp(i)) + '&b=' + id;
          return e;
        });
        const a = await run(entries);
        expect(a.outcomes, variant).toHaveLength(['decision', 'policy'].includes(variant) ? 8 : 1);
        if (variant === 'copied')
          expect(a.outcomes[0].normalizations ?? []).not.toContain('response-telemetry');
      }
    });

    it('isolates per-entry work so unrelated documents do not poison later clocks', async () => {
      const unrelated = Array.from({ length: 570 }, () => ({
        ...exchange(0, { message: 'x'.repeat(60 * 1024) }),
        request: { method: 'GET', url: 'https://other.test/large', headers: [] },
      }));
      const entries = ids.map((id, i) => exchange(i, { message: 'Rejected', a: stamp(i), b: id }));
      const a = await run([...unrelated, ...entries]);
      expect(new Set(a.entries.slice(-8).map((e) => e.outcome)).size).toBe(1);
    });

    it('normalizes repeated valid identifier values after observing variation', async () => {
      const entries = ids.map((_, i) =>
        exchange(i, { message: 'Rejected', clock: stamp(i), identity: ids[i % 2] }),
      );
      const a = await run(entries);
      expect(a.outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
    });
  });

  describe('automatic response normalization', () => {
    const nonce = (i: number) =>
      createHash('sha256')
        .update('fixed-fixture-' + i)
        .digest('hex')
        .slice(0, 32);

    const dated = (i: number) => ({
      name: 'Date',
      value: new Date(Date.UTC(2026, 10, 8, 10, 0, i)).toUTCString(),
    });

    const capture = (rows: unknown[]) => new Blob([JSON.stringify({ log: { entries: rows } })]);

    const row = (mime: string, text: string, headers: { name: string; value: string }[] = []) => ({
      request: { method: 'GET', url: 'https://example.test/result', headers: [] },
      response: { status: 400, headers, content: { mimeType: mime, text } },
    });

    const groups = async (rows: unknown[]) =>
      (await analyze(capture(rows))).outcomes.map((g) => g.members);

    it('normalizes corroborated generated diagnostics and composes with request reflections', async () => {
      for (const reflected of [false, true]) {
        const rows = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
          const e = row(
            'application/json',
            JSON.stringify({
              error: 'Rejected input',
              ...(reflected ? { echo: `payload-${i}` } : {}),
              trace_id: nonce(i),
              generated_at: `2026-11-08T10:00:0${i}Z`,
            }),
            [dated(i)],
          );
          if (reflected) e.request.url += '?q=payload-' + i;
          return e;
        });
        expect(await groups(rows)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
        const report = await analyzeReport(capture(rows));
        expect(report.contexts[0].partitions[0].grouping.heuristic).toBe(true);
        expect(report.contexts[0].partitions[0].grouping.normalizations).toContain(
          'response-telemetry',
        );
        expect(report.contexts[0].partitions[0].sample?.response.body.text).toBe(
          rows[0].response.content.text,
        );
        expect(await groups(rows.slice(0, 2))).toEqual([[0, 1]]);
      }
    });

    it.each(['user_id', 'order_id', 'scheduled_at', 'referenceId', 'timestamp'])(
      'normalizes eligible identifiers independently of the application field name %s',
      async (field) => {
        expect(
          await groups(
            [1, 2, 3].map((i) =>
              row('application/json', JSON.stringify({ error: 'Rejected', [field]: nonce(i) })),
            ),
          ),
        ).toEqual([[0, 1, 2]]);
      },
    );

    it('preserves types and decisions while classifying supported value formats', async () => {
      for (const variant of [
        'decision',
        'copied',
        'invalid',
        'type',
        'business-path',
        'no-witness',
      ]) {
        const rows = [1, 2, 3].map((i) => {
          const id = nonce(i);
          const data =
            variant === 'business-path'
              ? { order: { trace_id: id }, error: 'Rejected' }
              : {
                  trace_id: variant === 'invalid' ? `account-${id}` : id,
                  ...(variant === 'no-witness' ? {} : { error: 'Rejected' }),
                  ...(variant === 'decision' ? { decision: String.fromCodePoint(65 + i) } : {}),
                };
          if (variant === 'type')
            (data as Record<string, unknown>).generated_at =
              i === 1 ? '1794132000' : 1794132000 + i;
          const e = row('application/json', JSON.stringify(data));
          if (variant === 'copied') e.request.url += '?q=' + id;
          return e;
        });
        expect(await groups(rows), variant).toEqual(
          variant === 'decision'
            ? [[0], [1], [2]]
            : variant === 'type'
              ? [[0], [1], [2]]
              : [[0, 1, 2]],
        );
        if (variant === 'copied')
          expect(
            (await analyzeReport(capture(rows))).contexts[0].partitions[0].grouping
              .normalizations ?? [],
          ).not.toContain('response-telemetry');
      }
    });

    it('retains telemetry normalization through body eviction and HAR base64 decoding', async () => {
      const rows = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
        const e = row(
          'application/json',
          JSON.stringify({
            error: 'Rejected',
            trace_id: nonce(i),
            arbitrary: `2026-11-08T10:00:0${i}Z`,
          }),
          [dated(i)],
        );
        return {
          ...e,
          response: {
            ...e.response,
            content: {
              ...e.response.content,
              encoding: 'base64',
              text: btoa(e.response.content.text),
            },
          },
        };
      });
      const result = await analyze(capture(rows), { limits: { totalBodyBytes: 0 } });
      expect(result.entries.every((e) => e.body.text === undefined)).toBe(true);
      expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
    });

    it('normalizes valid varying opaque values without claiming case-folded reflection', async () => {
      const rows = [1, 2, 3].map((i) => {
        const value = nonce(i);
        const e = row(
          'application/json',
          JSON.stringify({ error: 'Rejected', trace_id: value.toUpperCase() }),
        );
        e.request.url += '?q=' + value;
        return e;
      });
      expect(await groups(rows)).toEqual([[0, 1, 2]]);
    });

    it.each(['status', 'policy', 'invalid-request', 'duplicate-json', 'invalid-time'])(
      'classifies telemetry independently of request syntax and preserves response boundaries: %s',
      async (variant) => {
        const rows = Array.from({ length: 16 }, (_, i) => {
          const data = {
            error: 'Rejected',
            trace_id: nonce(i + 1),
            anonymous: new Date(Date.UTC(2026, 10, 8, 10, 0, i)).toISOString(),
            ...(variant === 'invalid-time' ? { generated_at: `2026-02-30T10:00:0${i}Z` } : {}),
          };
          const e = row(
            'application/json',
            variant === 'duplicate-json'
              ? `{"trace_id":"${data.trace_id}","trace_id":"${data.trace_id}","error":"Rejected"}`
              : JSON.stringify(data),
          );
          if (variant === 'status') e.response.status = i < 8 ? 400 : 403;
          if (variant === 'policy')
            e.response.headers = [
              { name: 'Access-Control-Allow-Origin', value: i < 8 ? '*' : 'https://other.test' },
            ];
          e.response.headers.push(dated(i));
          return variant === 'invalid-request'
            ? {
                ...e,
                request: {
                  ...e.request,
                  postData: { mimeType: 'application/json', text: '{broken' },
                },
              }
            : e;
        });
        expect(await groups(rows)).toEqual(
          variant === 'invalid-request'
            ? [Array.from({ length: 16 }, (_, i) => i)]
            : ['status', 'policy'].includes(variant)
              ? [
                  [0, 1, 2, 3, 4, 5, 6, 7],
                  [8, 9, 10, 11, 12, 13, 14, 15],
                ]
              : Array.from({ length: 16 }, (_, i) => [i]),
        );
      },
    );
  });

  it.each(['text/plain', 'text/html'])(
    'preserves BOM-bearing %s telemetry membership across partial eviction',
    async (mime) => {
      const entries = [1, 2, 3, 4].map((i) => {
        const stamp = new Date(Date.UTC(2026, 8, 1, 14, 8, i)).toUTCString();
        const body = `\uFEFFThe requested operation is temporarily unavailable.\n${stamp}\n${stamp}`;
        const text =
          mime === 'text/html'
            ? `\uFEFF<select><option>fixed</option></select><p>${body.slice(1)}</p>`
            : body;
        return {
          request: { method: 'GET', url: 'https://example.test/error', headers: [] },
          response: {
            status: 400,
            headers: [{ name: 'Date', value: stamp }],
            content: {
              mimeType: mime,
              text: Buffer.from(text, 'utf8').toString('base64'),
              encoding: 'base64',
            },
          },
        };
      });
      const bytes = Buffer.from(entries[0].response.content.text, 'base64').length;
      for (const totalBodyBytes of [0, bytes, bytes * 4]) {
        const a = await analyze(new Blob([JSON.stringify({ log: { entries } })]), {
          limits: { totalBodyBytes },
        });
        expect(a.outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3]]);
        expect(new Set(a.entries.map((e) => e.body.hash)).size).toBe(4);
        if (totalBodyBytes >= bytes)
          expect(a.entries[0].body.text?.startsWith('\uFEFF')).toBe(true);
      }
    },
  );

  it.each(['a/bb', 'a~bb', 'a~1b'])(
    'retains literal JSON names while normalizing separately varying clocks: %s',
    async (key) => {
      for (const [body, echoed] of [
        [{ [key]: 'input' }, key],
        [{ parent: { [key]: 'input' } }, 'parent'],
        [{ items: [{ [key]: 'input' }] }, key],
      ] as [unknown, string][]) {
        for (const independent of [false, true]) {
          const entries = [1, 2, 3].map((i) => {
            const clock = new Date(Date.UTC(2026, 10, 8, 10, 0, i));
            return {
              request: {
                method: 'POST',
                url: 'https://example.test/items',
                headers: [],
                postData: { mimeType: 'application/json', text: JSON.stringify(body) },
              },
              response: {
                status: 400,
                headers: [{ name: 'Date', value: clock.toUTCString() }],
                content: {
                  mimeType: 'application/json',
                  text: JSON.stringify({
                    clock: clock.toISOString(),
                    message: independent ? 'Independent server rejection' : echoed,
                  }),
                },
              },
            };
          });
          const a = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
          expect(a.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
        }
      }
    },
  );

  it('retains constant numeric fields while normalizing clocks for object and array requests', async () => {
    for (const array of [false, true]) {
      const body = array ? Array.from({ length: 101 }, () => 'input') : { '100': 'input' };
      const entries = [1, 2, 3].map((i) => {
        const clock = new Date(Date.UTC(2026, 10, 8, 10, 0, i));
        return {
          request: {
            method: 'POST',
            url: 'https://example.test/items',
            headers: [],
            postData: { mimeType: 'application/json', text: JSON.stringify(body) },
          },
          response: {
            status: 400,
            headers: [{ name: 'Date', value: clock.toUTCString() }],
            content: {
              mimeType: 'application/json',
              text: JSON.stringify({ clock: clock.toISOString(), message: 100 }),
            },
          },
        };
      });
      expect(
        (await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes.map(
          (g) => g.members,
        ),
      ).toEqual([[0, 1, 2]]);
    }
  });

  it.each(['application/x-www-form-urlencoded', 'multipart/form-data; boundary=fixture'])(
    'indexes literal escaped field names from %s requests',
    async (mime) => {
      const name = 'a/b~name';
      const body = mime.startsWith('multipart')
        ? `--fixture\r\nContent-Disposition: form-data; name="${name}"\r\n\r\ninput\r\n--fixture--\r\n`
        : `${encodeURIComponent(name)}=input`;
      const entries = [1, 2, 3].map((i) => {
        const clock = new Date(Date.UTC(2026, 10, 8, 10, 0, i));
        return {
          request: {
            method: 'POST',
            url: 'https://example.test/items',
            headers: [],
            postData: { mimeType: mime, text: body },
          },
          response: {
            status: 400,
            headers: [{ name: 'Date', value: clock.toUTCString() }],
            content: {
              mimeType: 'application/json',
              text: JSON.stringify({ clock: clock.toISOString(), message: name }),
            },
          },
        };
      });
      expect(
        (await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes.map(
          (g) => g.members,
        ),
      ).toEqual([[0, 1, 2]]);
    },
  );

  it.each(['query', 'JSON body', 'raw body'])(
    'normalizes clocks independently of constant copied string wrappers: %s',
    async (source) => {
      const input = 'copied-request-payload-with-many-characters';
      for (const suffix of ['.', 'abc', ' independent server rejection']) {
        const entries = [1, 2, 3].map((i) => {
          const clock = new Date(Date.UTC(2026, 10, 8, 10, 0, i));
          return {
            request: {
              method: 'POST',
              url: 'https://example.test/items' + (source === 'query' ? '?q=' + input : ''),
              headers: [],
              ...(source === 'query'
                ? {}
                : {
                    postData: {
                      mimeType: source === 'JSON body' ? 'application/json' : 'text/plain',
                      text:
                        source === 'JSON body'
                          ? JSON.stringify({ input })
                          : 'prefix:' + input + ':suffix',
                    },
                  }),
            },
            response: {
              status: 400,
              headers: [{ name: 'Date', value: clock.toUTCString() }],
              content: {
                mimeType: 'application/json',
                text: JSON.stringify({ clock: clock.toISOString(), message: input + suffix }),
              },
            },
          };
        });
        const a = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
        expect(a.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
      }
    },
  );

  it.each([
    ['1e0', '1', true],
    ['1.000', '1', true],
    ['-0', '0', true],
    ['9007199254740993', '9007199254740993.0', true],
    ['1e100000', '10e99999', true],
    ['9007199254740993', '9007199254740992', false],
  ] as const)(
    'preserves captured numeric lexemes while normalizing clocks: %s -> %s',
    async (input, output) => {
      const entries = [1, 2, 3].map((i) => {
        const clock = new Date(Date.UTC(2026, 10, 8, 10, 0, i));
        return {
          request: {
            method: 'POST',
            url: 'https://example.test/items',
            headers: [],
            postData: { mimeType: 'application/json', text: '{"count":' + input + '}' },
          },
          response: {
            status: 400,
            headers: [{ name: 'Date', value: clock.toUTCString() }],
            content: {
              mimeType: 'application/json',
              text: '{"clock":' + JSON.stringify(clock.toISOString()) + ',"value":' + output + '}',
            },
          },
        };
      });
      const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
      expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
      expect(result.entries.map((e) => e.body.text)).toEqual(
        entries.map((e) => e.response.content.text),
      );
    },
  );

  it.each(['%', '%ff'])(
    'normalizes JSON and text clocks independently of unavailable query decoding (%s)',
    async (bad) => {
      const input = 'copied-request-payload-that-is-long-enough';
      for (const mime of ['application/json', 'text/plain']) {
        const entries = [1, 2, 3].map((i) => {
          const clock = new Date(Date.UTC(2026, 10, 8, 10, 0, i));
          return {
            request: {
              method: 'GET',
              url: 'https://example.test/items?q=' + input.replaceAll('-', '%2D') + '&bad=' + bad,
              headers: [],
            },
            response: {
              status: 400,
              headers: [{ name: 'Date', value: clock.toUTCString() }],
              content: {
                mimeType: mime,
                text:
                  mime === 'application/json'
                    ? JSON.stringify({ clock: clock.toISOString(), message: input })
                    : `${input}\n${clock.toUTCString()}\n${clock.toUTCString()}`,
              },
            },
          };
        });
        expect(
          (await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes.map(
            (g) => g.members,
          ),
        ).toEqual([[0, 1, 2]]);
      }
    },
  );

  it.each(['JSON', 'text', 'header', 'cookie'])(
    'preserves supported %s noise inference with null exporter query metadata',
    async (kind) => {
      const message = 'The request could not be completed for this resource.';
      const entries = Array.from({ length: 8 }, (_, i) => {
        const clock = new Date(Date.UTC(2026, 10, 8, 10, 0, i));
        const opaque = createHash('sha256')
          .update('null-query-' + i)
          .digest('hex')
          .slice(0, 32);
        return {
          request: {
            method: 'GET',
            url: 'https://example.test/items',
            headers: [],
            queryString: null,
          },
          response: {
            status: 400,
            headers: [
              { name: 'Date', value: clock.toUTCString() },
              ...(kind === 'header' ? [{ name: 'Arbitrary-Identifier', value: opaque }] : []),
              ...(kind === 'cookie'
                ? [{ name: 'Set-Cookie', value: `session=${opaque}; Path=/; HttpOnly` }]
                : []),
            ],
            content: {
              mimeType: kind === 'JSON' ? 'application/json' : 'text/plain',
              text:
                kind === 'JSON'
                  ? JSON.stringify({ clock: clock.toISOString(), message })
                  : kind === 'text'
                    ? `${message}\n${clock.toUTCString()}\n${clock.toUTCString()}`
                    : message,
            },
          },
        };
      });
      const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
      expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
      expect(result.entries.map((e) => e.url)).toEqual(entries.map((e) => e.request.url));
    },
  );

  const copiedComponent = 'captured-input-long-enough-to-supply-an-entire-independent-witness';
  const encodedComponent = [...copiedComponent]
    .map((char) => '%' + char.charCodeAt(0).toString(16))
    .join('');
  it.each([
    ['path', `https://example.test/${copiedComponent}`, copiedComponent, true],
    ['encoded path', `https://example.test/${encodedComponent}`, copiedComponent, true],
    [
      'double encoded path',
      `https://example.test/${encodeURIComponent(encodedComponent)}`,
      copiedComponent,
      true,
    ],
    ['origin form', `/${copiedComponent}`, copiedComponent, true],
    [
      'hostname',
      `https://${copiedComponent}.example.test:8443/items`,
      `${copiedComponent}.example.test`,
      true,
    ],
    [
      'authority',
      `https://${copiedComponent}.example.test:8443/items`,
      `${copiedComponent}.example.test:8443`,
      true,
    ],
    ['malformed sibling', `https://example.test/${encodedComponent}/%`, copiedComponent, false],
    [
      'invalid UTF8 sibling',
      `https://example.test/${encodedComponent}/%ff`,
      copiedComponent,
      false,
    ],
    [
      'malformed same component',
      `https://example.test/${encodedComponent}%`,
      copiedComponent,
      false,
    ],
    [
      'invalid UTF8 same component',
      `https://example.test/${encodedComponent}%ff`,
      copiedComponent,
      false,
    ],
  ] as const)(
    'normalizes clocks independently of malformed path decoding: %s',
    async (_, url, copied, _supported) => {
      for (const mime of ['application/json', 'text/plain']) {
        for (const independent of [false, true]) {
          const message =
            (independent ? 'The request could not be completed for this resource: ' : '') +
            copied +
            '.';
          const entries = [1, 2, 3].map((i) => {
            const clock = new Date(Date.UTC(2026, 10, 8, 10, 0, i));
            return {
              request: {
                method: 'GET',
                url,
                headers: url.startsWith('/') ? [{ name: 'Host', value: 'example.test' }] : [],
              },
              response: {
                status: 400,
                headers: [{ name: 'Date', value: clock.toUTCString() }],
                content: {
                  mimeType: mime,
                  text:
                    mime === 'application/json'
                      ? JSON.stringify({ clock: clock.toISOString(), message })
                      : `${message}\n${clock.toUTCString()}\n${clock.toUTCString()}`,
                },
              },
            };
          });
          expect(
            (await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes.map(
              (g) => g.members,
            ),
            `${mime}/${independent}`,
          ).toEqual([[0, 1, 2]]);
        }
      }
    },
  );

  it.each(['state', 'capturedAttributeNameLongEnoughForTextClockEvidence'])(
    'retains constant XML name text while normalizing separate clocks: %s',
    async (name) => {
      for (const mime of ['application/json', 'text/plain']) {
        for (const independent of [false, true]) {
          const entries = [1, 2, 3].map((i) => {
            const clock = new Date(Date.UTC(2026, 10, 8, 10, 0, i));
            const message =
              (independent ? 'The request could not be completed for this resource: ' : '') +
              name +
              '.';
            return {
              request: {
                method: 'POST',
                url: 'https://example.test/items',
                headers: [{ name: 'Content-Type', value: 'application/xml' }],
                postData: { mimeType: 'application/xml', text: `<r ${name}="input"/>` },
              },
              response: {
                status: 400,
                headers: [{ name: 'Date', value: clock.toUTCString() }],
                content: {
                  mimeType: mime,
                  text:
                    mime === 'application/json'
                      ? JSON.stringify({ clock: clock.toISOString(), message })
                      : `${message}\n${clock.toUTCString()}\n${clock.toUTCString()}`,
                },
              },
            };
          });
          expect(
            (await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes.map(
              (g) => g.members,
            ),
            `${mime}/${independent}`,
          ).toEqual([[0, 1, 2]]);
        }
      }
    },
  );

  it.each(['application/json', 'text/plain', 'text/html'])(
    'applies encoded telemetry allowance independently of text retention for %s',
    async (mime) => {
      for (const encodedLength of [0, 90 * 1024, 90 * 1024 + 1, 95 * 1024]) {
        const entries = [1, 2, 3].map((i) => {
          const clock = new Date(Date.UTC(2026, 10, 8, 10, 0, i));
          const message = 'The request could not be completed for this resource.';
          const text =
            mime === 'application/json'
              ? JSON.stringify({ clock: clock.toISOString(), message })
              : `${message}\n${clock.toUTCString()}\n${clock.toUTCString()}`;
          const encoded = btoa(text);
          return {
            request: { method: 'POST', url: 'https://example.test/items', headers: [] },
            response: {
              status: 400,
              headers: [{ name: 'Date', value: clock.toUTCString() }],
              content: {
                mimeType: mime,
                encoding: 'base64',
                text: ' '.repeat(Math.max(0, encodedLength - encoded.length)) + encoded,
              },
            },
          };
        });
        const hashes: (string | undefined)[][] = [];
        for (const totalBodyBytes of [1024 * 1024, 0]) {
          const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]), {
            // Reach the clock fallback when the separate HTML shape pass is exhausted.
            limits: { totalBodyBytes, ...(mime === 'text/html' ? { shapeNodes: 1 } : {}) },
          });
          expect(
            result.outcomes.map((g) => g.members),
            `${encodedLength}/${totalBodyBytes}`,
          ).toEqual(encodedLength > 90 * 1024 ? [[0], [1], [2]] : [[0, 1, 2]]);
          hashes.push(result.entries.map((e) => e.body.hash));
        }
        expect(hashes[0]).toEqual(hashes[1]);
      }
    },
  );

  it.each(['JSON', 'formatted JSON', 'XML', 'Form', 'Multipart'])(
    'retains constant complete %s request echoes while normalizing separate clocks',
    async (kind) => {
      const data = { alpha: 'copied-a', beta: 'copied-b' };
      const requestText =
        kind === 'JSON'
          ? JSON.stringify(data)
          : kind === 'formatted JSON'
            ? JSON.stringify(data, null, 2)
            : kind === 'XML'
              ? '<r alpha="copied-a"><beta>copied-b</beta></r>'
              : kind === 'Form'
                ? 'alpha=copied-a&beta=copied-b'
                : '--b\r\nContent-Disposition: form-data; name="alpha"\r\n\r\ncopied-a\r\n--b\r\nContent-Disposition: form-data; name="beta"\r\n\r\ncopied-b\r\n--b--\r\n';
      const requestMime = kind.includes('JSON')
        ? 'application/json'
        : kind === 'XML'
          ? 'application/xml'
          : kind === 'Form'
            ? 'application/x-www-form-urlencoded'
            : 'multipart/form-data; boundary=b';
      const canonical = kind === 'formatted JSON' ? JSON.stringify(data) : requestText;
      for (const encode of [
        (value: string) => value,
        encodeURIComponent,
        (value: string) =>
          value
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;'),
      ]) {
        for (const mime of ['application/json', 'text/plain']) {
          for (const independent of [false, true]) {
            const message =
              (independent ? 'The request could not be completed for this resource: ' : '') +
              encode(canonical) +
              '.';
            const entries = [1, 2, 3].map((i) => {
              const clock = new Date(Date.UTC(2026, 10, 8, 10, 0, i));
              return {
                request: {
                  method: 'POST',
                  url: 'https://example.test/items',
                  headers: [{ name: 'Content-Type', value: requestMime }],
                  postData: { mimeType: requestMime, text: requestText },
                },
                response: {
                  status: 400,
                  headers: [{ name: 'Date', value: clock.toUTCString() }],
                  content: {
                    mimeType: mime,
                    text:
                      mime === 'application/json'
                        ? JSON.stringify({ clock: clock.toISOString(), message })
                        : `${message}\n${clock.toUTCString()}\n${clock.toUTCString()}`,
                  },
                },
              };
            });
            expect(
              (await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes.map(
                (g) => g.members,
              ),
              `${mime}/${independent}`,
            ).toEqual([[0, 1, 2]]);
          }
        }
      }
    },
  );

  it.each(['name', 'value'])(
    'retains constant multipart metadata text while normalizing separate clocks: %s',
    async (source) => {
      const name = 'X-Captured-Part-Header-Name-Long-Enough';
      const value = 'captured-part-header-value-long-enough-for-independent-text';
      for (const mime of ['application/json', 'text/plain']) {
        for (const independent of [false, true]) {
          const message =
            (independent ? 'The request could not be completed for this resource: ' : '') +
            (source === 'name' ? name : value) +
            '.';
          const entries = [1, 2, 3].map((i) => {
            const clock = new Date(Date.UTC(2026, 10, 8, 10, 0, i));
            return {
              request: {
                method: 'POST',
                url: 'https://example.test/items',
                headers: [{ name: 'Content-Type', value: 'multipart/form-data; boundary=b' }],
                postData: {
                  mimeType: 'multipart/form-data; boundary=b',
                  text: `--b\r\nContent-Disposition: form-data; name="q"\r\n${name}: ${value}\r\n\r\ninput\r\n--b--\r\n`,
                },
              },
              response: {
                status: 400,
                headers: [{ name: 'Date', value: clock.toUTCString() }],
                content: {
                  mimeType: mime,
                  text:
                    mime === 'application/json'
                      ? JSON.stringify({ clock: clock.toISOString(), message })
                      : `${message}\n${clock.toUTCString()}\n${clock.toUTCString()}`,
                },
              },
            };
          });
          expect(
            (await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes.map(
              (g) => g.members,
            ),
            `${mime}/${independent}`,
          ).toEqual([[0, 1, 2]]);
        }
      }
    },
  );

  it.each(['', 'İ 🧪 ', 'Rejected input: '])(
    'retains constant case-changed copies while normalizing separate clocks: %s',
    async (prefix) => {
      const seed = 'abcdef0123456789abcdef0123456789';
      const entries = [0, 1, 2].map((i) => {
        const clock = new Date(Date.UTC(2026, 9, 28, 10, 0, i));
        return {
          request: { method: 'GET', url: 'https://example.test/items?seed=' + seed, headers: [] },
          response: {
            status: 400,
            headers: [{ name: 'Date', value: clock.toUTCString() }],
            content: {
              mimeType: 'application/json',
              text: JSON.stringify({
                clock: clock.toISOString(),
                message: prefix + seed.toUpperCase() + '.',
              }),
            },
          },
        };
      });
      const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
      expect(result.outcomes.length).toBe(1);
      expect(new Set(result.entries.map((entry) => entry.body.hash)).size).toBe(3);
    },
  );
});

it('does not let an entry with exhausted later work corroborate earlier reflection slots', () => {
  const rows = [
    {
      id: 0,
      observation: 'a',
      inputs: [{ value: 'alpha1234', source: 'q' }],
      slots: [
        { path: 'first', type: 'string' as const, value: 'Invalid: alpha1234' },
        { path: 'later', type: 'string' as const, value: 'x'.repeat(8192) },
      ],
    },
    {
      id: 1,
      observation: 'b',
      inputs: [
        { value: 'bravo5678', source: 'q' },
        ...Array.from({ length: 199 }, (_, i) => ({
          value: 'candidate-' + i + '-unused',
          source: 'other' + i,
        })),
      ],
      slots: [
        { path: 'first', type: 'string' as const, value: 'Invalid: bravo5678' },
        { path: 'later', type: 'string' as const, value: 'y'.repeat(8192) },
      ],
    },
  ];
  const limited: number[] = [];
  const result = classifyCohort(rows, (id) => limited.push(id));
  expect(limited).toEqual([1]);
  expect(result.get(0)?.reflection).toBe(false);
  expect(result.get(1)?.reflection).toBe(false);
  expect(result.get(1)?.noise).toBe(false);
});
it('preserves whether different reflected response fields repeat the same captured value', () => {
  const rows = [
    ['alpha1234', 'alpha1234'],
    ['bravo5678', 'bravo5678'],
    ['charlie12', 'delta3456'],
    ['echo7890', 'foxtrot12'],
  ].map((values, id) => ({
    id,
    observation: String(id),
    inputs: values.map((value, i) => ({ value, source: 'q' + i })),
    slots: values.map((value, i) => ({ path: String(i), type: 'string' as const, value })),
  }));
  const identities = classifyCohort(rows);
  expect(identities.get(0)?.key).toBe(identities.get(1)?.key);
  expect(identities.get(2)?.key).toBe(identities.get(3)?.key);
  expect(identities.get(0)?.key).not.toBe(identities.get(2)?.key);
});

describe('clock slots through production analysis', () => {
  const date = (i: number) => new Date(Date.UTC(2026, 8, 1, 14, 8, i)).toUTCString();
  const message = 'Your access to this site has been limited by the site owner';
  const text = (i: number) => `${message}\nGenerated at ${date(i)}\nServer time: ${date(i)}`;
  const exchange = (i: number, body = text(i)) => ({
    request: { method: 'GET', url: 'https://example.test/', headers: [] },
    response: {
      status: 503,
      headers: [{ name: 'Date', value: date(i) }],
      content: { mimeType: 'text/plain', text: body },
    },
  });
  const run = (entries: unknown[], totalBodyBytes = 32 * 1024 * 1024) =>
    analyze(new Blob([JSON.stringify({ log: { entries } })]), { limits: { totalBodyBytes } });

  it('groups a corroborated error cohort through production analysis without losing raw bytes', async () => {
    for (const evicted of [false, true]) {
      const entries = [1, 2, 3].map((i) => exchange(i));
      const a = await run(entries, evicted ? 0 : undefined);
      expect(a.outcomes.map((o) => o.members)).toEqual([[0, 1, 2]]);
      expect(a.outcomes[0].normalizations).toContain('response-telemetry');
      expect(new Set(a.entries.map((e) => e.body.hash)).size).toBe(3);
      if (!evicted)
        expect(a.entries.map((e) => e.body.text)).toEqual(
          entries.map((e) => e.response.content.text),
        );
    }
  });

  it('preserves changed messages and status boundaries without stranding coincidental clock copies', async () => {
    const entries = [1, 2, 3].map((i) => exchange(i));
    const changed = exchange(4, text(4).replace('limited', 'allowed'));
    const copied = exchange(5);
    copied.request.url += '?input=' + encodeURIComponent(date(5));
    const absent = exchange(6);
    absent.response.headers = [];
    const success = exchange(7);
    success.response.status = 200;
    const a = await run([...entries, changed, copied, absent, success]);
    expect(a.outcomes.map((o) => o.members)).toEqual([[0, 1, 2, 4, 5], [3], [6]]);
    expect((await run(entries.slice(0, 2))).outcomes).toHaveLength(1);
  });

  it('uses literal HTML exclusions in production, including decoded and evicted bodies', async () => {
    for (const encoded of [false, true]) {
      const entries = [1, 2, 3].map((i) => {
        const e = exchange(i, `<select><option>Stable choice</option></select><p>${text(i)}</p>`);
        return {
          ...e,
          response: {
            ...e.response,
            content: {
              mimeType: 'text/html',
              text: encoded ? btoa(e.response.content.text) : e.response.content.text,
              ...(encoded ? { encoding: 'base64' } : {}),
            },
          },
        };
      });
      const a = await run(entries, 0);
      expect(a.outcomes.map((o) => o.members)).toEqual([[0, 1, 2]]);
      expect(a.outcomes[0].normalizations).toContain('response-telemetry');
      expect(new Set(a.entries.map((e) => e.body.hash)).size).toBe(3);
    }
  });

  it('declines conflicting clock and media evidence and preserves response-header boundaries', async () => {
    const entries = [1, 2, 3].map((i) => exchange(i));
    const duplicate = [4, 5, 6].map((i) => {
      const e = exchange(i);
      e.response.headers.push({ name: 'Date', value: date(i) });
      return e;
    });
    const conflict = [7, 8, 9].map((i) => {
      const e = exchange(i);
      e.response.headers.push({ name: 'Content-Type', value: 'application/json' });
      return e;
    });
    const header = [10, 11, 12].map((i) => {
      const e = exchange(i);
      e.response.headers.push({ name: 'Content-Security-Policy', value: "default-src 'none'" });
      return e;
    });
    const a = await run([...entries, ...duplicate, ...conflict, ...header]);
    expect(a.outcomes.map((o) => o.members)).toEqual([
      [0, 1, 2],
      [3],
      [4],
      [5],
      [6],
      [7],
      [8],
      [9, 10, 11],
    ]);
  });

  it.each(['text/plain', 'text/html'])(
    'retains constant copied input text while normalizing clocks in %s',
    async (mime) => {
      const input = 'client-supplied-value-with-many-copied-characters';
      for (const suffix of ['.', 'abc', ' ' + message]) {
        const entries = [1, 2, 3].map((i) => {
          const body = `${input}${suffix}\n${date(i)}\n${date(i)}`;
          const e = exchange(
            i,
            mime === 'text/html' ? `<select><option>fixed</option></select><p>${body}</p>` : body,
          );
          e.request.url += '?input=' + encodeURIComponent(input);
          e.response.content.mimeType = mime;
          return e;
        });
        const a = await run(entries);
        expect(a.outcomes.map((g) => g.members.length)).toEqual([3]);
      }
    },
  );

  it.each(['entities', 'URL'])(
    'retains constant bounded %s copies while normalizing separate clocks',
    async (encoding) => {
      const input = 'client-supplied-value-with-special-characters-<>&"';
      const rendered =
        encoding === 'URL'
          ? encodeURIComponent(input)
          : input
              .replaceAll('&', '&amp;')
              .replaceAll('<', '&lt;')
              .replaceAll('>', '&gt;')
              .replaceAll('"', '&quot;');
      const entries = [1, 2, 3].map((i) => {
        const e = exchange(i, `${rendered}.\n${date(i)}\n${date(i)}`);
        e.request.url += '?input=' + encodeURIComponent(input);
        return e;
      });
      expect((await run(entries)).outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
    },
  );

  it('normalizes clocks beside constant text when raw request bytes are complete', async () => {
    const input = 'client-supplied-data-with-a-long-copied-message';
    const entries = [1, 2, 3].map((i) => ({
      ...exchange(i, `${input}.\n${date(i)}\n${date(i)}`),
      request: {
        method: 'POST',
        url: 'https://example.test/error',
        headers: [],
        postData: { mimeType: 'text/plain', text: 'prefix:' + input + ':suffix' },
      },
    }));
    expect((await run(entries)).outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
  });
});

it('keeps encoding ambiguity local while normalizing independent opaque variation', () => {
  const rows = ['Ab12Cd34Ef56Gh78/90', 'Zy98Xw76Vu54Ts32/10'].map((value, id) => ({
    id,
    observation: value,
    slots: slots([value]),
    inputs: [
      { value, source: 'q' },
      { value: encodeURIComponent(value), source: 'other' },
    ],
  }));
  const result = classifyCohort(rows);
  expect(new Set([...result.values()].map((r) => r.key)).size).toBe(1);
  expect([...result.values()].every((r) => r.noise && !r.reflection)).toBe(true);
});
it('keeps format families separate and requires numeric distribution even for large numbers', () => {
  expect(classifyVariance(slots(['1500000000', 'Wed, 21 Oct 2026 07:28:00 GMT']))).toBe(
    'behavioral',
  );
  expect(classifyVariance(slots(['2026-10-21T07:28:00Z', 'Wed, 21 Oct 2026 07:28:01 GMT']))).toBe(
    'behavioral',
  );
  expect(classifyVariance(slots(['1234567890123456', '1234567890123457'], 'number'))).toBe(
    'behavioral',
  );
});
it('does not bootstrap a new profile from unconfirmed reflection subsets', () => {
  const rows = cohort(['Invalid value: p0', 'Invalid value: p1'], ['p0', 'p1']);
  rows[0].inputs.push({ value: 'value', source: 'field' });
  rows[1].inputs.push({ value: 'Invalid', source: 'field' });
  const result = classifyCohort(rows);
  expect([...result.values()].every((v) => !v.reflection)).toBe(true);
  expect(new Set([...result.values()].map((v) => v.key)).size).toBe(2);
});
it('declines ambiguous subsets that match different established profiles', () => {
  const rows = cohort(
    [
      'Rejected alpha accepted fixed',
      'Rejected bravo accepted fixed',
      'Rejected fixed accepted charlie',
      'Rejected fixed accepted delta',
      'Rejected alpha accepted charlie',
    ],
    ['alpha', 'bravo', 'charlie', 'delta', 'alpha'],
  );
  rows[4].inputs.push({ value: 'charlie', source: 'other' });
  const result = classifyCohort(rows);
  expect(result.get(4)?.reflection).toBe(false);
  expect(result.get(0)?.key).toBe(result.get(1)?.key);
  expect(result.get(2)?.key).toBe(result.get(3)?.key);
});
it('bounds subset recovery without lending partial alternatives to support', () => {
  const rows = cohort(
    ['alpha ' + 'fixed '.repeat(398), 'bravo ' + 'fixed '.repeat(398), 'charlie '.repeat(399)],
    ['alpha', 'bravo', 'charlie'],
  );
  const limited: number[] = [];
  const result = classifyCohort(rows, (id) => limited.push(id));
  expect(limited).toEqual([2]);
  expect(result.get(0)?.key).toBe(result.get(1)?.key);
  expect(result.get(2)?.reflection).toBe(false);
});

it('normalizes low-cardinality numeric slots over distinct complete observations', () => {
  expect(
    classifyVariance(slots(['1', '2', '3', '4', '1', '2', '3', '4', '1', '2'], 'number')),
  ).toBe('volatile');
  expect(
    classifyVariance(
      slots([
        'state-a1',
        'state-b2',
        'state-c3',
        'state-d4',
        'state-a1',
        'state-b2',
        'state-c3',
        'state-d4',
        'state-a1',
        'state-b2',
      ]),
    ),
  ).toBe('behavioral');
});
it('normalizes a varying numeric token beside an independently volatile timestamp', () => {
  const rows = [0, 1, 2, 3].map((i) => ({
    id: i,
    observation: String(i),
    inputs: [],
    slots: slots([`timestamp=2026-11-09T10:00:0${i}Z; attempts=${i % 2}`]),
  }));
  expect(new Set([...classifyCohort(rows).values()].map((v) => v.key)).size).toBe(1);
});
