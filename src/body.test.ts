import { expect, it, describe } from 'vitest';
import { analyze } from './analyze.js';
import { compare } from './diff.js';
import { LIMITS } from './types.js';
import { Buffer } from 'node:buffer';
import { analyzeReport } from './core.js';

describe('captured response bodies', () => {
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

  it('distinguishes missing/empty, decodes base64, and never decompresses Content-Encoding', async () => {
    const encoded = row(btoa('{"ok":true}'));
    Object.assign(encoded.response.content, { encoding: 'base64' });
    const plain = row('{"ok":true}');
    plain.response.headers = [{ name: 'Content-Encoding', value: 'gzip' }] as never;
    const a = await run([row(), row(''), encoded, plain, row()]);
    expect(a.summary.missing).toBe(2);
    expect(a.entries[0].body.state).toBe('missing');
    expect(a.entries[1].body.text).toBe('');
    expect(a.entries[2].body.hash).toBe(a.entries[3].body.hash);
    expect(a.entries[0].outcome).toBe(a.entries[4].outcome);
    expect(a.entries[0].outcome).not.toBe(a.entries[1].outcome);
    expect(compare(a.entries[0], a.entries[1]).body.kind).toBe('unavailable');
  });
});

describe('captured response bodies', () => {
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

  it('omits oversized bodies explicitly and defers text without sacrificing hash/shape grouping', async () => {
    const a = await run([row('{"n":1}'), row('{"n":1}'), row('x'.repeat(1000), 'text/plain')], {
      bodyBytes: 128,
      totalBodyBytes: 8,
    });
    expect(a.entries[1].body.evicted).toBe(true);
    expect(a.entries[1].body.hash).toBeDefined();
    expect(a.entries[1].body.text).toBeUndefined();
    expect(a.entries[0].outcome).toBe(a.entries[1].outcome);
    expect(a.summary.deferred).toBe(2);
    expect(a.entries[2].body.state).toBe('limited');
    expect(a.summary.truncated).toBe(1);
    expect(a.entries[2].body.previewDeferred).toBe(true);
  });

  it('falls back to exact hashes for depth/node-limited JSON and handles binary/invalid encoding', async () => {
    const invalid = row('%%%');
    Object.assign(invalid.response.content, { encoding: 'base64' });
    const binary = row('AAEC', 'application/octet-stream');
    Object.assign(binary.response.content, { encoding: 'base64' });
    const a = await run([row('{"nested":{"x":1}}'), invalid, binary], { shapeDepth: 1 });
    expect(a.summary.shapeLimited).toBe(1);
    expect(a.entries[0].body.hash).toBeDefined();
    expect(a.entries[1].body.state).toBe('invalid');
    expect(a.entries[2].body.bytes).toBe(3);
    expect(a.entries[2].body.state).toBe('binary');
  });

  it('accepts base64 whitespace and does not silently replace malformed Unicode body values', async () => {
    const base64 = row('Y Q==\n', 'text/plain');
    Object.assign(base64.response.content, { encoding: 'base64' });
    const a = await run([base64, row('\ud800', 'text/plain'), row('�', 'text/plain')]);
    expect(a.entries[0].body.text).toBe('a');
    expect(a.entries[1].body.state).toBe('invalid');
    expect(a.entries[1].body.hash).toBeUndefined();
    expect(a.entries[2].body.hash).toBeDefined();
  });

  it('keeps bounded oversized text previews separate from body identity and diff data', async () => {
    const prefix = '<script>never execute</script>🎯\\"';
    const a = await run(
      [row(prefix + 'a'.repeat(2000), 'text/html'), row(prefix + 'b'.repeat(2000), 'text/html')],
      { bodyBytes: 128, totalBodyBytes: 3000 },
    );
    expect(a.entries[0].body.preview).toContain(prefix);
    expect(a.entries[0].body.hash).toBeUndefined();
    expect(a.entries[0].body.text).toBeUndefined();
    expect(a.entries[0].body.reason).toContain('analysis limit');
    expect(a.entries[0].outcome).not.toBe(a.entries[1].outcome);
    expect(compare(a.entries[0], a.entries[1]).body.kind).toBe('unavailable');
    expect(a.summary.retainedBytes).toBeLessThanOrEqual(3000);
    expect(a.entries[1].body.previewDeferred).toBe(true);
  });
});

describe('public API body evidence', () => {
  const capture = (entries: unknown[]) => new Blob([JSON.stringify({ log: { entries } })]);

  const row = (text = 'ok', mimeType = 'text/plain', request = {}) => ({
    request: { method: 'POST', url: 'https://example.test/items', headers: [], ...request },
    response: { status: 200, headers: [], content: { mimeType, text } },
  });

  it('marks an oversized binary response as truncated without inventing a text preview', async () => {
    const entry = row(Buffer.from('oversized').toString('base64'), 'application/octet-stream');
    const report = await analyzeReport(
      capture([
        {
          ...entry,
          response: {
            ...entry.response,
            content: { ...entry.response.content, encoding: 'base64' },
          },
        },
      ]),
      { limits: { bodyBytes: 4 } },
    );
    expect(report.contexts[0].partitions[0].sample?.response.body).toMatchObject({
      state: 'limited',
      truncated: true,
    });
  });
});

describe('automatic response normalization', () => {
  const capture = (rows: unknown[]) => new Blob([JSON.stringify({ log: { entries: rows } })]);

  const row = (mime: string, text: string, headers: { name: string; value: string }[] = []) => ({
    request: { method: 'GET', url: 'https://example.test/result', headers: [] },
    response: { status: 400, headers, content: { mimeType: mime, text } },
  });

  const groups = async (rows: unknown[]) =>
    (await analyze(capture(rows))).outcomes.map((g) => g.members);

  it.each(['text/plain', ''])('canonicalizes strict JSON under generic MIME %j', async (mime) => {
    const rows = ['{"a":1,"b":2}', '{"b":2,"a":1}'].map((text) => row(mime, text));
    expect(await groups(rows)).toEqual([[0, 1]]);
    const report = await analyzeReport(capture(rows));
    expect(report.contexts[0].partitions[0].sample?.response.body.text).toBe(
      rows[0].response.content.text,
    );
  });

  it('preserves declared MIME, duplicates, numeric spellings and explicit binary types', async () => {
    for (const rows of [
      [row('text/plain', '{"a":1}'), row('application/json', '{"a":1}')],
      ['{"a":1,"a":2}', '{"a":2}'].map((text) => row('text/plain', text)),
      ['{"a":1}', '{"a":1.0}'].map((text) => row('text/plain', text)),
      ['{"a":1,"b":2}', '{"b":2,"a":1}'].map((text) => row('application/octet-stream', text)),
      ['{"a":1,"b":2}', '{"b":2,"a":1}'].map((text) => row('application/javascript', text)),
    ])
      expect(await groups(rows)).toEqual([[0], [1]]);
  });
});

it.each(['utf-8', 'utf-8-display', 'escaped', 'base64-display'])(
  'preserves exporter display encoding through streamed response analysis: %s',
  async (encoding) => {
    const entries = [0, 1].map(() => ({
      request: { method: 'GET', url: 'https://example.test/', headers: [] },
      response: {
        status: 200,
        headers: [],
        content: {
          mimeType: 'application/json',
          text: '{"ok":true}',
          _displayEncoding: encoding,
        },
      },
    }));
    const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
    const supported = encoding === 'utf-8' || encoding === 'utf-8-display';
    expect(result.outcomes.length).toBe(supported ? 1 : 2);
    expect(result.entries[0].body.state).toBe(supported ? 'text' : 'invalid');
  },
);
it('keeps binary response bytes significant when a media parameter looks like a JSON suffix', async () => {
  const entries = ['{"a":1,"b":2}', '{ "b":2, "a":1 }'].map((text) => ({
    request: { method: 'GET', url: 'https://example.test/', headers: [] },
    response: {
      status: 200,
      headers: [],
      content: { mimeType: 'application/octet-stream; arbitrary=example+json', text },
    },
  }));
  const result = await analyze(new Blob([JSON.stringify({ log: { entries } })]));
  expect(result.entries.map((e) => e.body.state)).toEqual(['binary', 'binary']);
  expect(result.outcomes).toHaveLength(2);
});
