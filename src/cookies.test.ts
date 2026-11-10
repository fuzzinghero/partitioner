import { expect, it } from 'vitest';
import { analyze } from './analyze.js';
import { requestChanges, requestChangesComplete } from './request-analysis.js';
import type { Header } from './types.js';

const capture = (values: (string | Header[])[]) =>
  new Blob([
    JSON.stringify({
      log: {
        entries: values.map((value, index) => ({
          request: {
            method: 'GET',
            url: 'https://example.test/preferences',
            headers: typeof value === 'string' ? [{ name: 'Cookie', value }] : value,
          },
          response: {
            status: index === 0 ? 200 : 400,
            content: { mimeType: 'text/plain', text: index === 0 ? 'ok' : 'bad' },
          },
        })),
      },
    }),
  ]);

it('presents simple cookie changes once while keeping the original request header', async () => {
  const analysis = await analyze(
    capture(['display=standard', 'display=unknown', 'display=disabled']),
  );
  for (const evidence of [requestChanges(analysis, 1), await requestChangesComplete(analysis, 1)]) {
    expect(evidence.changes.map((change) => [change.kind, change.key])).toEqual([
      ['Cookie', 'display'],
    ]);
    expect(evidence.changes[0].examples.map((example) => example.value)).toContain('["unknown"]');
    expect(evidence.contrasts?.[0].changes.map((change) => [change.kind, change.key])).toEqual([
      ['Cookie', 'display'],
    ]);
  }
  expect(analysis.entries[1].requestHeaders).toContainEqual({
    name: 'Cookie',
    value: 'display=unknown',
  });
});

it('keeps the raw cookie header when any request has malformed cookie syntax', async () => {
  const analysis = await analyze(
    capture(['display=standard', 'display=unknown', 'display="unterminated']),
  );
  for (const evidence of [
    requestChanges(analysis, 1),
    requestChanges(analysis, 2),
    await requestChangesComplete(analysis, 2),
  ]) {
    expect(evidence.current?.changes).toContainEqual(
      expect.objectContaining({ kind: 'Header', key: 'cookie' }),
    );
    expect(evidence.contrasts?.flatMap((contrast) => contrast.changes)).toContainEqual(
      expect.objectContaining({ kind: 'Header', key: 'cookie' }),
    );
  }
});

it('deduplicates ordinary multi-cookie headers while preserving named values', async () => {
  const analysis = await analyze(
    capture([
      'theme=light; display=standard',
      'theme=light; display=unknown',
      'theme=light; display=disabled',
    ]),
  );
  const evidence = await requestChangesComplete(analysis, 1);
  expect(evidence.changes.map((change) => [change.kind, change.key])).toEqual([
    ['Cookie', 'display'],
  ]);
  expect(analysis.entries[1].requestHeaders[0].value).toBe('theme=light; display=unknown');
});

it('retains raw evidence when cookie order changes', async () => {
  const analysis = await analyze(
    capture(['theme=light; display=standard', 'display=unknown; theme=light']),
  );
  const evidence = await requestChangesComplete(analysis, 1);
  expect(evidence.changes).toContainEqual(
    expect.objectContaining({ kind: 'Header', key: 'cookie' }),
  );
});

it.each([
  {
    label: 'quoted values',
    headers: (value: string) => [{ name: 'Cookie', value: `display="${value}"` }],
  },
  {
    label: 'compact separators',
    headers: (value: string) => [{ name: 'Cookie', value: `theme=light;display=${value}` }],
  },
  {
    label: 'tab spacing',
    headers: (value: string) => [{ name: 'Cookie', value: `theme=light;\tdisplay=${value}\t` }],
  },
  {
    label: 'duplicate names',
    headers: (value: string) => [{ name: 'Cookie', value: `display=${value}; display=other` }],
  },
  {
    label: 'multiple header fields',
    headers: (value: string) => [
      { name: 'Cookie', value: 'theme=light' },
      { name: 'cookie', value: `display=${value}` },
    ],
  },
])('presents $label once across retained and source-backed queries', async ({ headers }) => {
  const requests = ['standard', 'unknown', 'disabled'].map(headers);
  const analysis = await analyze(capture(requests));
  const expected = requestChanges(analysis, 1);
  expect(expected.changes.map((change) => [change.kind, change.key])).toEqual([
    ['Cookie', 'display'],
  ]);
  expect(expected.current?.changes.map((change) => [change.kind, change.key])).toEqual([
    ['Cookie', 'display'],
  ]);
  expect(expected.contrasts?.[0].changes.map((change) => [change.kind, change.key])).toEqual([
    ['Cookie', 'display'],
  ]);
  expect(expected.changes[0].examples[0].value).toContain('unknown');
  expect(await requestChangesComplete(analysis, 1)).toEqual(expected);
  analysis.requestIndex!.rows.clear();
  expect(await requestChangesComplete(analysis, 1)).toEqual(expected);
  expect(analysis.entries.map((entry) => entry.requestHeaders)).toEqual(requests);
});

it.each([
  { label: 'quoting', values: ['display=standard', 'display="unknown"'] },
  { label: 'spacing', values: ['theme=light; display=standard', 'theme=light;display=unknown'] },
  {
    label: 'header boundaries',
    values: [
      [{ name: 'Cookie', value: 'theme=light; display=standard' }],
      [
        { name: 'Cookie', value: 'theme=light' },
        { name: 'Cookie', value: 'display=unknown' },
      ],
    ],
  },
])('preserves exact raw evidence when $label changes', async ({ values }) => {
  const analysis = await analyze(capture(values));
  const evidence = requestChanges(analysis, 1);
  expect(evidence.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'Header', key: 'cookie' }),
      expect.objectContaining({ kind: 'Cookie', key: 'display' }),
    ]),
  );
  expect(await requestChangesComplete(analysis, 1)).toEqual(evidence);
});
