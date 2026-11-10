import { expect, it, describe } from 'vitest';
import { analyze } from './analyze.js';

describe('automatic response normalization', () => {
  const capture = (rows: unknown[]) => new Blob([JSON.stringify({ log: { entries: rows } })]);

  const row = (mime: string, text: string, headers: { name: string; value: string }[] = []) => ({
    request: { method: 'GET', url: 'https://example.test/result', headers: [] },
    response: { status: 400, headers, content: { mimeType: mime, text } },
  });

  const groups = async (rows: unknown[]) =>
    (await analyze(capture(rows))).outcomes.map((g) => g.members);

  it('canonicalizes only XML attribute order while preserving raw values and layout', async () => {
    const rows = ['<r a="1" b="2">text</r>', '<r b="2" a="1">text</r>'].map((text) =>
      row('application/xml', text),
    );
    expect(await groups(rows)).toEqual([[0, 1]]);
    for (const text of [
      '<r b="3" a="1">text</r>',
      '<r b="2" a="1"> text</r>',
      '<r b="2" a="1"><x/></r>',
    ])
      expect(await groups([rows[0], row('application/xml', text)])).toEqual([[0], [1]]);
  });

  it.each([
    ['<r><a/><b/></r>', '<r><b/><a/></r>'],
    ['<r a="1" a="2"/>', '<r a="2"/>'],
    ['<r xmlns="a" a="1" b="2"/>', '<r b="2" a="1" xmlns="a"/>'],
    ['<!DOCTYPE r><r a="1" b="2"/>', '<!DOCTYPE r><r b="2" a="1"/>'],
    ['<r a="1" b="2"><!--one--></r>', '<r b="2" a="1"><!--two--></r>'],
  ])('preserves unsupported or meaningful XML differences: %s', async (a, b) => {
    expect(await groups([row('application/xml', a), row('application/xml', b)])).toEqual([
      [0],
      [1],
    ]);
  });
});
