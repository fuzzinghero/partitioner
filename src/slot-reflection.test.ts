import { expect, it } from 'vitest';
import { reflectSlot, selectReflection } from './slot-reflection.js';
const input = (value: string, source = 'query:q') => ({ value, source });
const reflect = (text: string, values: ReturnType<typeof input>[]) => {
  let work = 0;
  return reflectSlot(text, values, (n) => (work += n) <= 1024 * 1024);
};
it('matches complete inputs with shared prefixes before discovering templates', () => {
  const a = reflect("Invalid value: 'admin1'", [input('admin1')])!;
  const b = reflect("Invalid value: 'admin2'", [input('admin2', 'query:sort')])!;
  expect(a.parts).toEqual(["Invalid value: '", { reflected: 0, encoding: 'literal' }, "'"]);
  expect(a.parts).toEqual(b.parts);
  expect(a.values).toEqual(['admin1']);
});
it('preserves repeated-input relationships across multiple spans', () => {
  const a = reflect('alpha1234 invalid; key=alpha1234', [input('alpha1234')])!;
  expect(a.parts.filter((p) => typeof p !== 'string')).toEqual([
    { reflected: 0, encoding: 'literal' },
    { reflected: 0, encoding: 'literal' },
  ]);
  const b = reflect('alpha1234 invalid; key=bravo5678', [
    input('alpha1234'),
    input('bravo5678', 'query:other'),
  ])!;
  expect(b.parts).not.toEqual(a.parts);
});
it('matches short words at token boundaries and never generates an empty substring proposal', () => {
  expect(reflect('Invalid value: a', [input('a')])!.parts).toEqual([
    'Invalid value: ',
    { reflected: 0, encoding: 'literal' },
    '',
  ]);
  expect(reflect('Database unavailable', [input('a')])).toBeUndefined();
  expect(reflect("Invalid value: ''", [input('')])).toBeUndefined();
});
it('keeps encoded output distinct and respects exhausted work', () => {
  expect(reflect('Invalid: a%20b', [input('a b')])!.parts).toContainEqual({
    reflected: 0,
    encoding: 'url',
  });
  expect(reflectSlot('Invalid: alpha1234', [input('alpha1234')], () => false)).toBeUndefined();
});
it.each([
  ['admin is invalid', true],
  ['Rejected admin today', true],
  ['xadmin is invalid', false],
  ['adminx is invalid', false],
  ['𐐀admin is invalid', false],
  ['admin𐐀 is invalid', false],
  ["Rejected 'admin' today", true],
] as const)('matches actual short inputs at Unicode token boundaries: %s', (text, matched) => {
  expect(Boolean(reflectSlot(text, [{ value: 'admin', source: 'query' }], () => true))).toBe(
    matched,
  );
});
it('prefers the complete longer input when candidates start at the same offset', () => {
  const p = reflect('Rejected: foo-bar', [input('foo', 'prefix'), input('foo-bar', 'id')])!;
  expect(p.parts).toEqual(['Rejected: ', { reflected: 0, encoding: 'literal' }, '']);
  expect(p.values).toEqual(['foo-bar']);
});
it('keeps ambiguity local to one candidate representation', () => {
  const p = reflect('Rejected: distinct-payload', [
    input('a b'),
    input('a%20b'),
    input('distinct-payload'),
  ])!;
  expect(p.values).toEqual(['distinct-payload']);
  expect(reflect('Rejected: a%20b', [input('a b'), input('a%20b')])).toBeUndefined();
});

it('rebuilds selected spans at original Unicode offsets with compact repeated aliases', () => {
  const text = '🧪 Rejected alpha; 14ms; alpha';
  const template = reflectSlot(
    text,
    [
      { value: 'alpha', source: 'q' },
      { value: '14', source: 'limit' },
    ],
    () => true,
  )!;
  const selected = selectReflection(
    text,
    template,
    (span) => text.slice(span.start, span.end) !== '14',
  )!;
  expect(selected.parts).toEqual([
    '🧪 Rejected ',
    { reflected: 0, encoding: 'literal' },
    '; 14ms; ',
    { reflected: 0, encoding: 'literal' },
    '',
  ]);
  expect(selected.values).toEqual(['alpha']);
  expect(selected.sources).toEqual([['q']]);
  expect(selected.spans.map((span) => text.slice(span.start, span.end))).toEqual([
    'alpha',
    'alpha',
  ]);
});
