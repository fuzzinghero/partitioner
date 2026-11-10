import { markupSpans } from './reflection-template.js';
import { expect, it, describe } from 'vitest';
import { analyze } from './analyze.js';
import { compare } from './diff.js';

describe('response reflection templates', () => {
  const capture = (rows: unknown[]) => new Blob([JSON.stringify({ log: { entries: rows } })]);

  const escaped = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const multipart = (value: string) =>
    `--demo\r\nContent-Disposition: form-data; name="error"\r\n\r\nRejected input ${value}.\r\n--demo--\r\n`;

  const cases: [string, string, (value: string, index: number) => string][] = [
    ['plain URL encoding', 'text/plain', (v) => `Rejected input ${encodeURIComponent(v)}.`],
    [
      'plain double URL encoding',
      'text/plain',
      (v) => `Rejected input ${encodeURIComponent(encodeURIComponent(v))}.`,
    ],
    ['HTML entities', 'text/html', (v) => `<p>Rejected input ${escaped(v)}.</p>`],
    [
      'HTML numeric entities',
      'text/html',
      (v) => `<p>Rejected input ${v.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)}.</p>`,
    ],
    ['XML CDATA', 'application/xml', (v) => `<error>Rejected input <![CDATA[${v}]]></error>`],
    [
      'JSON root arrays',
      'application/json',
      (v) => JSON.stringify([{ error: 'Rejected input', echo: v }]),
    ],
    [
      'multipart typed text',
      'multipart/form-data; boundary = "demo"',
      (v) =>
        multipart(v).replace('\r\n\r\n', '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'),
    ],
    ['HTML attribute', 'text/html', (v) => `<p>Rejected input</p><input value="${escaped(v)}">`],
    [
      'HTML dates and echoes',
      'text/html',
      (v, i) =>
        `<p>Rejected input ${escaped(v)}.</p><p>${i % 2 ? 'Mon, 02 Jun 2025' : 'Sun, 01 Jun 2025'} 12:34:56 GMT</p>`,
    ],
    [
      'JSON embedded and repeated strings',
      'application/json',
      (v) => JSON.stringify({ error: 'Rejected input', echo: `value: ${v}`, again: v }),
    ],
    [
      'JSON arrays',
      'application/problem+json',
      (v) => JSON.stringify({ error: 'Rejected input', echoes: [v, `value: ${v}`] }),
    ],
    [
      'form values',
      'application/x-www-form-urlencoded',
      (v) => `error=Rejected+input&echo=${encodeURIComponent(v)}`,
    ],
    [
      'XML entities',
      'application/xml',
      (v) => `<error code="invalid">Rejected input <echo>${escaped(v)}</echo></error>`,
    ],
    ['XML attributes', 'text/xml', (v) => `<error echo="${escaped(v)}">Rejected input</error>`],
    ['multipart text', 'multipart/form-data; boundary=demo', (v) => multipart(v)],
  ];

  const row = (value: string, mime: string, text: string) => ({
    request: {
      method: 'GET',
      url: `https://example.test/echo?q=${encodeURIComponent(value)}`,
      headers: [],
    },
    response: { status: 400, headers: [], content: { mimeType: mime, text } },
  });

  const values = [1, 2, 3].map((i) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${i}`);

  it.each(cases)(
    'groups 100 corroborated reflections in %s with raw evidence retained',
    async (_name, mime, body) => {
      const rows = Array.from({ length: 100 }, (_, i) => {
        const value = `payload-${i}<tag>&"'`;
        return row(value, mime, body(value, i));
      });
      const result = await analyze(capture(rows));
      expect(result.outcomes.map((group) => group.members.length)).toEqual([100]);
      expect(result.outcomes[0].match).toBe('inferred-reflection');
      expect(new Set(result.entries.map((entry) => entry.body.hash)).size).toBe(100);
      expect(result.entries[0].body.text).toBe(rows[0].response.content.text);
      expect(compare(result.entries[0], result.entries[1]).body.changes.length).toBeGreaterThan(0);
    },
  );

  it('keeps bounded base64 fallback consistent across retained and evicted text', async () => {
    const rows = values.map((v) => {
      const entry = row(v, 'application/json', JSON.stringify({ echo: v, error: 'invalid' }));
      (entry.response.content as Record<string, unknown>).encoding = 'base64';
      entry.response.content.text = btoa(entry.response.content.text) + '\n'.repeat(100000);
      return entry;
    });
    for (const totalBodyBytes of [0, 32 * 1024 * 1024]) {
      const result = await analyze(capture(rows), { limits: { totalBodyBytes } });
      expect(result.outcomes.map((group) => group.members)).toEqual([[0], [1], [2]]);
      expect(result.entries.every((entry) => entry.body.hash !== undefined)).toBe(true);
    }
  });

  it.each(['query', 'path', 'header', 'cookie', 'JSON', 'Form', 'XML', 'Multipart'])(
    'uses captured %s request fields for encoded response templates',
    async (source) => {
      const rows = values.map((v) => {
        const entry = row(
          v,
          'application/json',
          JSON.stringify({ echo: `Rejected input ${encodeURIComponent(v)}`, accepted: false }),
        );
        const request: Record<string, unknown> = entry.request;
        if (source !== 'query') request.url = 'https://example.test/echo';
        if (source === 'path') request.url = 'https://example.test/echo/' + v;
        if (source === 'header') request.headers = [{ name: 'X-Input', value: v }];
        if (source === 'cookie') request.headers = [{ name: 'Cookie', value: 'input=' + v }];
        if (source === 'JSON')
          request.postData = { mimeType: 'application/json', text: JSON.stringify({ input: v }) };
        if (source === 'Form')
          request.postData = { mimeType: 'application/x-www-form-urlencoded', text: 'input=' + v };
        if (source === 'XML')
          request.postData = { mimeType: 'application/xml', text: '<input>' + v + '</input>' };
        if (source === 'Multipart')
          request.postData = { mimeType: 'multipart/form-data; boundary=demo', text: multipart(v) };
        // The multipart value includes a prefix; reflect that full captured field value.
        if (source === 'Multipart')
          entry.response.content.text = JSON.stringify({
            echo: 'Rejected input ' + encodeURIComponent('Rejected input ' + v + '.'),
            accepted: false,
          });
        return entry;
      });
      expect((await analyze(capture(rows))).outcomes.map((group) => group.members)).toEqual([
        [0, 1, 2],
      ]);
    },
  );

  it.each([
    ['HTML whole echo', 'text/html', (v: string) => `<p>${v}</p>`],
    [
      'HTML executable attribute',
      'text/html',
      (v: string) => `<p>Rejected ${v}</p><button onclick="run('${v}')">Go</button>`,
    ],
    [
      'HTML nested attribute syntax',
      'text/html',
      (v: string) => `<p>Rejected input</p><button onclick=" value='${v}' ">Go</button>`,
    ],
    ['HTML script', 'text/html', (v: string) => `<p>Rejected ${v}</p><script>run('${v}')</script>`],
    ['HTML comment', 'text/html', (v: string) => `<p>Rejected ${v}</p><!-- ${v} -->`],
    ['JSON whole echo', 'application/json', (v: string) => JSON.stringify({ echo: v })],
    ['XML whole echo', 'application/xml', (v: string) => `<r>${v}</r>`],
    [
      'XML DTD',
      'application/xml',
      (v: string) => `<!DOCTYPE r [<!ENTITY x "test">]><r>Rejected ${v}</r>`,
    ],
    ['XML comment', 'application/xml', (v: string) => `<r>Rejected ${v}<!-- ${v} --></r>`],
    ['form whole echo', 'application/x-www-form-urlencoded', (v: string) => `echo=${v}`],
    [
      'multipart file',
      'multipart/form-data; boundary=demo',
      (v: string) => multipart(v).replace('name="error"', 'name="error"; filename="echo.txt"'),
    ],
    [
      'multipart file with parameter whitespace',
      'multipart/form-data; boundary=demo',
      (v: string) => multipart(v).replace('name="error"', 'name="error"; filename = "echo.txt"'),
    ],
  ])('compares %s using its supported value grammar', async (label, mime, body) => {
    const rows = values.map((v) => row(v, mime, body(v)));
    expect((await analyze(capture(rows))).outcomes.map((group) => group.members)).toEqual(
      [
        'HTML whole echo',
        'HTML comment',
        'JSON whole echo',
        'XML whole echo',
        'form whole echo',
      ].includes(String(label))
        ? [[0, 1, 2]]
        : [[0], [1], [2]],
    );
  });

  it('combines form value canonicalization with reflections without reordering repeated values', async () => {
    const rows = values.map((v, i) =>
      row(
        v,
        'application/x-www-form-urlencoded',
        i % 2 ? `echo=${v}&error=Rejected+input` : `error=Rejected%20input&echo=${v}`,
      ),
    );
    expect((await analyze(capture(rows))).outcomes.map((group) => group.members)).toEqual([
      [0, 1, 2],
    ]);
    const changed = [false, true].flatMap((flip) =>
      values.map((v) =>
        row(
          v,
          'application/x-www-form-urlencoded',
          `error=Rejected+input&echo=${v}&fixed=${flip ? 'b&fixed=a' : 'a&fixed=b'}`,
        ),
      ),
    );
    expect((await analyze(capture(changed))).outcomes.map((group) => group.members)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
  });

  it.each(['application/javascript', 'text/css', 'text/csv', 'application/octet-stream'])(
    'retains exact-byte grouping for unsupported response grammar %s',
    async (mime) => {
      const rows = values.map((v) => row(v, mime, `Rejected input ${v}.`));
      expect((await analyze(capture(rows))).outcomes.map((group) => group.members)).toEqual([
        [0],
        [1],
        [2],
      ]);
    },
  );

  it.each([
    'text/plain',
    'text/html',
    'application/json',
    'application/xml',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=demo',
  ])('falls back to ordinary evidence beyond the reflection size bound in %s', async (mime) => {
    const rows = values.map((v) => {
      const value = 'Rejected input ' + 'a'.repeat(64 * 1024) + v;
      const text =
        mime === 'application/json'
          ? JSON.stringify({ echo: value, error: 'invalid' })
          : mime === 'application/xml'
            ? `<r>${value}</r>`
            : mime === 'text/html'
              ? `<p>${value}</p>`
              : mime.startsWith('multipart/')
                ? multipart(value)
                : mime === 'application/x-www-form-urlencoded'
                  ? 'echo=' + encodeURIComponent(value)
                  : value;
      return row(v, mime, text);
    });
    const result = await analyze(capture(rows));
    expect(result.outcomes.map((group) => group.members)).toEqual([[0], [1], [2]]);
    expect(result.entries.every((entry) => entry.body.hash !== undefined)).toBe(true);
  });

  it.each(['application/json', 'application/x-www-form-urlencoded', 'text/plain'])(
    'groups request-backed %s echoes without requiring independent witness text',
    async (mime) => {
      const rows = values.map((v) => {
        const text =
          mime === 'application/json'
            ? JSON.stringify({ echo: 'prefix ' + v + ' suffix' })
            : mime === 'text/plain'
              ? 'prefix ' + v + ' suffix'
              : 'echo=' + encodeURIComponent('prefix ' + v + ' suffix');
        const entry = row(v, mime, text);
        const request: Record<string, unknown> = entry.request;
        request.url = 'https://example.test/echo';
        request.postData = {
          mimeType: 'application/json',
          text: JSON.stringify({ input: v, prefix: 'prefix ', suffix: ' suffix' }),
        };
        return entry;
      });
      expect((await analyze(capture(rows))).outcomes.map((group) => group.members)).toEqual([
        [0, 1, 2],
      ]);
    },
  );

  it('compares bodies beyond the text-slot allowance literally', async () => {
    const rows = values.map((v) => {
      const entry = row(v, 'text/plain', 'Rejected input ' + (v + '.').repeat(400));
      const request: Record<string, unknown> = entry.request;
      request.url = 'https://example.test/echo';
      request.headers = [{ name: 'X-' + 'a'.repeat(4096), value: v }];
      return entry;
    });
    const result = await analyze(capture(rows));
    expect(result.outcomes.map((group) => group.members)).toEqual([[0], [1], [2]]);
    expect(result.entries.every((entry) => entry.body.hash !== undefined)).toBe(true);
  });

  it.each(['Form', 'XML', 'Multipart'])(
    'groups captured %s field echoes in JSON envelopes',
    async (kind) => {
      const rows = values.map((v) => {
        const entry = row(v, 'application/json', JSON.stringify({ input: v, accepted: false }));
        const request: Record<string, unknown> = entry.request;
        request.url = 'https://example.test/echo';
        if (kind === 'Form')
          request.postData = {
            mimeType: 'application/x-www-form-urlencoded',
            text: `input=${v}&accepted=false`,
          };
        if (kind === 'XML')
          request.postData = {
            mimeType: 'application/xml',
            text: `<r><input>${v}</input><accepted>false</accepted></r>`,
          };
        if (kind === 'Multipart')
          request.postData = {
            mimeType: 'multipart/form-data; boundary=demo',
            text: `--demo\r\nContent-Disposition: form-data; name="input"\r\n\r\n${v}\r\n--demo\r\nContent-Disposition: form-data; name="accepted"\r\n\r\nfalse\r\n--demo--\r\n`,
          };
        return entry;
      });
      expect((await analyze(capture(rows))).outcomes.map((group) => group.members)).toEqual([
        [0, 1, 2],
      ]);
    },
  );

  it.each(['JSON', 'Form', 'XML', 'Multipart'])(
    'groups reformatted complete %s echoes using their captured input values',
    async (kind) => {
      const rows = values.map((v) => {
        let mime = 'application/json',
          requestText = JSON.stringify({ input: v, state: 'rejected' }),
          responseText = JSON.stringify({ state: 'rejected', input: v });
        if (kind === 'Form') {
          mime = 'application/x-www-form-urlencoded';
          requestText = `input=${v}&state=rejected`;
          responseText = `state=rejected&input=${v}`;
        }
        if (kind === 'XML') {
          mime = 'application/xml';
          requestText = `<r input="${v}" state="rejected"/>`;
          responseText = `<r state="rejected" input="${v}"/>`;
        }
        if (kind === 'Multipart') {
          mime = 'multipart/form-data; boundary=demo';
          requestText = multipart(v);
          responseText = multipart(v).replace('name="error"', 'name="echo"');
        }
        const entry = row(v, mime, responseText);
        // Only the captured body supplies reflection candidates.
        const request: Record<string, unknown> = entry.request;
        request.url = 'https://example.test/echo';
        request.postData = { mimeType: mime, text: requestText };
        return entry;
      });
      expect((await analyze(capture(rows))).outcomes.map((group) => group.members)).toEqual([
        [0, 1, 2],
      ]);
    },
  );

  it('retains raw versus escaped output as different reflection patterns', async () => {
    const rows = [false, true].flatMap((encode) =>
      [1, 2, 3].map((i) => {
        const v = `payload-${i}&"'`;
        return row(v, 'text/html', `<p>Rejected input ${encode ? escaped(v) : v}.</p>`);
      }),
    );
    expect((await analyze(capture(rows))).outcomes.map((group) => group.members)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
  });

  it.each(cases)(
    'keeps %s templates available after text eviction and HAR base64 decoding',
    async (_name, mime, body) => {
      const rows = [1, 2, 3].map((i) => {
        const v = `payload-${i}<tag>&"'`;
        const entry = row(v, mime, body(v, i));
        (entry.response.content as Record<string, unknown>).encoding = 'base64';
        entry.response.content.text = btoa(entry.response.content.text);
        return entry;
      });
      const result = await analyze(capture(rows), { limits: { totalBodyBytes: 0 } });
      expect(result.outcomes.map((group) => group.members)).toEqual([[0, 1, 2]]);
      expect(result.entries.every((entry) => entry.body.text === undefined)).toBe(true);
    },
  );
});
it('exposes empty element content without inventing nodes between container or void tags', () => {
  const spans = markupSpans(
    '<html><head></head><body><input><input><br><p></p></body></html>',
    false,
  )!;
  expect(spans).toHaveLength(2);
  expect(markupSpans('<r><child></child></r>', true)).toHaveLength(1);
});
