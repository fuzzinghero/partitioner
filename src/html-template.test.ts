import { expect, it, describe } from 'vitest';
import { analyze } from './core.js';
import { analyze as analyzeInternal } from './analyze.js';

describe('visible HTTP date normalization', () => {
  const row = (text = '', extra = {}, responseExtra = {}) => ({
    request: {
      method: 'POST',
      url: 'https://example.invalid/items',
      headers: [],
      queryString: [],
      ...extra,
    },
    response: {
      status: 503,
      headers: [],
      content: { mimeType: 'text/html', text },
      ...responseExtra,
    },
  });

  const run = (entries: unknown[]) => analyze(new Blob([JSON.stringify({ log: { entries } })]));

  const first = 'Thu, 8 Oct 2026 18:03:41 GMT',
    second = 'Thu, 8 Oct 2026 18:03:42 GMT';

  it('generalizes only visible HTTP dates, retains raw bodies and labels the policy', async () => {
    const a = await run([row(`<p>Generated ${first}</p>`), row(`<p>Generated ${second}</p>`)]);
    expect(a.outcomes).toHaveLength(1);
    expect(a.entries[0].body.text).not.toBe(a.entries[1].body.text);
    expect(a.entries[1].body.text).toContain(second);
    expect(a.outcomes[0].match).toBe('inferred-noise');
    expect(a.outcomes[0].normalizations).toContain('response-telemetry');
  });

  it.each([
    '<script>const date="DATE"</script>',
    '<style>/* DATE */</style>',
    '<p title="DATE">same</p>',
    '<!-- DATE --><p>same</p>',
    '<textarea>DATE</textarea>',
  ])('preserves non-visible date changes in %s', async (template) => {
    const a = await run([
      row(template.replace('DATE', first)),
      row(template.replace('DATE', second)),
    ]);
    expect(a.outcomes).toHaveLength(
      template.startsWith('<p title=') || template.startsWith('<!--') ? 1 : 2,
    );
  });

  it('preserves error messages, attributes and script changes alongside visible timestamps', async () => {
    const a = await run([
      row(`<p class="one">Allowed ${first}</p><script>1</script>`),
      row(`<p class="one">Denied ${second}</p><script>1</script>`),
      row(`<p class="two">Allowed ${second}</p><script>1</script>`),
      row(`<p class="one">Allowed ${second}</p><script>2</script>`),
    ]);
    expect(a.outcomes).toHaveLength(4);
  });

  it('cannot collide with a literal placeholder and falls back safely on malformed/oversized HTML', async () => {
    const a = await run([
      row(`<p>${first}</p>`),
      row('<p>visible-http-date</p>'),
      row(`<script>${first}`),
      row(`<p>${'x'.repeat(256 * 1024)}${first}</p>`),
    ]);
    expect(a.outcomes).toHaveLength(4);
    expect(a.entries.every((entry) => entry.body.bytes !== undefined)).toBe(true);
    expect(a.entries[2].body.text).toBe(`<script>${first}`);
    expect(a.outcomes[3].match).toBe('exact');
  });
});

describe('reflection safeguards', () => {
  const capture = (rows: unknown[]) => new Blob([JSON.stringify({ log: { entries: rows } })]);

  const values = ['payload-111', 'payload-222', 'payload-333'];

  const row = (value: string, mime: string, text: string) => ({
    request: {
      method: 'GET',
      url: 'https://example.test/echo?q=' + encodeURIComponent(value),
      headers: [] as { name: string; value: string }[],
    },
    response: { status: 400, headers: [], content: { mimeType: mime, text } },
    time: 0,
  });

  const groups = async (rows: unknown[]) =>
    (await analyzeInternal(capture(rows))).outcomes.map((g) => g.members);

  const dates = ['Sun, 01 Jun 2025', 'Mon, 02 Jun 2025', 'Tue, 03 Jun 2025'];

  it.each([
    ['weekday mismatch', ['Mon, 01 Jan 2025', 'Tue, 01 Jan 2025', 'Thu, 01 Jan 2025']],
    ['impossible calendar date', ['Mon, 29 Feb 2025', 'Tue, 30 Feb 2025', 'Wed, 31 Feb 2025']],
  ])('preserves %s in date-shaped application output', async (_name, invalid) => {
    expect(
      await groups(
        values.map((v, i) => row(v, 'text/html', `<p>Decision ${invalid[i]} 12:34:56 GMT</p>`)),
      ),
    ).toEqual([[0], [1], [2]]);
  });

  it('preserves HTML param values that can carry plugin or URL configuration', async () => {
    expect(
      await groups(
        values.map((v) =>
          row(
            v,
            'text/html',
            `<object><param name="movie" value="${v}"></object><p>Rejected input</p>`,
          ),
        ),
      ),
    ).toEqual([[0], [1], [2]]);
  });

  it.each(['reflections', 'dates'])(
    'keeps apparent closing plaintext markup literal for %s',
    async (method) => {
      const rows = values.map((v, i) =>
        row(
          v,
          'text/html',
          `<plaintext></plaintext><p>${method === 'dates' ? dates[i] + ' 12:34:56 GMT' : 'Rejected input ' + v}</p>`,
        ),
      );
      expect(await groups(rows)).toEqual([[0], [1], [2]]);
    },
  );

  it('enforces the markup span allowance when many attributes occur on the last tag', async () => {
    const rows = values.map((v) =>
      row(
        v,
        'text/html',
        '<p>Rejected input</p><input ' +
          Array.from({ length: 500 }, (_, i) => `data-x${i}="${v}"`).join(' ') +
          '>',
      ),
    );
    expect(await groups(rows)).toEqual([[0], [1], [2]]);
  });

  it.each(['script', 'ScRiPt'])('keeps double-escaped %s assignments literal', async (tag) => {
    const rows = values.map((value) =>
      row(
        value,
        'text/html',
        `<${tag}><!--<${tag}>\n// </${tag}>\nwindow.result = "${value}";\n</${tag}><p>rejected</p>`,
      ),
    );
    const result = await analyzeInternal(capture(rows));
    expect(result.outcomes.map((group) => group.members)).toEqual([[0], [1], [2]]);
    expect(result.entries.map((entry) => entry.body.text)).toEqual(
      rows.map((entry) => entry.response.content.text),
    );
  });

  it('keeps dates inside double-escaped script assignments literal', async () => {
    const dates = ['Sun, 01 Jun 2025', 'Mon, 02 Jun 2025', 'Tue, 03 Jun 2025'];
    const rows = dates.map((date) =>
      row(
        'payload-111',
        'text/html',
        `<script><!--<script>\n// </script>\nwindow.result = "${date} 12:34:56 GMT";\n</script><p>rejected</p>`,
      ),
    );
    expect(await groups(rows)).toEqual([[0], [1], [2]]);
  });

  it('still groups visible reflections after ordinary script elements', async () => {
    const rows = values.map((value) =>
      row(value, 'text/html', `<script>window.result = "fixed";</script><p>rejected ${value}</p>`),
    );
    expect(await groups(rows)).toEqual([[0, 1, 2]]);
  });

  it.each(
    ['script', 'ScRiPt', 'style', 'textarea', 'title'].flatMap((tag) =>
      [' x>', '/>', ' x="">'].flatMap((ending) =>
        ['reflection', 'dates'].map((mode) => ({ tag, ending, mode })),
      ),
    ),
  )(
    'keeps executable $mode literal after the first unsupported $tag closing $ending',
    async ({ tag, ending, mode }) => {
      const rows = values.map((value, i) =>
        row(
          mode === 'reflection' ? value : 'payload-111',
          'text/html',
          `<${tag}></${tag}${ending}<script data-x="</${tag}>">window.result="${mode === 'reflection' ? value : dates[i] + ' 12:34:56 GMT'}";</script><p>rejected</p>`,
        ),
      );
      expect(await groups(rows)).toEqual([[0], [1], [2]]);
    },
  );

  it.each(
    ['\u00a0', '\u000b', '\u2003', '\u2028', '\u2029', '\ufeff'].flatMap((space) =>
      ['reflection', 'dates'].map((mode) => ({ space, mode })),
    ),
  )(
    'keeps raw script $mode after a non-HTML whitespace end tag ($space)',
    async ({ space, mode }) => {
      const rows = values.map((value, i) =>
        row(
          mode === 'reflection' ? value : 'payload-111',
          'text/html',
          `<script>\n// </script${space}>\nwindow.result = "${mode === 'reflection' ? value : dates[i] + ' 12:34:56 GMT'}";\n</script><p>rejected</p>`,
        ),
      );
      expect(await groups(rows)).toEqual([[0], [1], [2]]);
    },
  );

  it.each(['\t', '\n', '\f', '\r', ' '])(
    'recognizes HTML ASCII whitespace in raw-text end tags (%j)',
    async (space) => {
      for (const mode of ['reflection', 'dates']) {
        const rows = values.map((value, i) =>
          row(
            mode === 'reflection' ? value : 'payload-111',
            'text/html',
            `<script>window.result = "fixed";</script${space}><p>Rejected ${mode === 'reflection' ? value : dates[i] + ' 12:34:56 GMT'}</p>`,
          ),
        );
        expect(await groups(rows)).toEqual([[0, 1, 2]]);
      }
    },
  );

  it.each(
    ['<!-->', '<!--->', '<!--x--!>'].flatMap((comment) =>
      ['reflection', 'dates'].map((mode) => ({ comment, mode })),
    ),
  )(
    'keeps executable $mode after unsupported comment ending $comment literal',
    async ({ comment, mode }) => {
      const rows = values.map((value, i) =>
        row(
          mode === 'reflection' ? value : 'payload-111',
          'text/html',
          `${comment}<script>/* --> */window.result = "${mode === 'reflection' ? value : dates[i] + ' 12:34:56 GMT'}";</script><p>rejected</p>`,
        ),
      );
      expect(await groups(rows)).toEqual([[0], [1], [2]]);
    },
  );

  it('groups visible reflections following ordinary HTML comments', async () => {
    const rows = values.map((value) =>
      row(
        value,
        'text/html',
        `<!-- ordinary comment --><script>window.result = "fixed";</script><p>Rejected ${value}</p>`,
      ),
    );
    expect(await groups(rows)).toEqual([[0, 1, 2]]);
  });

  it.each(['reflection', 'dates'])(
    'keeps executable %s literal after unsupported DOCTYPE syntax',
    async (mode) => {
      const rows = values.map((value, i) =>
        row(
          mode === 'reflection' ? value : 'payload-111',
          'text/html',
          `<!DOCTYPE html foo="><script>/*">*/window.result = "${mode === 'reflection' ? value : dates[i] + ' 12:34:56 GMT'}";</script><p>rejected</p>`,
        ),
      );
      expect(await groups(rows)).toEqual([[0], [1], [2]]);
    },
  );

  it.each(['<!DOCTYPE html>', '<!doctype\thtml\r\n>'])(
    'supports inference after a minimal HTML doctype %j',
    async (doctype) => {
      for (const mode of ['reflection', 'dates']) {
        const rows = values.map((value, i) =>
          row(
            mode === 'reflection' ? value : 'payload-111',
            'text/html',
            `${doctype}<p>Rejected ${mode === 'reflection' ? value : dates[i] + ' 12:34:56 GMT'}</p>`,
          ),
        );
        expect(await groups(rows)).toEqual([[0, 1, 2]]);
      }
    },
  );

  it.each(
    ['</div x=a">', '<div x=a">', '<div\u00a0x=">', '</ div x=">'].flatMap((tag) =>
      ['reflection', 'dates'].map((mode) => ({ tag, mode })),
    ),
  )('keeps executable $mode literal after unsupported tag $tag', async ({ tag, mode }) => {
    const rows = values.map((value, i) =>
      row(
        mode === 'reflection' ? value : 'payload-111',
        'text/html',
        `${tag}<script>/*">*/window.result = "${mode === 'reflection' ? value : dates[i] + ' 12:34:56 GMT'}";</script><p>rejected</p>`,
      ),
    );
    expect(await groups(rows)).toEqual([[0], [1], [2]]);
  });

  it.each(['</div>', '</DIV \t>', '<div disabled data-x=plain>'])(
    'supports conventional HTML tag syntax %j',
    async (tag) => {
      for (const mode of ['reflection', 'dates']) {
        const rows = values.map((value, i) =>
          row(
            mode === 'reflection' ? value : 'payload-111',
            'text/html',
            `${tag}<script>window.result = "fixed";</script><p>Rejected ${mode === 'reflection' ? value : dates[i] + ' 12:34:56 GMT'}</p>`,
          ),
        );
        expect(await groups(rows)).toEqual([[0, 1, 2]]);
      }
    },
  );

  it.each(
    ['svg', 'SvG', 'math', 'MaTh'].flatMap((root) =>
      ['reflection', 'dates'].map((mode) => ({ root, mode })),
    ),
  )(
    'keeps executable $mode inside unsupported $root integration points literal',
    async ({ root, mode }) => {
      const math = root.toLowerCase() === 'math';
      const rows = values.map((value, i) =>
        row(
          mode === 'reflection' ? value : 'payload-111',
          'text/html',
          `<${root}>${math ? '<mtext><svg>' : ''}<title><script>/* </title> */window.result="${mode === 'reflection' ? value : dates[i] + ' 12:34:56 GMT'}";</script>${math ? '</svg></mtext>' : ''}</${root}><p>rejected</p>`,
        ),
      );
      expect(await groups(rows)).toEqual([[0], [1], [2]]);
    },
  );

  it.each(['reflection', 'dates'])(
    'supports ordinary HTML title and inert attribute text for %s',
    async (mode) => {
      const rows = values.map((value, i) =>
        row(
          mode === 'reflection' ? value : 'payload-111',
          'text/html',
          `<title>fixed</title><p data-label="<svg>">Rejected ${mode === 'reflection' ? value : dates[i] + ' 12:34:56 GMT'}</p>`,
        ),
      );
      expect(await groups(rows)).toEqual([[0, 1, 2]]);
    },
  );

  it.each(['reflection', 'dates'])(
    'keeps executable %s after ignored select descendants literal',
    async (mode) => {
      const rows = values.map((value, i) =>
        row(
          mode === 'reflection' ? value : 'payload-111',
          'text/html',
          `<select><title><script>/* </title> */window.result="${mode === 'reflection' ? value : dates[i] + ' 12:34:56 GMT'}";</script></select><p>rejected</p>`,
        ),
      );
      expect(await groups(rows)).toEqual([[0], [1], [2]]);
    },
  );
});
