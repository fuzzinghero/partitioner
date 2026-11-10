import { expect, it } from 'vitest';
import { decodePercent, formPairs } from './percent.js';

it('matches platform form decoding for UTF-8, malformed byte sequences, BOMs and literal escapes', () => {
  const samples = [
    '%C0%AE',
    '%C0%80',
    '%E0%80%80',
    '%F0%80%80%AE',
    '%ED%A0%80',
    '%E2%82',
    '%EF%BB%BF',
    '%F0%9F%98%80',
    '%ZZ%41',
    '%',
    'café+tea%2B',
  ];
  for (let byte = 0; byte < 256; byte++) samples.push('%' + byte.toString(16).padStart(2, '0'));
  for (const sample of samples) {
    expect(decodePercent(sample, true), sample).toBe(new URLSearchParams('q=' + sample).get('q'));
  }
  expect(decodePercent('a+b%2Bc')).toBe('a+b+c');
});
it('retains raw values and repeated decoded field order', () => {
  expect([...formPairs('q=%FF&q=valid+text&%71=%2B')]).toEqual([
    { name: 'q', value: '�', raw: '%FF' },
    { name: 'q', value: 'valid text', raw: 'valid+text' },
    { name: 'q', value: '+', raw: '%2B' },
  ]);
});
