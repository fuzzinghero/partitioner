import { expect, it } from 'vitest';
import { analyzeEntry } from './entry.js';
import { collectRequestRow } from './request-index.js';
import { slotInputs, capturedRequestText } from './request-evidence.js';
import { LIMITS } from './types.js';

const raw = (
  postData: unknown = { mimeType: 'application/json', text: '{"a/b":{"0":9007199254740993}}' },
) => ({
  request: {
    method: 'POST',
    url: 'https://example.test:8080/a%2Fb?q=payload-111&q=',
    headers: [] as { name: string; value: string }[],
    postData,
  },
  response: {
    status: 400,
    headers: [],
    content: { mimeType: 'text/plain', text: 'Rejected input' },
  },
});
async function extract(captured = raw()) {
  const entry = await analyzeEntry(captured, 0, LIMITS, { bytes: 0, nodes: 0 });
  return { entry, inputs: slotInputs(entry, collectRequestRow(entry, captured), captured) };
}
it('collects actual values, explicit empties and path components with exact numeric precision', async () => {
  const { inputs } = await extract();
  const values = inputs!.map((v) => v.value);
  expect(values).toEqual(expect.arrayContaining(['payload-111', '', 'a/b', '9007199254740993']));
  expect(values).not.toContain('9007199254740992');
  expect(values).not.toContain('0'); // Object name, not a captured input value.
  expect(inputs!.filter((v) => v.source.includes('Query parameter'))).toHaveLength(2);
});
it.each([
  { mimeType: 'application/json', text: '{"q":"x"}', encoding: 'unsupported' },
  { mimeType: 'application/json', text: '{"q":"x"}', _displayEncoding: 'escaped' },
  { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'q', value: 'x' }] },
])('does not infer complete inputs from unavailable request bytes %#', async (post) => {
  expect((await extract(raw(post))).inputs).toBeUndefined();
});
it('uses complete decoded UTF-8 evidence independently of preview retention', async () => {
  const captured = raw({
    mimeType: 'application/json',
    encoding: 'base64',
    text: btoa('{"q":"value-123"}'),
  });
  const entry = await analyzeEntry(
    captured,
    0,
    { ...LIMITS, totalBodyBytes: 0 },
    { bytes: 0, nodes: 0 },
  );
  expect(entry.requestBody.text).toBeUndefined();
  expect(capturedRequestText(entry, captured)).toBe('{"q":"value-123"}');
  expect(
    slotInputs(entry, collectRequestRow(entry, captured), captured)!.map((v) => v.value),
  ).toContain('value-123');
});
it('reports input admission exhaustion atomically', async () => {
  const captured = raw();
  captured.request.url =
    'https://example.test/?' +
    Array.from({ length: 199 }, (_, i) => 'q' + i + '=payload-' + i).join('&');
  captured.request.headers = [
    { name: 'Seed-A', value: 'seed-a' },
    { name: 'Seed-B', value: 'seed-b' },
  ];
  const entry = await analyzeEntry(captured, 0, LIMITS, { bytes: 0, nodes: 0 });
  let limited = 0;
  expect(
    slotInputs(entry, collectRequestRow(entry, captured), captured, () => limited++),
  ).toBeUndefined();
  expect(limited).toBe(1);
});

it('extracts real captured empty, form and numeric JSON inputs without treating field names as values', async () => {
  const raw = {
    request: {
      method: 'POST',
      url: 'https://example.test/?q=',
      headers: [],
      postData: { mimeType: 'application/json', text: '{"id":9007199254740993}' },
    },
    response: { status: 400, headers: [], content: { mimeType: 'application/json', text: '{}' } },
  };
  const entry = await analyzeEntry(raw, 0, { ...LIMITS }, { bytes: 0, nodes: 0 });
  const values = slotInputs(entry, collectRequestRow(entry, raw))!;
  expect(values.map((v) => v.value)).toContain('');
  expect(values.map((v) => v.value)).toContain('9007199254740993');
  expect(values.map((v) => v.value)).not.toContain('id');
  const form = {
    ...raw,
    request: {
      ...raw.request,
      postData: { mimeType: 'application/x-www-form-urlencoded', text: 'q=null&x=%22hello%22' },
    },
  };
  const f = await analyzeEntry(form, 1, { ...LIMITS }, { bytes: 0, nodes: 0 });
  expect(slotInputs(f, collectRequestRow(f, form))!.map((v) => v.value)).toEqual(
    expect.arrayContaining(['null', '"hello"']),
  );
});
it('accepts explicit zero-byte requests exported with null body metadata', async () => {
  const source = raw(null);
  const captured = { ...source, request: { ...source.request, bodySize: 0 } };
  const { inputs } = await extract(captured);
  expect(inputs!.map((v) => v.value)).toContain('payload-111');
});

it.each(['query', 'path', 'form'])(
  'retains raw and replacement-decoded %s representations without discarding other inputs',
  async (kind) => {
    const captured = raw(undefined);
    captured.request.postData = undefined;
    captured.request.url = 'https://decode.invalid/api/check?good=kept';
    if (kind === 'query') captured.request.url += '&q=%FF';
    if (kind === 'path') captured.request.url = 'https://decode.invalid/api/%FF?good=kept';
    if (kind === 'form')
      captured.request.postData = { mimeType: 'application/x-www-form-urlencoded', text: 'q=%FF' };
    const { inputs, entry } = await extract(captured);
    expect(inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: '�', raw: '%FF' }),
        expect.objectContaining({ value: 'kept' }),
      ]),
    );
    expect(collectRequestRow(entry, captured)?.categories.has('Incomplete')).toBe(false);
  },
);
