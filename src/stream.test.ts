import { expect, it, describe } from 'vitest';
import { analyze } from './analyze.js';
import { LIMITS } from './types.js';
import { streamEntries } from './stream.js';

describe('streaming HAR boundaries', () => {
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

  it('rejects file, entries, nesting, structure and metadata limits', async () => {
    await expect(run([row('{}')], { fileBytes: 10 })).rejects.toThrow('byte limit');
    await expect(run([row('{}'), row('{}')], { entries: 1 })).rejects.toThrow('Entry limit');
    await expect(run([row('{}')], { jsonDepth: 3 })).rejects.toThrow('nesting');
    await expect(run([row('{}')], { jsonTokens: 2 })).rejects.toThrow('structure');
    await expect(run([row('{}')], { metadataBytes: 10 })).rejects.toThrow('metadata');
  });

  it('handles hostile HTML as inert text and rejects malformed inputs without echoing content', async () => {
    const text = '<img src="https://evil.invalid/secret"><script>alert(1)</script>';
    expect((await run([row(text, 'text/html')])).entries[0].body.text).toBe(text);
    for (const input of [
      '{"secret": invalid}',
      '{"log":{"entries": [1,]}}',
      '{"log":{"entries":[]}} trailing',
      '{"log":{"entries":[{"x":"\\q"}]}}',
      '{"log":{}}',
      '[]',
    ]) {
      await expect(analyze(new Blob([input]))).rejects.toThrow();
    }
    await expect(analyze(new Blob([new Uint8Array([255])]))).rejects.toThrow('UTF-8');
  });

  it('validates/drains oversized tokens and handles UTF-8, escaped delimiters, chunks and BOM', async () => {
    const text = '🎯\\"{}[]'.repeat(50000);
    const a = await run([row(text, 'text/plain'), row('done', 'text/plain')], { bodyBytes: 100 });
    expect(a.summary.truncated).toBe(1);
    expect(a.entries[1].body.text).toBe('done');
    const bom = new Blob([
      new Uint8Array([239, 187, 191]),
      JSON.stringify({ log: { entries: [row('{}')] } }),
    ]);
    expect((await analyze(bom)).summary.analyzed).toBe(1);
    const broken =
      '{"log":{"entries":[{"response":{"content":{"text":"' + 'x'.repeat(200000) + '\\q"}}}]}}';
    await expect(
      analyze(new Blob([broken]), undefined, { ...LIMITS, bodyBytes: 10 }),
    ).rejects.toThrow('escape');
  });

  it('tracks byte offsets for on-demand rereads without parsing the whole file', async () => {
    const file = har([row('first 🎯', 'text/plain'), row('second', 'text/plain')]);
    const a = await analyze(file);
    const e = a.entries[1];
    const wrapped = new Blob([
      '{"log":{"entries":[',
      file.slice(e.sourceStart, e.sourceEnd),
      ']}}',
    ]);
    const rows = [];
    for await (const r of streamEntries(wrapped, LIMITS)) rows.push(r);
    expect((await analyze(wrapped)).entries[0].body.text).toBe('second');
    expect(rows).toHaveLength(1);
  });
});

describe('untrusted capture boundaries', () => {
  it.each([
    '{"log":{"entries":[,]}}',
    '{"log":{"entries":[:]}}',
    '{"log/entries":[]}',
    '{"log":{"entries":[]},"log":{}}',
    '{"log":{"entries":[],"entries/*":{}}}',
  ])('validates structural keys and the full JSON grammar: %s', async (json) => {
    if (json.includes('entries/*')) {
      const result = await analyze(new Blob([json]));
      expect(result.entries).toHaveLength(0);
    } else await expect(analyze(new Blob([json]))).rejects.toThrow();
  });
});
