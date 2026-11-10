import { describe, expect, it } from 'vitest';
import { decomposeBody } from './response-slots.js';

describe('response decomposition', () => {
  it('separates structure from values without losing numeric precision or types', () => {
    const a = decomposeBody(
      '{"id":9007199254740993,"ok":false,"list":["a",null]}',
      'application/json',
    )!;
    const b = decomposeBody(
      '{"list":["b",null],"ok":true,"id":9007199254740995}',
      'application/json',
    )!;
    expect(a.skeleton).toBe(b.skeleton);
    expect(a.slots.map((s) => [s.type, s.value])).toEqual([
      ['number', '9007199254740993'],
      ['string', 'a'],
      ['null', 'null'],
      ['boolean', 'false'],
    ]);
    expect(a.skeleton).not.toBe(
      decomposeBody('{"id":"9007199254740993","ok":false,"list":["a",null]}', 'application/json')!
        .skeleton,
    );
  });
  it('retains array length, key spelling, and empty containers', () => {
    const bodies = ['{"a":[]}', '{"b":[]}', '{"a":{}}', '{"a":[null]}'];
    expect(
      new Set(bodies.map((t) => JSON.stringify(decomposeBody(t, 'application/json')))).size,
    ).toBe(4);
  });
  it('represents reflected single-child keys provisionally without confusing literal paths', () => {
    const a = decomposeBody('{"results":{"101":"not_found"}}', 'application/json')!;
    const b = decomposeBody('{"results":{"202":"not_found"}}', 'application/json')!;
    expect(a.skeleton).toBe(b.skeleton);
    expect(a.slots.filter((s) => s.type === 'key').map((s) => s.value)).toEqual(['results', '101']);
    expect(a.slots).not.toEqual(b.slots);
    expect(
      decomposeBody('{"results":{"101":"a","202":"b"}}', 'application/json')!
        .slots.filter((s) => s.type === 'key')
        .map((s) => s.value),
    ).toEqual(['results']);
  });
  it.each(['{"a":1,"a":2}', '{"a":', '[1,]', '{"x":"' + 'a'.repeat(9000) + '"}'])(
    'rejects complete unsupported documents: %s',
    (text) => {
      expect(decomposeBody(text, 'application/json')).toBeUndefined();
    },
  );
  it('preserves form occurrences and decoded values while canonicalizing independent field order', () => {
    const a = decomposeBody('q=a%20b&x=1&q=', 'application/x-www-form-urlencoded')!;
    const b = decomposeBody('x=2&q=c+d&q=', 'application/x-www-form-urlencoded')!;
    expect(a.skeleton).toBe(b.skeleton);
    expect(a.slots.map((s) => s.value)).toEqual(['a b', '', '1']);
    expect(a.skeleton).not.toBe(
      decomposeBody('q=a%20b&x=1', 'application/x-www-form-urlencoded')!.skeleton,
    );
  });
});
it('keeps complete text spans, including explicit empties, independent of token boundaries', () => {
  const a = decomposeBody('Rejected input: a', 'text/plain')!;
  const b = decomposeBody('', 'text/plain')!;
  expect(a.skeleton).toBe(b.skeleton);
  expect(a.slots.map((s) => s.value)).toEqual(['Rejected input: a']);
  expect(b.slots.map((s) => s.value)).toEqual(['']);
});
it('keeps oversized spans literal without publishing a partial skeleton', () => {
  expect(decomposeBody('a '.repeat(12000), 'text/plain')).toBeUndefined();
});
