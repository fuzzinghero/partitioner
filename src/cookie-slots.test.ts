import { expect, it } from 'vitest';
import { analyze } from './analyze.js';
import { decomposeCookie } from './cookie-slots.js';
const clock = Date.parse('2026-11-09T16:00:00Z');
it('separates deletion, live cookies and unknown expiry state', () => {
  const deleted = decomposeCookie('sid=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT', undefined)!;
  expect(deleted.skeleton).toContain('deleted');
  expect(decomposeCookie('sid=x; Max-Age=0', clock)!.skeleton).toContain('deleted');
  expect(decomposeCookie('sid=x; Max-Age=3600; Secure', clock)!.skeleton).not.toContain('deleted');
  expect(
    decomposeCookie('sid=x; Expires=Mon, 09 Nov 2026 15:00:00 GMT', undefined)!.slots,
  ).toHaveLength(1);
});
it.each([false, true])(
  'groups live cookie expiry with server Date present=%s while retaining policy and deletion',
  async (date) => {
    const entries = Array.from({ length: 4 }, (_, i) => ({
      startedDateTime: new Date(clock + i * 1000).toISOString(),
      request: { method: 'POST', url: 'https://example.test/?q=' + i, headers: [] },
      response: {
        status: 422,
        headers: [
          ...(date ? [{ name: 'Date', value: new Date(clock + i * 1000).toUTCString() }] : []),
          {
            name: 'Set-Cookie',
            value:
              'sid=fixed; Path=/; Secure; Expires=' +
              new Date(clock + 3600000 + i * 1000 + (i % 2) * 1000).toUTCString(),
          },
        ],
        content: { mimeType: 'application/json', text: '{"error":"Invalid coupon"}' },
      },
    }));
    expect((await analyze(new Blob([JSON.stringify({ log: { entries } })]))).outcomes).toHaveLength(
      1,
    );
    const variants = [
      {
        ...entries[0],
        response: {
          ...entries[0].response,
          headers: [{ name: 'Set-Cookie', value: 'sid=fixed; Path=/; Secure; Max-Age=0' }],
        },
      },
      {
        ...entries[0],
        response: {
          ...entries[0].response,
          headers: [{ name: 'Set-Cookie', value: 'sid=fixed; Path=/; Secure; Max-Age=7200' }],
        },
      },
    ];
    expect(
      (await analyze(new Blob([JSON.stringify({ log: { entries: [...entries, ...variants] } })])))
        .outcomes,
    ).toHaveLength(3);
  },
);
it.each([
  'sid=x; Secure; Secure',
  'sid=x; Path=/; Path=/two',
  'sid="quoted"; Path=/',
  'sid=x\r\nOther: injected',
  'sid=x; Expires=invalid',
  'sid=x; Max-Age=oops',
  'sid=x; Expires=Tue, 09 Nov 2026 16:00:00 GMT',
])('retains unsupported cookie %s', (value) => {
  expect(decomposeCookie(value, clock)).toBeUndefined();
});
