import { expect, it } from 'vitest';
import { projectSlot } from './slot-projection.js';
import { reflectSlot } from './slot-reflection.js';
it('retains padded and dotted tokens while treating assignments as framing', () => {
  const p = projectSlot('trace=YWJjMTIzNDU2Nzg5MA==; id=v1.9f8a7b6c; took=14.1ms')!;
  expect(p.values).toEqual([
    'trace',
    'YWJjMTIzNDU2Nzg5MA==',
    'id',
    'v1.9f8a7b6c',
    'took',
    '14.1ms',
  ]);
  expect(p.shape).toContain('=');
});
it('projects complete reflected input spans, including multiple words', () => {
  const text = 'Rejected input: alpha one';
  const reflection = reflectSlot(text, [{ source: 'q', value: 'alpha one' }], () => true)!;
  const p = projectSlot(text, reflection)!;
  expect(p.values).toEqual(['Rejected', 'input']);
  expect(p.shape).toContainEqual({ reflected: 0, encoding: 'literal' });
});
it('does not shear an intrinsic timestamp with an incidental short input', () => {
  const text = 'At Tue, 1 Sep 2026 14:08:20 GMT';
  const reflection = reflectSlot(text, [{ source: 'q', value: '1' }], () => true)!;
  expect(projectSlot(text, reflection)).toBeUndefined();
  expect(projectSlot(text)!.values).toEqual(['At', 'Tue, 1 Sep 2026 14:08:20 GMT']);
});
it('bounds token projections without admitting a partial profile', () => {
  expect(projectSlot('word '.repeat(401))).toBeUndefined();
});
it.each([
  ['Tue, 1 Sep 2026 14:08:20 GMT', '1'],
  ['14.1ms', '14'],
  ['123e4567-e89b-42d3-a456-426614174000', '42d3'],
])('retains a valid echo after excluding an incidental match inside %s', (token, incidental) => {
  const text = `Rejected alpha at ${token}`;
  const match = reflectSlot(
    text,
    [
      { value: 'alpha', source: 'q' },
      { value: incidental, source: 'other' },
    ],
    () => true,
  )!;
  const projection = projectSlot(text, match)!;
  expect(projection.reflection?.values).toEqual(['alpha']);
  expect(projection.values).toContain(token);
});

it('marks only tokens overlapping copied spans, including after retained placeholders', () => {
  const text = '21 kept 21';
  const first = projectSlot(text, undefined, [{ start: 0, end: 2 }])!;
  expect(first.values).toEqual(['21', 'kept', '21']);
  expect(first.literalTokens).toEqual([true, false, false]);
  const match = reflectSlot(text, [{ value: 'kept', source: 'q' }], () => true)!;
  const second = projectSlot(text, match, [{ start: 8, end: 10 }])!;
  expect(second.values).toEqual(['21', '21']);
  expect(second.literalTokens).toEqual([false, true]);
});
