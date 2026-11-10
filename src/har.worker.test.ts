import { expect, it, vi, describe } from 'vitest';
import type { Reply, Request, Command } from './protocol.js';

describe('HAR worker handlers', () => {
  it('runs real import/query handlers, preserves Unicode previews, and recovers from failed imports', async () => {
    const pending = new Map<number, (reply: Reply) => void>();
    const port = {
      postMessage(reply: Reply) {
        if (reply.type !== 'progress') pending.get(reply.seq)?.(reply);
      },
      onmessage: undefined as ((event: MessageEvent<Request>) => void) | undefined,
    };
    vi.stubGlobal('self', port);
    try {
      await vi.importActual('./har.worker.js');
      let sequence = 0;
      const send = (command: Command) =>
        new Promise<Reply>((resolve, reject) => {
          const seq = ++sequence,
            timeout = setTimeout(
              () => reject(new Error('Worker did not settle this operation.')),
              1000,
            );
          pending.set(seq, (reply) => {
            clearTimeout(timeout);
            pending.delete(seq);
            resolve(reply);
          });
          port.onmessage!({ data: { ...command, seq } } as MessageEvent<Request>);
        });
      const text = 'a'.repeat(16383) + '😀end';
      const file = new Blob([
        JSON.stringify({
          log: {
            entries: [
              {
                request: { method: 'GET', url: 'https://example.test/', headers: [] },
                response: { status: 200, content: { mimeType: 'text/plain', text } },
              },
            ],
          },
        }),
      ]);
      expect((await send({ type: 'import', file, contexts: [[0]] })).type).toBe('ready');
      expect(await send({ type: 'request-changes', id: 99 })).toMatchObject({
        type: 'error',
        code: 'INVALID_ARGUMENT',
      });
      const entry = await send({ type: 'entry', id: 0 });
      expect(entry.type).toBe('entry');
      if (entry.type === 'entry') {
        expect(entry.data.family).toBe('Provided context 1');
        expect(Object.keys(entry.data.body)).not.toEqual(
          expect.arrayContaining(['hash', 'shape', 'reflection']),
        );
        expect(Object.keys(entry.data)).not.toEqual(
          expect.arrayContaining(['requestHeadersHash', 'responseHeaderFingerprint']),
        );
        expect(entry.data.body.text).toBe('a'.repeat(16383));
        expect(entry.data.body.displayTruncated).toBe(true);
      }
      const limited = await send({
        type: 'import',
        file,
        limits: { bodyBytes: 4, totalBodyBytes: 0 },
      });
      expect(limited.type === 'ready' && limited.summary.truncated).toBe(1);
      const reread = await send({ type: 'entry', id: 0 });
      expect(reread.type).toBe('entry');
      if (reread.type === 'entry') {
        expect(reread.data.body.state).toBe('limited');
        expect(Object.keys(reread.data.body)).not.toContain('hash');
        expect(reread.data.body.preview?.length).toBe(16383);
      }
      expect(
        (await send({ type: 'import', file, limits: { fileBytes: file.size - 1 } })).type,
      ).toBe('error');
      expect((await send({ type: 'import', file: new Blob(['{invalid']) })).type).toBe('error');
      expect((await send({ type: 'groups', kind: 'outcomes', page: 0, search: '' })).type).toBe(
        'error',
      );
      expect((await send({ type: 'import', file })).type).toBe('ready');
      const groups = await send({ type: 'groups', kind: 'outcomes', page: 0, search: '' });
      expect(groups.type === 'groups' && groups.data.total).toBe(1);
      const many = new Blob([
        JSON.stringify({
          log: {
            entries: Array.from({ length: 20 }, (_, id) => ({
              request: { method: 'GET', url: `https://example.test/items?q=${id}`, headers: [] },
              response: {
                status: 200,
                headers: [],
                content: {
                  mimeType: 'application/json',
                  text: JSON.stringify({ id, state: String.fromCodePoint(97 + id) }),
                },
              },
            })),
          },
        }),
      ]);
      await send({ type: 'import', file: many });
      const page = await send({
        type: 'groups',
        kind: 'outcomes',
        page: 1,
        pageSize: 3,
        search: '',
      });
      expect(page.type).toBe('groups');
      if (page.type === 'groups') {
        expect(page.data.total).toBe(20);
        expect(page.data.rows.map((group) => group.representative)).toEqual([3, 4, 5]);
        const members = await send({
          type: 'members',
          group: page.data.rows[0].endpoint,
          kind: 'endpoints',
          page: 0,
          pageSize: 3,
          search: '',
          status: '',
          anchor: 12,
        });
        expect(members.type === 'members' && members.data.page).toBe(4);
      }
      const correlations = new Blob([
        JSON.stringify({
          log: {
            entries: ['allow', 'deny'].map((value) => ({
              request: { method: 'GET', url: 'https://example.test/', headers: [] },
              response: {
                status: 200,
                headers: [{ name: 'X-Correlation-ID', value }],
                content: { mimeType: 'text/plain' },
              },
            })),
          },
        }),
      ]);
      const ready = await send({ type: 'import', file: correlations });
      expect(ready.type).toBe('ready');
      const correlationGroups = await send({
        type: 'groups',
        kind: 'outcomes',
        page: 0,
        search: '',
      });
      expect(correlationGroups.type === 'groups' && correlationGroups.data.total).toBe(1);
      if (correlationGroups.type === 'groups')
        expect(correlationGroups.data.rows[0].match).toBe('inferred-noise');
      const correlationEntry = await send({ type: 'entry', id: 0 });
      expect(correlationEntry.type === 'entry' && correlationEntry.data.responseHeaders).toEqual([
        { name: 'X-Correlation-ID', value: 'allow' },
      ]);
      const consolidated = new Blob([
        JSON.stringify({
          log: {
            entries: [
              {
                method: 'POST',
                url: 'https://example.test/submit?q=one',
                headers: [{ name: 'Cookie', value: 'sid=wire-111' }],
                postData: { mimeType: 'application/x-www-form-urlencoded', text: 'q=wire-111' },
              },
              {
                method: 'POST',
                url: 'https://example.test/submit?q=two',
                headers: [],
                cookies: [{ name: 'sid', value: 'exported-222' }],
                postData: {
                  mimeType: 'application/x-www-form-urlencoded',
                  params: [{ name: 'q', value: 'exported-222' }],
                },
              },
            ].map((request) => ({
              request,
              response: {
                status: 200,
                headers: [],
                content: { mimeType: 'text/plain', text: 'accepted' },
              },
            })),
          },
        }),
      ]);
      expect((await send({ type: 'import', file: consolidated })).type).toBe('ready');
      const consolidatedChanges = await send({ type: 'request-changes', id: 1 });
      expect(consolidatedChanges.type).toBe('request-changes');
      if (consolidatedChanges.type === 'request-changes')
        expect(
          consolidatedChanges.data.changes
            .filter((c) => c.key === 'q' || c.key === 'sid' || c.key === '/q/0/value')
            .map((c) => [c.kind, c.key, c.examples.map((e) => e.value)]),
        ).toEqual([
          ['Query', 'q', ['["one"]', '["two"]']],
          ['Form', '/q/0/value', ['wire-111', 'exported-222']],
          ['Cookie', 'sid', ['["wire-111"]', '["exported-222"]']],
        ]);
      const exportedEntry = await send({ type: 'entry', id: 1 });
      expect(exportedEntry.type === 'entry' && exportedEntry.data.diagnostics).toContain(
        'Request form fields use HAR parameters. Body text was not captured.',
      );
      expect(await send({ type: 'entry', id: -1 })).toMatchObject({
        type: 'error',
        code: 'INVALID_ARGUMENT',
      });
      expect(await send({ type: 'import', file: new Blob(['{bad']) })).toMatchObject({
        type: 'error',
        code: 'INVALID_HAR',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
