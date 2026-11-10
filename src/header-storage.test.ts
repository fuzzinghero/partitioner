import { expect, it, describe } from 'vitest';
import { analyze } from './analyze.js';

describe('learned response evidence', () => {
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

  it('retains repeated captured headers within the metadata budget without losing raw evidence', async () => {
    const headers = [{ name: 'Authorization', value: 'Bearer ' + 'x'.repeat(6000) }];
    const entries = Array.from({ length: 100 }, (_, i) => ({
      ...exchange(i % 8, { message: 'Rejected' }),
      request: { method: 'GET', url: 'https://example.test/items', headers },
    }));
    const a = await analyze(capture(entries), { limits: { metadataBytes: 200 * 1024 } });
    expect(a.entries).toHaveLength(100);
    expect(a.entries[99].requestHeaders).toEqual(headers);
    expect(a.summary.metadataEstimate).toBeLessThanOrEqual(200 * 1024);
  });
});
