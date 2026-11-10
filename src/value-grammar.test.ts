import { expect, it } from 'vitest';
import { valueGrammar } from './value-grammar.js';
it.each([
  ['2026-11-09T16:00:01Z', 'timestamp:iso'],
  ['Mon, 09 Nov 2026 16:00:01 GMT', 'timestamp:http'],
  ['2026-02-30T16:00:01Z', undefined],
  ['Tue, 09 Nov 2026 16:00:01 GMT', undefined],
  ['12.4ms', 'measurement:ms'],
  ['14.1s', 'measurement:s'],
  ['123e4567-e89b-42d3-a456-426614174000', 'opaque'],
  ['1111111111111111', undefined],
  ['ACCOUNT_LOCKED', undefined],
  ['2026-11-09', undefined],
])('recognizes complete value %s', (value, expected) => expect(valueGrammar(value)).toBe(expected));

import { distributionValue } from './value-grammar.js';
it.each([
  '2026-02-30T10:00:01Z',
  'ERROR_100',
  'ERROR-200',
  'Rejected account 12345',
  'https://account12345.test',
])('keeps non-identifier application text literal: %s', (value) => {
  expect(distributionValue(value, 'string')).toBe(false);
});
it.each(['0123456666666666', '0012345678999999', '0123456789012345'])(
  'recognizes a varied hex token without a base64 entropy threshold: %s',
  (value) => {
    expect(valueGrammar(value)).toBe('opaque');
  },
);
it.each(['1500000000', '1794132000000'])(
  'keeps bare epoch-looking values under generic variance admission: %s',
  (value) => {
    expect(valueGrammar(value)).toBeUndefined();
  },
);
