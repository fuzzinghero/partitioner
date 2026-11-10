import { createAnalyzer } from '@fuzzinghero/partitioner/browser';
import { HarError } from '@fuzzinghero/partitioner';

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
export async function verify(createWorker) {
  const analyzer = createAnalyzer({ createWorker });
  const file = new Blob([
    JSON.stringify({
      log: {
        entries: [0, 1, 2].map((id) => ({
          request: { method: 'GET', url: `https://example.test/items?q=${id}`, headers: [] },
          response: {
            status: 200,
            headers: [],
            content: {
              mimeType: 'application/json',
              text: JSON.stringify({ id, state: ['accepted', 'denied', 'locked'][id] }),
            },
          },
        })),
      },
    }),
  ]);
  try {
    const progress = [];
    const summary = await analyzer.analyze(file, {
      onProgress: (value) => progress.push(value),
      limits: { totalBodyBytes: 0 },
    });
    check(summary.total === 3 && progress.at(-1).done === file.size, 'Import and progress');
    const partitions = await analyzer.getPartitions({ page: 1, pageSize: 1, status: 200 });
    check(
      partitions.total === 3 && partitions.rows[0].representative === 1,
      'Partition pagination',
    );
    const contexts = await analyzer.getContexts();
    check(
      (await analyzer.getPartitions({ context: contexts.rows[0].id })).total === 3,
      'Context filter',
    );
    const members = await analyzer.getMembers(contexts.rows[0].id, {
      kind: 'contexts',
      pageSize: 1,
      anchor: 2,
    });
    check(members.page === 2 && members.rows[0].id === 2, 'Member anchor');
    check(
      (await analyzer.getEntry(2)).body.text === JSON.stringify({ id: 2, state: 'locked' }),
      'Deferred entry read',
    );
    check((await analyzer.compare(0, 1)).body.changes[0].path === '/id', 'Response comparison');
    check(
      (await analyzer.getRequestChanges(1)).contrasts.every((value) => value.causal === false),
      'Request evidence',
    );
    const raw = await analyzer.request({ type: 'entry', id: 0 });
    check(raw.type === 'entry' && raw.data.id === 0, 'Legacy query');
    for (const query of [() => analyzer.getEntry(-1), () => analyzer.getRequestChanges(99)]) {
      try {
        await query();
        throw new Error('Invalid entry accepted');
      } catch (error) {
        check(error instanceof HarError && error.code === 'INVALID_ARGUMENT', 'Coded query error');
      }
    }
    try {
      await analyzer.analyze(new Blob(['{bad']));
      throw new Error('Malformed capture accepted');
    } catch (error) {
      check(error instanceof HarError && error.code === 'INVALID_HAR', 'Coded import error');
    }
    const controller = new AbortController();
    const cancelled = analyzer.analyze(file, { signal: controller.signal });
    controller.abort('private abort reason');
    try {
      await cancelled;
      throw new Error('Aborted import accepted');
    } catch (error) {
      check(error instanceof HarError && error.code === 'ABORTED', 'Cancellation');
    }
    await analyzer.analyze(file);
    check((await analyzer.getPartitions()).total === 3, 'Recovery after cancellation');
    const target = 'https://example.test';
    await analyzer.analyze(
      new Blob([
        JSON.stringify({
          log: {
            entries: [0, 1].map((id) => ({
              request: {
                method: 'GET',
                url: id === 0 ? `${target}/?q=one` : '/?q=two',
                headers: [{ name: 'Host', value: id === 0 ? 'example.test' : '127.0.0.1' }],
              },
              comment: JSON.stringify({
                meta: {
                  target_scheme: 'https',
                  target_authority: 'example.test',
                  target_path: '/?q=two',
                },
              }),
              response: {
                status: 200,
                headers: [],
                content: { mimeType: 'text/plain', text: 'accepted' },
              },
            })),
          },
        }),
      ]),
      { limits: { totalBodyBytes: 0 } },
    );
    const resolved = await analyzer.getContexts();
    check(
      resolved.total === 1 && resolved.rows[0].scope === target + '/',
      'Resolved origin-form UI context',
    );
    check(resolved.rows[0].count === 2, 'Absolute and origin-form context members');
    const captured = await analyzer.getEntry(1);
    check(
      captured.url === '/?q=two' && captured.requestHeaders[0].value === '127.0.0.1',
      'Preserved request evidence',
    );
    check(!Object.hasOwn(captured, 'contextUrl'), 'Internal context target stays private');
    check(
      (await analyzer.getRequestChanges(1)).changes.some(
        (field) => field.kind === 'Header' && field.key === 'host',
      ),
      'Host mutation evidence',
    );
    await analyzer.analyze(
      new Blob([
        JSON.stringify({
          log: {
            entries: [
              {
                request: {
                  method: 'POST',
                  url: '/login',
                  httpVersion: 'HTTP/1.1',
                  headers: [{ name: 'Host', value: 'example.test' }],
                },
                comment: 'opaque legacy comment',
                response: {
                  status: 401,
                  headers: [],
                  content: { mimeType: 'text/plain', text: 'denied' },
                },
              },
            ],
          },
        }),
      ]),
    );
    const legacy = await analyzer.getContexts();
    check(
      legacy.total === 1 && legacy.rows[0].scope === 'http://example.test/login',
      'Legacy Host-only UI context',
    );
    await analyzer.analyze(
      new Blob([
        JSON.stringify({
          log: {
            entries: Array.from({ length: 100 }, (_, id) => ({
              request: {
                method: 'GET',
                url: `https://example.test/reflected?q=${encodeURIComponent(`payload-${id}<x>&"`)}`,
                headers: [],
              },
              response: {
                status: 400,
                headers: [],
                content: {
                  mimeType: 'text/html',
                  text: `<p>Rejected input</p><input value="payload-${id}&lt;x&gt;&amp;&quot;">`,
                },
              },
            })),
          },
        }),
      ]),
      { limits: { totalBodyBytes: 0 } },
    );
    const reflected = await analyzer.getPartitions();
    check(
      reflected.total === 1 && reflected.rows[0].count === 100,
      '100 encoded reflections share a partition',
    );
    check(
      reflected.rows[0].match === 'inferred-reflection',
      'Reflection grouping is labeled heuristic',
    );
    check(
      (await analyzer.getEntry(0)).body.text.includes('payload-0&lt;x&gt;&amp;&quot;'),
      'Original reflected HTML survives deferred reading',
    );
    check(
      (await analyzer.compare(0, 1)).body.changes.length > 0,
      'Raw reflected responses still differ',
    );
    check(
      (await analyzer.getRequestChanges(0)).entries === 100,
      'Input variations retain all reflected requests',
    );
    check(
      !Object.hasOwn((await analyzer.getEntry(0)).body, 'hash'),
      'Compatibility fingerprints stay private',
    );
    const values = [1, 2, 3, 4].map((id) => `payload-${id}&`);
    const entries = [false, true].flatMap((escape) =>
      values.map((value) => ({
        request: {
          method: 'GET',
          url: 'https://example.test/guard?q=' + encodeURIComponent(value),
          headers: [],
        },
        response: {
          status: 400,
          headers: [],
          content: {
            mimeType: 'application/json',
            text: JSON.stringify({
              echo: escape ? value.replace(/&/g, '&amp;') : value,
              error: 'invalid',
            }),
          },
        },
      })),
    );
    entries.push({
      ...entries[4],
      request: {
        ...entries[4].request,
        url: 'https://example.test/guard?q=' + encodeURIComponent('payload-1&amp;'),
      },
    });
    await analyzer.analyze(new Blob([JSON.stringify({ log: { entries } })]));
    const guarded = await analyzer.getPartitions();
    check(
      guarded.total === 3 &&
        guarded.rows
          .map((row) => row.count)
          .sort()
          .join(',') === '2,3,4',
      'Ambiguous exact echoes cannot bridge raw and escaped cohorts',
    );
    const xmlCopies = [1, 2, 3].map((id) => ({
      request: {
        method: 'POST',
        url: 'https://example.test/xml',
        headers: [],
        postData: {
          mimeType: 'application/xml',
          text: `<r><status/><input>payload-${id}</input></r>`,
        },
      },
      response: {
        status: 400,
        headers: [],
        content: {
          mimeType: 'application/json',
          text: JSON.stringify({ echo: `payload-${id}`, name: 'status' }),
        },
      },
    }));
    await analyzer.analyze(new Blob([JSON.stringify({ log: { entries: xmlCopies } })]), {
      limits: { totalBodyBytes: 0 },
    });
    check(
      (await analyzer.getPartitions()).total === 1,
      'Captured XML values reflect independently of constant element-name text',
    );
    for (const format of [
      {
        kind: 'JSON',
        mime: 'application/problem+json',
        key: '/x/a',
        body: (value) =>
          value === 'standard' ? '{"keep":1}' : JSON.stringify({ keep: 1, x: { a: value } }),
      },
      {
        kind: 'Form',
        mime: 'application/x-www-form-urlencoded',
        key: '/item/0/value',
        body: (value) => `item=${value}`,
      },
      {
        kind: 'XML',
        mime: 'application/xml',
        key: '/request/0/mode/0/#text/0',
        body: (value) => `<request><mode>${value}</mode></request>`,
      },
      {
        kind: 'Multipart',
        mime: 'multipart/form-data; boundary=x',
        key: '/upload/0/@filename',
        body: (value) =>
          `--x\r\nContent-Disposition: form-data; name="upload"; filename="${value}"\r\nContent-Type: application/octet-stream\r\n\r\nfixed\r\n--x--\r\n`,
      },
    ]) {
      const entries = ['standard', 'standard', 'disabled'].map((value, id) => ({
        request: {
          method: 'POST',
          url: 'https://example.test/children',
          headers: [],
          postData: { mimeType: format.mime, text: format.body(value) },
        },
        response: {
          status: id === 2 ? 422 : 200,
          content: { mimeType: 'text/plain', text: id === 2 ? 'Rejected' : 'Accepted' },
        },
      }));
      await analyzer.analyze(new Blob([JSON.stringify({ log: { entries } })]), {
        limits: { totalBodyBytes: 0 },
      });
      const changes = await analyzer.getRequestChanges(2);
      const expected = JSON.stringify([[format.kind, format.key]]);
      check(
        JSON.stringify(changes.changes.map((field) => [field.kind, field.key])) === expected,
        `${format.kind} child references replace duplicate Body samples`,
      );
      check(
        JSON.stringify(changes.current.changes.map((field) => [field.kind, field.key])) ===
          expected,
        `${format.kind} current reference points to the child`,
      );
      check(
        JSON.stringify(changes.contrasts[0].changes.map((field) => [field.kind, field.key])) ===
          expected,
        `${format.kind} contrast reference points to the child`,
      );
      check(
        (await analyzer.getEntry(2)).requestBody.text === format.body('disabled'),
        `${format.kind} complete raw request remains accessible`,
      );
    }
    const generated = [
      'a04bd877dfe3eaca8bbb89677f2f63e3',
      '18626d7941a871908bbb89677f2f62c6',
      'cc972df77c7611758bbb89677f2f699d',
      '40df5a7270139d9cd2c4e4df45a98955',
      '4b7f75ff6d76b33ed2c4e4df45a9843e',
      '34cbfb0fccda9120d2c4e4df45a98554',
      '0f22a567374e26c74e345482e3af0a16',
      'af8455f9e2eee2471ac9848239e55bb4',
    ];
    const capturedClock = (i) => `2026-10-28T10:00:0${i}.123456789+00:00`;
    for (const scenario of [
      { rule: 'detected-json', mime: 'text/plain', texts: ['{"a":1,"b":2}', '{"b":2,"a":1}'] },
      {
        rule: 'xml-attributes',
        mime: 'application/xml',
        texts: ['<r a="1" b="2"/>', '<r b="2" a="1"/>'],
      },
      {
        rule: 'response-telemetry',
        mime: 'application/json',
        texts: generated.map((value, i) =>
          JSON.stringify({ message: 'Rejected', arbitrary: capturedClock(i), other: value }),
        ),
      },
      {
        rule: 'response-headers',
        mime: 'application/json',
        texts: Array(8).fill('{"message":"Rejected"}'),
      },
      {
        rule: 'cookie-rotation',
        mime: 'application/json',
        texts: Array(8).fill('{"error":"Rejected"}'),
      },
    ]) {
      const entries = scenario.texts.map((text, id) => ({
        request: { method: 'GET', url: 'https://example.test/defaults', headers: [] },
        response: {
          status: 400,
          headers: [
            { name: 'Date', value: new Date(capturedClock(id)).toUTCString() },
            ...(scenario.rule === 'cookie-rotation'
              ? [{ name: 'Set-Cookie', value: `arbitrary=${generated[id]}; Path=/; HttpOnly` }]
              : []),
            ...(scenario.rule === 'response-headers'
              ? [{ name: 'Arbitrary-Observation', value: generated[id] }]
              : []),
          ],
          content: { mimeType: scenario.mime, text },
        },
      }));
      await analyzer.analyze(new Blob([JSON.stringify({ log: { entries } })]), {
        limits: { totalBodyBytes: 0 },
      });
      const partitions = await analyzer.getPartitions();
      check(
        partitions.total === 1 && partitions.rows[0].count === entries.length,
        `${scenario.rule} default works in installed workers`,
      );
      check(
        partitions.rows[0].normalizations.includes(scenario.rule),
        `${scenario.rule} is disclosed`,
      );
      const sample = await analyzer.getEntry(0);
      check(
        sample.body.text === scenario.texts[0],
        `${scenario.rule} raw response survives rereading`,
      );
      check(!('noise' in sample.body), 'Private diagnostic fingerprint stays internal');
    }
  } finally {
    analyzer.dispose();
  }
}
