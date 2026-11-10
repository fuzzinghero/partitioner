// @vitest-environment node
import { expect, it, describe } from 'vitest';
import {
  analyze,
  requestChanges,
  requestChangesComplete,
  analyzeEntry,
  LIMITS,
  compare,
  groupPage,
  memberPage,
} from './core.js';
import type { Body, Entry, Analysis } from './index.js';

const capture = (entries: unknown[]) => new Blob([JSON.stringify({ log: { entries } })]);
const row = (text = 'ok', mimeType = 'text/plain', request = {}) => ({
  request: { method: 'POST', url: 'https://example.test/items', headers: [], ...request },
  response: { status: 200, headers: [], content: { mimeType, text } },
});

it('rejects invalid selection IDs in both request-change APIs while retaining valid queries', async () => {
  const analysis = await analyze(capture([row()]));
  for (const id of [-1, 99, NaN, 0.5, Infinity]) {
    expect(() => requestChanges(analysis, id)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    await expect(requestChangesComplete(analysis, id)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  }
  expect(requestChanges(analysis, 0).current?.entry).toBe(0);
  expect((await requestChangesComplete(analysis, 0)).current?.entry).toBe(0);
});

describe('public core handles', () => {
  function checkPublicTypes(body: Body, entry: Entry, analysis: Analysis) {
    // @ts-expect-error Internal fingerprints are not part of the public body type.
    void body.hash;
    // @ts-expect-error Internal request indexes are not part of the public analysis type.
    void analysis.requestIndex;
    // @ts-expect-error Internal fingerprints are not part of the public entry type.
    void entry.requestHeadersHash;
  }

  void checkPublicTypes;

  it('returns usable bounded core handles without exposing internal fingerprints', async () => {
    const rows = ['a', 'b'].map((value) => ({
      request: {
        method: 'POST',
        url: 'https://example.test/',
        headers: [],
        postData: { mimeType: 'text/plain', text: value },
      },
      response: {
        status: 200,
        headers: [],
        content: { mimeType: 'application/json', text: JSON.stringify({ value }) },
      },
    }));
    const result = await analyze(new Blob([JSON.stringify({ log: { entries: rows } })]));
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/[a-f0-9]{64}/);
    expect(json).not.toContain('requestIndex');
    expect(result.entries[0].body.text).toBe('{"value":"a"}');
    expect(groupPage(result, 'outcomes', 0, '').total).toBe(2);
    expect(memberPage(result, result.endpoints[0].id, 'endpoints', 0, '', '').total).toBe(2);
    expect(compare(result.entries[0], result.entries[1]).body.changes).toContainEqual({
      path: '/value',
      kind: 'changed',
      reference: '"a"',
      comparison: '"b"',
    });
    expect(requestChanges(result, 1).contrasts?.[0].changes).toContainEqual(
      expect.objectContaining({ kind: 'Body', key: 'Content', reference: 'a', observed: 'b' }),
    );
    expect(await requestChangesComplete(result, 1)).toEqual(requestChanges(result, 1));
    result.entries[0].requestHeaders.push({ name: 'X-Fake', value: 'changed' });
    result.endpoints[0].members.length = 0;
    expect(groupPage(result, 'endpoints', 0, '').total).toBe(1);
    expect(memberPage(result, result.endpoints[0].id, 'endpoints', 0, '', '').total).toBe(2);
    expect(JSON.stringify(requestChanges(result, 1))).not.toContain('x-fake');
    for (const detached of [structuredClone(result), JSON.parse(json), { ...result }]) {
      expect(() => groupPage(detached, 'outcomes', 0, '')).toThrow('original result');
      expect(() => requestChanges(detached, 0)).toThrow('original result');
      await expect(requestChangesComplete(detached, 0)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    }
    for (const detached of [
      structuredClone(result.entries[0]),
      JSON.parse(JSON.stringify(result.entries[0])),
      { ...result.entries[0] },
    ])
      expect(() => compare(detached, result.entries[1])).toThrow('original entry');
  });

  it('omits internal outcome identities from standalone analyzed entries while keeping comparisons usable', async () => {
    const input = (text: string, mimeType: string) => ({
      request: { method: 'GET', url: 'https://example.test/', headers: [] },
      response: { status: 200, headers: [], content: { mimeType, text } },
    });
    const first = await analyzeEntry(input('hello', 'text/plain'), 0, LIMITS, {
      bytes: 0,
      nodes: 0,
    });
    const second = await analyzeEntry(input('world', 'text/plain'), 1, LIMITS, {
      bytes: 0,
      nodes: 0,
    });
    const json = await analyzeEntry(input('{"hello":"world"}', 'application/json'), 2, LIMITS, {
      bytes: 0,
      nodes: 0,
    });
    for (const result of [first, second, json]) {
      expect(result.outcome).toMatch(/^unpartitioned-\d+$/);
      expect(JSON.stringify(result)).not.toMatch(/[a-f0-9]{64}/);
    }
    expect(compare(first, second).body.kind).not.toBe('unavailable');
  });

  it('does not pass caller-supplied cache objects into internal grouping', async () => {
    const result = await analyze(
      new Blob([
        JSON.stringify({
          log: {
            entries: [
              {
                request: { method: 'GET', url: 'https://example.test/', headers: [] },
                response: { status: 200, content: { mimeType: 'text/plain', text: 'ok' } },
              },
            ],
          },
        }),
      ]),
    );
    const cache = {};
    const expected = groupPage(result, 'outcomes', 0, '');
    expect(
      Reflect.apply(groupPage, undefined, [result, 'outcomes', 0, '', undefined, '', 50, cache]),
    ).toEqual(expected);
    expect(cache).toEqual({});
    expect(groupPage(result, 'outcomes', 0, '')).toEqual(expected);
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

  it('keeps compatibility fingerprints private while preserving usable reflected core handles', async () => {
    const input = capture(
      values.map((v) => row(v, 'application/json', JSON.stringify({ echo: v, error: 'invalid' }))),
    );
    const result = await analyze(input);
    expect(result.outcomes.map((g) => g.members)).toEqual([[0, 1, 2]]);
    expect(Object.hasOwn(result.entries[0].body, 'hash')).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/[a-f0-9]{64}/);
  });
});

it('keeps normalization evidence isolated from mutations to public group pages', async () => {
  const result = await analyze(
    capture([row('{"ok":true}', 'text/plain'), row('{ "ok":true }', 'text/plain')]),
  );
  const page = groupPage(result, 'outcomes', 0, '');
  expect(page.rows[0].normalizations).toEqual(['detected-json']);
  page.rows[0].normalizations!.length = 0;
  expect(groupPage(result, 'outcomes', 0, '').rows[0].normalizations).toEqual(['detected-json']);
});
