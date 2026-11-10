// @vitest-environment node
import { expect, it, vi, describe } from 'vitest';
import { analyze, groupPage, memberPage } from './analyze.js';
import { compare } from './diff.js';
import { LIMITS } from './types.js';
import type { GroupPageCache } from './analyze.js';
import { requestChanges } from './request-analysis.js';

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

describe('streaming HAR analysis and transparent grouping', () => {
  it('groups supported endpoint families and value-aware JSON without erasing source values', async () => {
    const a = await run([
      row('{"n":1,"a":[true]}'),
      row('{"a":[false],"n":2}'),
      row('{"n":"2","a":[true]}'),
      row('{}', 'application/json', 403),
      row('{}', 'application/json', 200, 'https://sample.invalid/api/2'),
    ]);
    expect(a.summary.analyzed).toBe(5);
    expect(a.endpoints).toHaveLength(1);
    expect(a.outcomes).toHaveLength(5);
    expect(a.entries[0].body.hash).not.toBe(a.entries[1].body.hash);
    expect(compare(a.entries[0], a.entries[1]).body.changes.map((c) => c.path)).toEqual([
      '/n',
      '/a/0',
    ]);
  });
  it('keeps all members and bounds pages', async () => {
    const a = await run(Array.from({ length: 120 }, () => row('{}')));
    expect(a.endpoints[0].members).toHaveLength(120);
    expect(memberPage(a, a.endpoints[0].id, 'endpoints', 0, '', '').rows).toHaveLength(50);
    expect(memberPage(a, a.endpoints[0].id, 'endpoints', 2, '', '').rows).toHaveLength(20);
    expect(groupPage(a, 'endpoints', 0, '/api/1').total).toBe(1);
    expect(memberPage(a, a.endpoints[0].id, 'endpoints', 0, '120', '200').rows[0].id).toBe(119);
  });
});

describe('group page caching', () => {
  const capture = (count: number, start = 0) =>
    new Blob([
      JSON.stringify({
        log: {
          entries: Array.from({ length: count }, (_, id) => ({
            request: {
              method: 'GET',
              url: `https://example.test/items/${id + start}`,
              headers: [],
            },
            response: {
              status: id % 2 ? 404 : 200,
              headers: [],
              content: { mimeType: 'text/plain', text: `body-${id + start}` },
            },
          })),
        },
      }),
    ]);

  it('reuses only the last matching group query and resets on a different capture', async () => {
    const a = await analyze(capture(23));
    const cache: GroupPageCache = {};
    const filter = vi.spyOn(a.outcomes, 'filter');
    const expected0 = groupPage(a, 'outcomes', 0, '', undefined, '', 5);
    const expected1 = groupPage(a, 'outcomes', 1, '', undefined, '', 5);
    filter.mockClear();
    expect(groupPage(a, 'outcomes', 0, '', undefined, '', 5, cache)).toEqual(expected0);
    expect(groupPage(a, 'outcomes', 1, '', undefined, '', 5, cache)).toEqual(expected1);
    expect(filter).toHaveBeenCalledTimes(1);
    expect(groupPage(a, 'outcomes', 0, '', undefined, '404', 5, cache)).toEqual(
      groupPage(a, 'outcomes', 0, '', undefined, '404', 5),
    );
    expect(groupPage(a, 'outcomes', 0, 'items/1', undefined, '', 5, cache)).toEqual(
      groupPage(a, 'outcomes', 0, 'items/1', undefined, '', 5),
    );
    const b = await analyze(capture(3, 100));
    expect(groupPage(b, 'outcomes', 0, '', undefined, '', 5, cache)).toEqual(
      groupPage(b, 'outcomes', 0, '', undefined, '', 5),
    );
    expect(cache.analysis).toBe(b);
  });
});

describe('analysis API', () => {
  const capture = (count = 1) =>
    new Blob([
      JSON.stringify({
        log: {
          entries: Array.from({ length: count }, (_, id) => ({
            request: { method: 'GET', url: `https://example.test/items?q=${id}`, headers: [] },
            response: {
              status: 200,
              headers: [],
              content: {
                mimeType: 'application/json',
                text: JSON.stringify({ id, state: String.fromCodePoint(97 + id) }),
              },
            },
          })),
        },
      }),
    ]);

  it('accepts a single options object and reports structured progress without changing legacy calls', async () => {
    const progress: { done: number; total: number; entries: number }[] = [];
    const file = capture(3);
    const result = await analyze(file, {
      limits: { totalBodyBytes: 0 },
      contexts: [[0, 2]],
      onProgress: (value) => progress.push(value),
    });
    expect(result.entries[0].body.evicted).toBe(true);
    expect(result.entries[0].endpoint).toBe(result.entries[2].endpoint);
    expect(progress.at(-1)).toMatchObject({ done: file.size, total: file.size, entries: 3 });
    expect((await analyze(file, undefined, { entries: 3 })).entries).toHaveLength(3);
  });

  it('rejects an already aborted analysis before reading its source', async () => {
    const file = capture();
    const read = vi.spyOn(file, 'slice');
    const controller = new AbortController();
    controller.abort(new Error('private abort reason'));
    await expect(analyze(file, { signal: controller.signal })).rejects.toMatchObject({
      code: 'ABORTED',
      message: 'Analysis was cancelled.',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('can stop while draining a large ignored HAR field without accepting a partial capture', async () => {
    const file = new Blob(['{"ignored":"', 'x'.repeat(1024 * 1024), '","log":{"entries":[]}}']);
    const controller = new AbortController();
    await expect(
      analyze(file, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.done > 0) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('supports bounded custom page sizes and anchors for both partitions and members', async () => {
    const result = await analyze(capture(60));
    const groups = groupPage(result, 'outcomes', 1, '', undefined, '', 7);
    expect(groups).toMatchObject({ total: 60, page: 1, pageSize: 7 });
    expect(groups.rows.map((group) => group.representative)).toEqual([7, 8, 9, 10, 11, 12, 13]);
    const members = memberPage(
      result,
      result.endpoints[0].id,
      'endpoints',
      0,
      '',
      '',
      20,
      undefined,
      7,
    );
    expect(members).toMatchObject({ page: 2, pageSize: 7 });
    expect(members.rows.map((entry) => entry.id)).toEqual([14, 15, 16, 17, 18, 19, 20]);
    expect(() => groupPage(result, 'outcomes', 0, '', undefined, '', 0)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });

  it('distinguishes malformed captures, exhausted budgets and invalid configuration by error code', async () => {
    await expect(analyze(new Blob(['{bad']))).rejects.toMatchObject({ code: 'INVALID_HAR' });
    await expect(analyze(capture(), { limits: { entries: 0 } })).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
    await expect(analyze(capture(), { limits: { bodyBytes: -1 } })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
  });

  it('sanitizes unexpected progress callback failures at the core error boundary', async () => {
    await expect(
      analyze(capture(), {
        onProgress: () => {
          throw new Error('capture_secret');
        },
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', message: 'Analysis failed safely.' });
  });

  it('keeps method-specific row labels while reporting a mixed-method context', async () => {
    const source = JSON.parse(await capture(3).text());
    source.log.entries[1].request.method = 'POST';
    const result = await analyze(new Blob([JSON.stringify(source)]));
    expect(
      groupPage(result, 'outcomes', 0, '', undefined, '', 3).rows.map((row) => [
        row.method,
        row.scopeMethod,
      ]),
    ).toEqual([
      ['GET', undefined],
      ['POST', undefined],
      ['GET', undefined],
    ]);
    const uniform = await analyze(capture(3));
    expect(
      groupPage(uniform, 'outcomes', 0, '', undefined, '', 3).rows.map((row) => row.scopeMethod),
    ).toEqual(['GET', 'GET', 'GET']);
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

  it('counts entries with oversized bodies and preserves response grouping when only requests are oversized', async () => {
    const result = await analyze(
      capture([row('ok', 'text/plain', 'large request'), row('ok', 'text/plain')]),
      {
        limits: { bodyBytes: 4 },
      },
    );
    expect(result.summary.truncated).toBe(1);
    expect(result.outcomes).toHaveLength(1);
    expect(result.summary.warnings).toContain(
      '1 entry has request or response bodies exceeding the analysis limit. Responses with oversized bodies are placed in separate partitions because their bodies cannot be compared.',
    );
  });

  it('keeps oversized response bodies in separate partitions and counts each affected entry once', async () => {
    const result = await analyze(
      capture([row('12345', 'text/plain', '12345'), row('12345', 'text/plain')]),
      { limits: { bodyBytes: 4 } },
    );
    expect(result.summary.truncated).toBe(2);
    expect(result.outcomes).toHaveLength(2);
    expect(result.summary.warnings).toContain(
      '2 entries have request or response bodies exceeding the analysis limit. Responses with oversized bodies are placed in separate partitions because their bodies cannot be compared.',
    );
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

  it('accepts explicit context associations for host/URI mutations without requiring a baseline', async () => {
    const rows = [
      'https://one.test/items?q=a',
      'https://two.test/changed?q=b',
      'Provided context 1',
    ].map((url) => {
      const row = exchange();
      row.request.url = url;
      return row;
    });
    expect((await analyze(capture(rows))).endpoints).toHaveLength(3);
    const associated = await analyze(capture(rows), undefined, undefined, { contexts: [[0, 1]] });
    expect(associated.endpoints).toHaveLength(2);
    expect(associated.endpoints[0].members).toEqual([0, 1]);
    expect(requestChanges(associated, 1).contrasts?.[0]).toMatchObject({
      reference: 0,
      comparison: 1,
      responseChanged: false,
    });
    expect(
      requestChanges(associated, 1).current?.changes.some(
        (c) => c.kind === 'Path' && c.observed?.includes('two.test/changed'),
      ),
    ).toBe(true);
  });

  it('honors explicit contexts for skipped source entries without merging separate groups', async () => {
    const result = await analyze(capture([null, exchange(), null, null]), {
      contexts: [[0, 1], [2]],
    });
    expect(result.summary).toMatchObject({ total: 4, analyzed: 1, skipped: 3 });
    expect(
      result.endpoints.map((group) => ({ label: group.label, members: group.members })),
    ).toEqual([
      { label: 'Provided context 1', members: [0, 1] },
      { label: 'Provided context 2', members: [2] },
      { label: 'Skipped entries', members: [3] },
    ]);
    expect(result.entries[0].skipped).toBeTruthy();
    expect(result.entries[0].outcome).not.toBe(result.entries[1].outcome);
  });

  it.each([{ contexts: [[0], [0]] }, { contexts: [[2]] }])(
    'rejects ambiguous or nonexistent explicit context members: %j',
    async ({ contexts }) => {
      await expect(
        analyze(capture([exchange()]), undefined, undefined, { contexts }),
      ).rejects.toThrow('context');
    },
  );
});

it('keeps repeated-reflection buckets stable across order, methods, retention and response formats', async () => {
  const formats = [
    {
      mime: 'application/json',
      body: (v: string, message: string) =>
        JSON.stringify({ detail: `${v} ${message}`, causes: [{ key: v }] }),
    },
    { mime: 'text/plain', body: (v: string, message: string) => `${v} ${message}\n${v}` },
    {
      mime: 'text/html',
      body: (v: string, message: string) => `<p>${v} ${message}</p><p>${v}</p>`,
    },
    {
      mime: 'application/xml',
      body: (v: string, message: string) =>
        `<r><detail>${v} ${message}</detail><key>${v}</key></r>`,
    },
    {
      mime: 'application/x-www-form-urlencoded',
      body: (v: string, message: string) =>
        `detail=${encodeURIComponent(v + ' ' + message)}&key=${v}`,
    },
    {
      mime: 'multipart/form-data; boundary=x',
      body: (v: string, message: string) =>
        `--x\r\nContent-Disposition: form-data; name="detail"\r\n\r\n${v} ${message}\r\n--x\r\nContent-Disposition: form-data; name="key"\r\n\r\n${v}\r\n--x--\r\n`,
    },
  ];
  for (const { mime, body } of formats) {
    const entries = ['is invalid', 'is accepted'].flatMap((message) =>
      ['OPTIONS', 'TRACE', 'PUT', 'DELETE'].map((method, i) => {
        const value = 'payload-' + i;
        const entry = row(body(value, message), mime, 400, `https://example.test/echo?q=${value}`);
        entry.request.method = method;
        return entry;
      }),
    );
    for (const order of [
      entries,
      [...entries].reverse(),
      entries.filter((_, i) => i % 2).concat(entries.filter((_, i) => !(i % 2))),
    ]) {
      for (const retained of [0, LIMITS.totalBodyBytes]) {
        const result = await run(order, { totalBodyBytes: retained });
        expect(result.outcomes.map((g) => g.members.length).sort(), mime).toEqual([4, 4]);
        for (const group of result.outcomes) {
          const messages = group.members.map((id) => order[id].response.content.text as string);
          expect(
            messages.every((text) => text.includes('accepted')) ||
              messages.every((text) => !text.includes('accepted')),
            mime,
          ).toBe(true);
        }
      }
    }
  }
});
