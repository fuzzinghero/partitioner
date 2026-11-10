import { expect, it, describe } from 'vitest';
import { analyze } from './analyze.js';
import { compare, diffJson, diffText } from './diff.js';
import { LIMITS } from './types.js';

describe('bounded pairwise comparisons', () => {
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

  it('detects additions, removals, null/type differences, array positions and escaped JSON paths', () => {
    const result = diffJson(
      { 'a/b': null, arr: [1, 2], removed: true },
      { 'a/b': {}, arr: [2], added: false },
    );
    expect(result.changes.map((c) => c.path)).toEqual([
      '/a~1b',
      '/arr/0',
      '/arr/1',
      '/removed',
      '/added',
    ]);
  });

  it('never hides numeric precision, duplicate keys, or formatting differences', async () => {
    const a = await run([
      row('{"n":9007199254740992,"other":1}'),
      row('{"n":9007199254740993,"other":2}'),
      row('{"n":1,"n":2,"other":1}'),
      row('{"n":2,"other":2}'),
      row('{"n":0.100000000000000005}'),
      row('{"n":0.1}'),
    ]);
    expect(compare(a.entries[0], a.entries[1]).body.changes.map((c) => c.path)).toEqual([
      '/n',
      '/other',
    ]);
    expect(compare(a.entries[2], a.entries[3]).body.kind).toBe('text');
    expect(compare(a.entries[4], a.entries[5]).body.changes[0].reference).toBe(
      '0.100000000000000005',
    );
  });

  it('shows exact equality and explicit text, binary and size-budget states', async () => {
    const a = await run([
      row('same', 'text/plain'),
      row('same', 'text/plain'),
      row('other', 'text/plain'),
      row('abc', 'application/octet-stream'),
      row('def', 'application/octet-stream'),
      row('x'.repeat(70000), 'text/plain'),
    ]);
    expect(compare(a.entries[0], a.entries[1]).body.kind).toBe('exact');
    expect(compare(a.entries[0], a.entries[2]).body.kind).toBe('text');
    expect(compare(a.entries[3], a.entries[4]).body.kind).toBe('binary');
    expect(compare(a.entries[0], a.entries[5]).body.limited).toBe(true);
  });

  it('bounds line/structural/change work and labels excerpts', () => {
    expect(diffText('x\n'.repeat(401), 'y').limited).toBe(true);
    expect(
      diffJson(
        Array.from({ length: 300 }, () => 1),
        Array.from({ length: 300 }, () => 2),
      ).limited,
    ).toBe(true);
    expect(diffText('x'.repeat(2000), 'y').changes[0].reference).toContain('[excerpt]');
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

  it('keeps JSON value types distinguishable in response comparisons', async () => {
    const result = await analyze(
      capture([
        row('{"value":"true","other":"null","amount":"123"}'),
        row('{"value":true,"other":null,"amount":123}'),
      ]),
    );
    expect(compare(result.entries[0], result.entries[1]).body.changes).toEqual([
      { path: '/value', kind: 'changed', reference: '"true"', comparison: 'true' },
      { path: '/other', kind: 'changed', reference: '"null"', comparison: 'null' },
      { path: '/amount', kind: 'changed', reference: '"123"', comparison: '123' },
    ]);
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

  it('preserves a retained BOM and safely describes a diff of evicted text', async () => {
    const result = await analyze(
      capture([exchange('\uFEFFhello', 'text/plain'), exchange('world', 'text/plain')]),
      undefined,
      { ...LIMITS, totalBodyBytes: 8 },
    );
    expect(result.entries[0].body.text).toBe('\uFEFFhello');
    expect(compare(result.entries[0], result.entries[1]).body.kind).toBe('unavailable');
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
    ['transport errors', { _error: 'reset' }, { _error: 'timeout' }, 'transportError'],
    ['header capture', { headers: undefined }, { headers: [] }, 'responseHeadersAvailable'],
    ['rejected transport errors', { _error: 7 }, { _error: 8 }, 'transportError'],
    ['invalid headers', { headers: {} }, { headers: {} }, 'responseHeadersAvailable'],
    ['invalid statuses', { status: -1 }, { status: 1000 }, 'status'],
  ])(
    'explains hard partition boundaries in pairwise comparisons: %s',
    async (_label, before, after, path) => {
      const rows = [before, after].map((fields) => {
        const row = exchange();
        return { ...row, response: { ...row.response, ...(fields as object) } };
      });
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((group) => group.members)).toEqual([[0], [1]]);
      const compared = compare(result.entries[0], result.entries[1]);
      expect(compared.body.kind).toBe('exact');
      expect(compared.metadata).toEqual(
        expect.arrayContaining([expect.objectContaining({ path, kind: 'changed' })]),
      );
      expect(compared.metadata.find((change) => change.path === path)?.reference).not.toBe(
        compared.metadata.find((change) => change.path === path)?.comparison,
      );
      expect(compare(result.entries[0], result.entries[0]).metadata).toEqual([]);
    },
  );

  it('compares recorded request and response protocol versions and status text independently of body identity', async () => {
    const row = exchange();
    const baseline = {
      ...row,
      request: { ...row.request, httpVersion: 'HTTP/1.1' },
      response: { ...row.response, httpVersion: 'HTTP/1.1', statusText: 'OK' },
    };
    const rows = [
      baseline,
      { ...baseline, request: { ...baseline.request, httpVersion: 'HTTP/3' } },
      { ...baseline, response: { ...baseline.response, httpVersion: 'HTTP/2' } },
      { ...baseline, response: { ...baseline.response, statusText: 'Custom status text' } },
    ];
    const result = await analyze(capture(rows));
    for (const [id, path] of [
      [1, 'requestHttpVersion'],
      [2, 'responseHttpVersion'],
      [3, 'statusText'],
    ] as const) {
      const comparison = compare(result.entries[0], result.entries[id]);
      expect(comparison.metadata.map((change) => change.path)).toEqual([path]);
      expect(comparison.metadata[0].reference).not.toBe(comparison.metadata[0].comparison);
      expect(comparison.body.kind).toBe('exact');
    }
    expect(compare(result.entries[0], result.entries[0]).metadata).toEqual([]);
  });
});
