import { expect, it, describe } from 'vitest';
import { structuredFields, STRUCTURE_LIMITS } from './structured.js';
import { analyzeReport } from './core.js';
import { analyze } from './analyze.js';
import { requestChanges, requestChangesComplete } from './request-analysis.js';

const multipartMime = 'multipart/form-data; boundary=demo';
const part = (name: string, value: string, headers = '') =>
  `--demo\r\nContent-Disposition: form-data; name="${name}"${headers}\r\n\r\n${value}\r\n`;
const multipart = (...parts: string[]) => parts.join('') + '--demo--\r\n';
const row = (mimeType: string, text: string, responseText = 'ok', responseMime = 'text/plain') => ({
  request: {
    method: 'POST',
    url: 'https://example.test/items',
    headers: [],
    postData: { mimeType, text },
  },
  response: { status: 200, headers: [], content: { mimeType: responseMime, text: responseText } },
});
const capture = (entries: unknown[]) => new Blob([JSON.stringify({ log: { entries } })]);

describe('bounded XML request fields', () => {
  it('extracts attributes, repeated elements, CDATA and standard entities with original identities', () => {
    const text =
      '<?xml version="1.0" encoding="UTF-8"?><root id="12"><item>A&amp;B</item><item><![CDATA[<inert/>]]></item><empty/></root>';
    expect([...structuredFields(text, 'application/xml')!.fields]).toEqual([
      ['/root/0/@id', '12'],
      ['/root/0/item/0/#text/0', 'A&B'],
      ['/root/0/item/1/#text/0', '<inert/>'],
    ]);
  });
  it('normalizes literal XML newlines before decoding character references', () => {
    const fields = structuredFields(
      '<r literal="a\r\nb\tc" numeric="a&#13;b&#x9;c">a\rb&#13;c&#xA;d</r>',
      'application/xml',
    )!.fields;
    expect([...fields]).toEqual([
      ['/r/0/@literal', 'a b c'],
      ['/r/0/@numeric', 'a\rb\tc'],
      ['/r/0/#text/0', 'a\nb\rc\nd'],
    ]);
  });
});

describe('bounded multipart request fields', () => {
  it('preserves repeated names, pointer escaping, literal content and file metadata', () => {
    const body = multipart(
      part('a/b~c', '["one","two"]'),
      part('a/b~c', 'file text', '; filename="x.txt"\r\nContent-Type: text/plain'),
    );
    expect([...structuredFields(body, multipartMime)!.fields]).toEqual([
      ['/a~1b~0c/0/value', '["one","two"]'],
      ['/a~1b~0c/1/@filename', 'x.txt'],
      ['/a~1b~0c/1/@content-type', 'text/plain'],
      ['/a~1b~0c/1/value', 'file text'],
    ]);
  });
  it('decodes quoted pairs in names without changing payload text', () => {
    const body = multipart(part('a\\"b', 'literal \\" text'));
    expect([...structuredFields(body, multipartMime)!.fields]).toEqual([
      ['/a"b/0/value', 'literal \\" text'],
    ]);
  });
});

const supported = [
  {
    kind: 'XML',
    mime: 'application/xml',
    body: (value: string) => `<root><item>${value}</item></root>`,
    key: '/root/0/item/0/#text/0',
  },
  {
    kind: 'Multipart',
    mime: multipartMime,
    body: (value: string) => multipart(part('item', value)),
    key: '/item/0/value',
  },
];
it.each(supported)(
  'prefers $kind references while retaining complete body samples through eviction and reports',
  async ({ kind, mime, body, key }) => {
    const bodies = ['alpha', 'beta'].map(body);
    const file = capture(bodies.map((text) => row(mime, text)));
    const analysis = await analyze(file, { limits: { totalBodyBytes: 0 } });
    const evidence = await requestChangesComplete(analysis, 1);
    expect(
      evidence.changes
        .find((field) => field.kind === kind && field.key === key)
        ?.examples.map((example) => example.value),
    ).toEqual(['alpha', 'beta']);
    expect(evidence.changes.map((field) => [field.kind, field.key])).toEqual([[kind, key]]);
    expect(evidence.incomplete).toBe(0);
    const report = await analyzeReport(file);
    expect(report.contexts[0].partitions[0].variations.fields).toEqual([
      expect.objectContaining({ category: kind, key }),
    ]);
    expect(report.contexts[0].partitions[0].sample?.request.body.text).toBe(bodies[0]);
    expect(analysis.entries[0].requestBody.text).toBeUndefined();
  },
);

const unsupported = [
  ['application/xml', '<r><item>first</item><bad></r>'],
  ['application/xml', '<r a="first" a="second"/>'],
  ['application/xml', '<r>first</r><other/>'],
  ['application/xml', '<r>first&#X41;</r>'],
  ['application/xml', '<!DOCTYPE r SYSTEM "https://test.invalid/dtd"><r>first</r>'],
  ['application/xml', '<r xmlns:x="urn:x"><x:item>first</x:item></r>'],
  ['application/xml', '<r>first &unknown;</r>'],
  ['application/xml', '<r>first\u0000</r>'],
  ['application/xml', '<r>first<!--a--b--></r>'],
  ['application/xml', '<r>first]]></r>'],
  ['application/xml', '<?xml version="1.1"?><r>first</r>'],
  ['application/xml', '<r>first<?instruction data?></r>'],
  ['application/xml', '<根>first</根>'],
  ['application/xml', '<r>' + '<a>'.repeat(33) + 'first' + '</a>'.repeat(33) + '</r>'],
  ['application/xml', '<r>' + '<a>first</a>'.repeat(201) + '</r>'],
  ['application/xml', '<r>' + 'first'.repeat(1700) + '</r>'],
  ['application/xml', '<r>' + 'first'.repeat(14000) + '</r>'],
  [multipartMime + '; boundary=other', multipart(part('a', 'first'))],
  [multipartMime, multipart(part('a', 'first'), part('b', 'second', '; name="duplicate"'))],
  [
    multipartMime,
    multipart(part('a', 'first'), part('b', 'second', '\r\nContent-Transfer-Encoding: base64')),
  ],
  [
    multipartMime,
    multipart(
      part('a', 'first'),
      part('b', 'second', '\r\nContent-Type: multipart/mixed; boundary=inner'),
    ),
  ],
  [
    multipartMime,
    multipart(
      part('a', 'first'),
      part('b', 'second', '\r\nContent-Type: text/plain\r\nContent-Type: text/html'),
    ),
  ],
  [multipartMime, multipart(part('a', 'first'), part('b', 'second', "; filename*=utf-8''x.txt"))],
  [multipartMime, part('a', 'first')],
  [multipartMime, multipart(part('a', 'first')) + 'epilogue'],
  [multipartMime, multipart(...Array.from({ length: 201 }, () => part('a', 'first')))],
];
it.each(unsupported.map(([mime, text], index) => ({ mime, text, case: index + 1 })))(
  'retains complete body evidence when $mime field extraction cannot finish (case $case)',
  async ({ mime, text }) => {
    const bodies = [text, text.replaceAll('first', 'changed')];
    const analysis = await analyze(capture(bodies.map((body) => row(mime, body))));
    expect(analysis.entries.map((entry) => entry.requestBody.text)).toEqual(bodies);
    const evidence = await requestChangesComplete(analysis, 1);
    const broad = evidence.changes.find(
      (field) => field.kind === 'Body' && field.key === 'Content',
    );
    expect(broad?.distinctValues).toBe(2);
    // An unsupported later token must not publish earlier parsed fields or infer removals.
    expect(
      analysis.requestIndex?.rows
        .get(0)
        ?.categories.get(mime.startsWith('multipart') ? 'Multipart' : 'XML'),
    ).toBeUndefined();
    expect(evidence.incomplete).toBeGreaterThan(0);
  },
);

it('falls back atomically when only one XML request can be interpreted', async () => {
  const bodies = ['<r><a>first</a></r>', '<r><a>changed</a><bad></r>'];
  const analysis = await analyze(
    capture([bodies[0], bodies[0], bodies[1]].map((text) => row('application/xml', text))),
  );
  const evidence = requestChanges(analysis, 2);
  expect(
    evidence.current?.changes.find((field) => field.kind === 'Body' && field.key === 'Content'),
  ).toMatchObject({ reference: bodies[0], observed: bodies[1] });
  expect(evidence.current?.changes.filter((field) => field.kind === 'XML')).toEqual([]);
});

it.each(supported)(
  'uses captured $kind values for corroborated plain and JSON reflection',
  async ({ kind, mime, body, key }) => {
    for (const responseMime of ['text/plain', 'application/json']) {
      const analysis = await analyze(
        capture(
          ['payload-111', 'payload-222', 'payload-333'].map((value) =>
            row(
              mime,
              body(value),
              responseMime === 'application/json'
                ? JSON.stringify({ echo: value, error: 'invalid' })
                : `Rejected ${value}.`,
              responseMime,
            ),
          ),
        ),
      );
      expect(analysis.requestIndex?.rows.get(0)?.categories.get(kind)?.get(key)).toBe(
        'payload-111',
      );
      expect(analysis.outcomes.map((group) => group.members)).toEqual([[0, 1, 2]]);
    }
  },
);

it('budgets structural work even when XML has no field values', () => {
  expect(() =>
    structuredFields('<r>' + '<empty/>'.repeat(20) + '</r>', 'application/xml', 10),
  ).toThrow();
  expect(() =>
    structuredFields('<r>' + 'x'.repeat(STRUCTURE_LIMITS.bytes) + '</r>', 'application/xml'),
  ).toThrow();
});

it.each([
  {
    mime: 'application/xml',
    text: '<r>first</r>',
    headers: [{ name: 'Content-Type', value: 'text/plain' }],
  },
  {
    mime: 'application/xml',
    text: '<r>first</r>',
    headers: [
      { name: 'Content-Type', value: 'application/xml' },
      { name: 'Content-Type', value: 'application/xml' },
    ],
  },
  {
    mime: multipartMime,
    text: multipart(part('a', 'first')),
    headers: [{ name: 'Content-Type', value: 'multipart/form-data; boundary=other' }],
  },
  {
    mime: multipartMime,
    text: multipart(part('a', 'first')),
    headers: [{ name: 'Content-Type', value: multipartMime + '; boundary=other' }],
  },
])(
  'uses broad body evidence for conflicting or duplicate $mime headers',
  async ({ mime, text, headers }) => {
    const entries = [text, text.replace('first', 'changed')].map((value) => {
      const entry = row(mime, value);
      return { ...entry, request: { ...entry.request, headers } };
    });
    const analysis = await analyze(capture(entries));
    expect(
      requestChanges(analysis, 1).changes.find(
        (field) => field.kind === 'Body' && field.key === 'Content',
      )?.distinctValues,
    ).toBe(2);
    expect(
      analysis.requestIndex?.rows
        .get(0)
        ?.categories.get(mime === 'application/xml' ? 'XML' : 'Multipart'),
    ).toBeUndefined();
  },
);

describe('Bounded public structured body parsing', () => {
  const request = (overrides = {}) => ({
    method: 'POST',
    url: 'https://example.invalid/items?q=one',
    headers: [{ name: 'X-Test', value: 'one' }],
    postData: { mimeType: 'application/json', text: '{"name":"one","n":9007199254740993}' },
    ...overrides,
  });

  const capture = (requests: unknown[]) =>
    new Blob([
      JSON.stringify({
        log: {
          entries: requests.map((req) => ({
            request: req,
            response: { status: 200, content: { mimeType: 'application/json', text: '{}' } },
          })),
        },
      }),
    ]);

  it('preserves JSON types, arrays, empty containers, precision and hostile keys', () => {
    const fields = structuredFields(
      '{"__proto__":{"x":1},"a/b":[null,true,{}]}',
      'application/problem+json',
    )!.fields;
    expect(fields.get('/__proto__/x')).toBe('1');
    expect(fields.get('/a~1b/0')).toBe('null');
    expect(fields.get('/a~1b/2')).toBe('{}');
    expect(() => structuredFields('{"x":1,"x":2}', 'application/json')).toThrow();
  });

  it('preserves XML attributes, namespaces, CDATA and inert markup as body evidence', async () => {
    const bodies = [
      '<r xmlns:x="urn:x"><x:item id="1">A&amp;B</x:item><x:item id="2"><![CDATA[<script>bad()</script>]]></x:item></r>',
      '<!DOCTYPE r SYSTEM "https://never.invalid"><r>&external;</r>',
    ];
    const result = await analyze(
      capture(bodies.map((text) => request({ postData: { mimeType: 'application/xml', text } }))),
    );
    expect(result.entries.map((entry) => entry.requestBody.text)).toEqual(bodies);
    expect(
      requestChanges(result, 1)
        .changes.find((field) => field.kind === 'Body' && field.key === 'Content')
        ?.examples.map((example) => example.value),
    ).toEqual(bodies);
  });

  it('handles duplicate form names, empty values and exact decoded values', () => {
    expect([
      ...structuredFields('a=one&a=two+words&empty=&x=%2B', 'application/x-www-form-urlencoded')!
        .fields,
    ]).toEqual([
      ['/a/0', 'one'],
      ['/a/1', 'two words'],
      ['/empty/0', ''],
      ['/x/0', '+'],
    ]);
    expect(() => structuredFields('x=%ZZ', 'application/x-www-form-urlencoded')).toThrow();
  });

  it('preserves multipart repeated fields, filenames and MIME as inert body evidence', async () => {
    const text =
      '--abc\r\nContent-Disposition: form-data; name="a"\r\n\r\none\r\n--abc\r\nContent-Disposition: form-data; name="a"; filename="x.html"\r\nContent-Type: text/html\r\n\r\n<script>inert()</script>\r\n--abc--\r\n';
    const bodies = [text, text.replace('one', 'two')];
    const result = await analyze(
      capture(
        bodies.map((text) =>
          request({ postData: { mimeType: 'multipart/form-data; boundary=abc', text } }),
        ),
      ),
    );
    expect(result.entries.map((entry) => entry.requestBody.text)).toEqual(bodies);
    expect(
      requestChanges(result, 1)
        .changes.find((field) => field.kind === 'Multipart' && field.key === '/a/0/value')
        ?.examples.map((example) => example.value),
    ).toEqual(['one', 'two']);
  });

  it('enforces structure bytes, field, depth and value budgets', () => {
    expect(() =>
      structuredFields(' '.repeat(STRUCTURE_LIMITS.bytes + 1), 'application/json'),
    ).toThrow();
    expect(() =>
      structuredFields(
        JSON.stringify(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [i, i]))),
        'application/json',
      ),
    ).toThrow();
    expect(() =>
      structuredFields('['.repeat(40) + '0' + ']'.repeat(40), 'application/json'),
    ).toThrow();
    expect(() =>
      structuredFields('x=' + 'a'.repeat(8193), 'application/x-www-form-urlencoded'),
    ).toThrow();
  });
});

describe('capture boundary cases', () => {
  const exchange = (text = '{}', mime = 'application/json') => ({
    request: {
      method: 'GET',
      url: 'https://example.test/items',
      headers: [] as { name: string; value: string }[],
    },
    response: {
      status: 200,
      headers: [] as { name: string; value: string }[],
      content: { text, mimeType: mime },
    },
  });

  const capture = (rows: unknown[]) => new Blob([JSON.stringify({ log: { entries: rows } })]);

  it.each(['<r>\u0001</r>', '<r>&#1;</r>', '<r><!--a--b--></r>', '<r>]]></r>'])(
    'preserves malformed XML as literal captured evidence: %s',
    async (text) => {
      const result = await analyze(
        capture([
          exchange(text, 'application/xml'),
          exchange('<r>safe</r>', 'application/xml'),
          exchange(text, 'application/xml'),
        ]),
      );
      expect(result.entries[0].body.text).toBe(text);
      expect(result.outcomes.map((group) => group.members)).toEqual([[0, 2], [1]]);
    },
  );
});

it('extracts multipart values while retaining ordinary part headers as framing', () => {
  const text = multipart(part('q', 'payload-111', '\r\nX-Part-Status: rejected'));
  expect(structuredFields(text, multipartMime)?.fields).toEqual(
    new Map([['/q/0/value', 'payload-111']]),
  );
});
it('does not dispatch unsupported media from a structured suffix inside a parameter', () => {
  expect(structuredFields('not JSON', 'text/plain; arbitrary=example+json')).toBeNull();
  expect(
    structuredFields('q=value', 'application/x-www-form-urlencoded; arbitrary=example+json')
      ?.format,
  ).toBe('Form');
});
