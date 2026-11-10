import { expect, it, vi } from 'vitest';
import { analyze } from './analyze.js';

const file = () =>
  new Blob([
    JSON.stringify({
      log: {
        entries: [
          {
            request: { method: 'GET', url: 'https://example.test/', headers: [] },
            response: {
              status: 200,
              headers: [],
              content: { mimeType: 'text/plain', text: 'abcdefgh' },
            },
          },
        ],
      },
    }),
  ]);

it('honors an exact caller file limit and allows an explicitly uncapped import', async () => {
  const capture = file();
  await expect(
    analyze(capture, undefined, undefined, { limits: { fileBytes: capture.size - 1 } }),
  ).rejects.toThrow(`${capture.size - 1}`);
  expect(
    (await analyze(capture, undefined, undefined, { limits: { fileBytes: capture.size } })).summary
      .total,
  ).toBe(1);
  expect(
    (await analyze(capture, undefined, undefined, { limits: { fileBytes: null } })).summary.total,
  ).toBe(1);
});

it('merges partial core limits with defaults and applies per-import overrides', async () => {
  const capture = file();
  expect(
    (await analyze(capture, undefined, { fileBytes: capture.size })).entries[0].body.text,
  ).toBe('abcdefgh');
  const result = await analyze(capture, undefined, { bodyBytes: 16 }, { limits: { bodyBytes: 4 } });
  expect(result.entries[0].body.state).toBe('limited');
  expect(result.entries[0].body.hash).toBeUndefined();
  expect(result.entries[0].body.reason).toContain('4 byte analysis limit');
  expect(result.summary.limits).toMatchObject({ fileBytes: null, bodyBytes: 4, entries: 100000 });
});

it.each([
  ['object', '{"response":{"content":{"text":"', '"}}}'],
  ['array', '["', '"]'],
  ['string', '"', '"'],
])(
  'rejects an excess %s entry before draining its large contents',
  async (_kind, before, after) => {
    for (const entries of [0, 1]) {
      const capture = new Blob([
        '{"log":{"entries":[',
        entries ? '{},' : '',
        before,
        'x'.repeat(1024 ** 2),
        after,
        ']}}',
      ]);
      const slice = vi.spyOn(capture, 'slice');
      await expect(analyze(capture, { limits: { entries } })).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
      });
      expect(slice).toHaveBeenCalledOnce();
    }
  },
);

it('accepts empty and exactly-at-limit captures', async () => {
  const empty = new Blob(['{"log":{"entries":[]}}']);
  expect((await analyze(empty, { limits: { entries: 0 } })).summary.total).toBe(0);
  expect((await analyze(file(), { limits: { entries: 1 } })).summary.total).toBe(1);
});

it.each([
  { entries: NaN },
  { bodyBytes: -1 },
  { metadataBytes: Infinity },
  { jsonDepth: 1.5 },
  { totalBodyBytes: null },
  { surprise: 1 },
])('rejects invalid limit configuration before reading the file: %j', async (limits) => {
  const capture = file(),
    slice = vi.spyOn(capture, 'slice');
  await expect(analyze(capture, undefined, undefined, { limits })).rejects.toThrow('limit');
  expect(slice).not.toHaveBeenCalled();
});
