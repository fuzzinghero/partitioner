// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createAnalyzer } from './client.js';
import type { Summary } from './types.js';
import type { Reply, Request } from './protocol.js';

const summary: Summary = {
  total: 100,
  analyzed: 100,
  skipped: 0,
  missing: 0,
  truncated: 0,
  binary: 0,
  invalid: 0,
  shapeLimited: 0,
  retainedBytes: 100,
  deferred: 0,
  metadataEstimate: 1000,
  elapsedMs: 10,
  warnings: [],
};
function workerStub() {
  const stub = {
    onmessage: null as Worker['onmessage'],
    onerror: null as Worker['onerror'],
    onmessageerror: null as Worker['onmessageerror'],
    messages: [] as Request[],
    postMessage: vi.fn((message: Request) => {
      stub.messages.push(message);
    }),
    terminate: vi.fn(),
  };
  const port = stub as unknown as Worker;
  return {
    stub,
    port,
    emit: (data: Reply) => {
      stub.onmessage?.call(port, { data } as MessageEvent);
    },
  };
}

describe('framework-free HAR processing client', () => {
  it.each([undefined, null, false, 0, '', {}])(
    'rejects invalid file input %j before constructing a worker',
    async (file) => {
      const createWorker = vi.fn(() => {
        throw new Error('Unexpected worker creation');
      });
      const client = createAnalyzer({ createWorker });
      try {
        await expect(client.analyze(file as Blob)).rejects.toMatchObject({
          code: 'INVALID_ARGUMENT',
        });
        expect(createWorker).not.toHaveBeenCalled();
        expect(await client.importFile(file as Blob)).toBeNull();
        expect(client.getSnapshot().errorCode).toBe('INVALID_ARGUMENT');
      } finally {
        client.dispose();
      }
    },
  );
  it('passes an immutable file handle to the worker and exposes progress/results without reading it', () => {
    const worker = workerStub(),
      client = createAnalyzer({ createWorker: () => worker.port });
    const file = new Blob(['synthetic']);
    const read = vi.spyOn(file, 'arrayBuffer');
    const notify = vi.fn();
    const unsubscribe = client.subscribe(notify);
    client.importFile(file);
    expect(worker.stub.messages[0]).toMatchObject({ type: 'import', file, seq: 1 });
    expect(read).not.toHaveBeenCalled();
    expect(client.getSnapshot().status).toBe('processing');
    worker.emit({ type: 'progress', done: 5, total: 9, entries: 1 });
    expect(client.getSnapshot().progress).toEqual({ done: 5, total: 9, entries: 1 });
    worker.emit({ type: 'ready', summary, seq: 1 });
    expect(client.getSnapshot()).toMatchObject({ status: 'ready', summary, progress: null });
    expect(notify).toHaveBeenCalled();
    unsubscribe();
    client.dispose();
  });
  it('terminates replaced/cancelled captures, resolves pending queries, and ignores stale replies', async () => {
    const first = workerStub(),
      second = workerStub();
    let created = 0;
    const client = createAnalyzer({
      createWorker: () => (++created === 1 ? first.port : second.port),
    });
    client.loadSample();
    first.emit({ type: 'ready', summary, seq: 1 });
    const pending = client.request({ type: 'entry', id: 1 });
    const stale = first.stub.onmessage;
    client.importFile(new Blob(['replacement']));
    expect(first.stub.terminate).toHaveBeenCalledOnce();
    expect(await pending).toBeNull();
    stale?.call(first.port, { data: { type: 'ready', summary, seq: 1 } } as MessageEvent);
    expect(client.getSnapshot().status).toBe('processing');
    expect(client.getSnapshot().summary).toBeNull();
    client.cancel();
    expect(second.stub.terminate).toHaveBeenCalledOnce();
    expect(client.getSnapshot().status).toBe('idle');
  });
  it('rejects oversize files before worker creation and sanitizes construction/browser errors', () => {
    const createWorker = vi.fn(() => {
      throw new Error('capture_secret');
    });
    const client = createAnalyzer({ createWorker, limits: { fileBytes: 1024 ** 3 } });
    client.importFile(Object.defineProperty(new Blob(), 'size', { value: 1024 ** 3 + 1 }));
    expect(createWorker).not.toHaveBeenCalled();
    expect(client.getSnapshot().error).toContain('1,073,741,824 bytes');
    client.loadSample();
    expect(client.getSnapshot().error).not.toContain('capture_secret');
    const worker = workerStub(),
      failed = createAnalyzer({ createWorker: () => worker.port });
    failed.loadSample();
    const event = { preventDefault: vi.fn(), message: 'capture_secret' } as unknown as ErrorEvent;
    worker.stub.onerror?.call(worker.port, event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(failed.getSnapshot().error).not.toContain('capture_secret');
    expect(worker.stub.terminate).toHaveBeenCalledOnce();
  });
  it('bounds pending operations and releases every pending query on dispose', async () => {
    const worker = workerStub(),
      client = createAnalyzer({ createWorker: () => worker.port });
    client.loadSample();
    worker.emit({ type: 'ready', summary, seq: 1 });
    const pending = Array.from({ length: 32 }, () => client.request({ type: 'entry', id: 0 }));
    expect(await client.request({ type: 'entry', id: 0 })).toBeNull();
    expect(worker.stub.messages).toHaveLength(33);
    client.dispose();
    expect(await Promise.all(pending)).toEqual(Array(32).fill(null));
    client.loadSample();
    expect(worker.stub.messages).toHaveLength(33);
  });
  it('releases the capture on postMessage failure and communication decoding errors', async () => {
    const worker = workerStub(),
      client = createAnalyzer({ createWorker: () => worker.port });
    client.loadSample();
    worker.emit({ type: 'ready', summary, seq: 1 });
    worker.stub.postMessage.mockImplementationOnce(() => {
      throw new Error('capture_secret');
    });
    expect(await client.request({ type: 'entry', id: 0 })).toBeNull();
    expect(client.getSnapshot()).toMatchObject({ status: 'error', summary: null, progress: null });
    expect(client.getSnapshot().error).not.toContain('capture_secret');
    const other = workerStub(),
      second = createAnalyzer({ createWorker: () => other.port });
    second.loadSample();
    other.stub.onmessageerror?.call(other.port, {} as MessageEvent);
    expect(second.getSnapshot().status).toBe('error');
    expect(other.stub.terminate).toHaveBeenCalledOnce();
  });
  it('does not reopen a disposed client through a reentrant subscription callback', () => {
    const worker = workerStub(),
      createWorker = vi.fn(() => worker.port),
      client = createAnalyzer({ createWorker });
    client.loadSample();
    client.subscribe(() => {
      if (client.getSnapshot().status === 'idle') client.loadSample();
    });
    client.dispose();
    expect(createWorker).toHaveBeenCalledOnce();
    expect(worker.stub.terminate).toHaveBeenCalledOnce();
  });
  it('routes public reimports through capture lifecycle and settles a failed replacement', async () => {
    const first = workerStub(),
      second = workerStub();
    let count = 0;
    const client = createAnalyzer({
      createWorker: () => (++count === 1 ? first.port : second.port),
    });
    client.loadSample();
    first.emit({ type: 'ready', summary, seq: 1 });
    const pending = client.request({
      type: 'import',
      file: new Blob(['invalid']),
      contexts: [[0]],
    });
    expect(client.getSnapshot().status).toBe('processing');
    expect(client.getSnapshot().summary).toBeNull();
    expect(second.stub.messages[0]).toMatchObject({ contexts: [[0]] });
    second.emit({ type: 'error', message: 'Malformed HAR JSON.', seq: 2 });
    expect(await pending).toBeNull();
    expect(client.getSnapshot().status).toBe('error');
    expect(await client.request({ type: 'entry', id: 0 })).toBeNull();
    client.dispose();
  });

  it('lets callers choose file caps and forwards merged budgets for each capture', () => {
    const worker = workerStub(),
      client = createAnalyzer({
        createWorker: () => worker.port,
        limits: { fileBytes: 100, bodyBytes: 16 },
      });
    client.importFile(Object.defineProperty(new Blob(), 'size', { value: 101 }));
    expect(worker.stub.messages).toHaveLength(0);
    expect(client.getSnapshot().error).toContain('100 bytes');
    client.importFile(Object.defineProperty(new Blob(), 'size', { value: 2 * 1024 ** 3 }), {
      limits: { fileBytes: 3 * 1024 ** 3, totalBodyBytes: 0 },
    });
    expect(worker.stub.messages[0]).toMatchObject({
      type: 'import',
      limits: { fileBytes: 3 * 1024 ** 3, bodyBytes: 16, totalBodyBytes: 0 },
    });
    client.request({
      type: 'import',
      file: Object.defineProperty(new Blob(), 'size', { value: 8 * 1024 ** 3 }),
      limits: { fileBytes: null },
    });
    expect(worker.stub.messages.at(-1)).toMatchObject({
      limits: { fileBytes: null, bodyBytes: 16 },
    });
    client.dispose();
    const uncapped = workerStub(),
      defaultClient = createAnalyzer({ createWorker: () => uncapped.port });
    defaultClient.importFile(Object.defineProperty(new Blob(), 'size', { value: 8 * 1024 ** 3 }));
    expect(uncapped.stub.messages).toHaveLength(1);
    defaultClient.dispose();
  });
});

describe('typed customer API', () => {
  it('returns summaries and page data directly without forwarding callbacks or signals', async () => {
    const worker = workerStub();
    const client = createAnalyzer({ createWorker: () => worker.port });
    const progress = vi.fn();
    const signal = new AbortController().signal;
    const imported = client.analyze(new Blob(['capture']), {
      signal,
      onProgress: progress,
      contexts: [[0]],
    });
    expect(worker.stub.messages[0]).toMatchObject({ type: 'import', contexts: [[0]] });
    expect(Object.keys(worker.stub.messages[0])).not.toContain('signal');
    expect(Object.keys(worker.stub.messages[0])).not.toContain('onProgress');
    worker.emit({ type: 'progress', done: 1, total: 7, entries: 1 });
    expect(progress).toHaveBeenCalledWith({ done: 1, total: 7, entries: 1 });
    worker.emit({ type: 'ready', summary, seq: 1 });
    expect(await imported).toBe(summary);
    const groups = client.getPartitions({ pageSize: 7, search: 'JSON' });
    expect(worker.stub.messages[1]).toMatchObject({
      type: 'groups',
      kind: 'outcomes',
      page: 0,
      pageSize: 7,
      search: 'JSON',
    });
    const page = { rows: [], total: 0, page: 0, pageSize: 7 };
    worker.emit({ type: 'groups', data: page, seq: 2 });
    expect(await groups).toBe(page);
    client.dispose();
  });

  it('distinguishes unavailable state, worker operation failures and disposal', async () => {
    const worker = workerStub();
    const client = createAnalyzer({ createWorker: () => worker.port });
    await expect(client.getEntry(0)).rejects.toMatchObject({ code: 'NOT_READY' });
    const imported = client.analyze(new Blob(['capture']));
    worker.emit({ type: 'ready', summary, seq: 1 });
    await imported;
    const invalid = client.getEntry(-1);
    worker.emit({ type: 'error', code: 'INVALID_ARGUMENT', message: 'Entry unavailable.', seq: 2 });
    await expect(invalid).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(client.getSnapshot().status).toBe('ready');
    client.dispose();
    await expect(client.getPartitions()).rejects.toMatchObject({ code: 'DISPOSED' });
  });

  it('cancels an importing capture without exposing its abort reason', async () => {
    const worker = workerStub();
    const client = createAnalyzer({ createWorker: () => worker.port });
    const controller = new AbortController();
    const imported = client.analyze(new Blob(['capture']), { signal: controller.signal });
    controller.abort('capture_secret');
    await expect(imported).rejects.toMatchObject({
      code: 'ABORTED',
      message: 'Analysis was cancelled.',
    });
    expect(worker.stub.terminate).toHaveBeenCalledOnce();
    expect(client.getSnapshot().status).toBe('idle');
    client.dispose();
  });

  it('keeps cancelled query slots occupied until their worker work settles', async () => {
    const worker = workerStub();
    const client = createAnalyzer({ createWorker: () => worker.port });
    const imported = client.analyze(new Blob(['capture']));
    worker.emit({ type: 'ready', summary, seq: 1 });
    await imported;
    const controllers = Array.from({ length: 32 }, () => new AbortController());
    const queries = controllers.map((controller) =>
      client.getEntry(0, { signal: controller.signal }).catch((error) => error.code),
    );
    controllers.forEach((controller) => controller.abort());
    expect(await Promise.all(queries)).toEqual(Array(32).fill('ABORTED'));
    await expect(client.getEntry(0)).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    expect(worker.stub.messages).toHaveLength(33);
    worker.emit({
      type: 'error',
      code: 'INVALID_ARGUMENT',
      message: 'Late cancelled query.',
      seq: 2,
    });
    expect(client.getSnapshot().error).toBe('');
    const available = client.getEntry(0);
    expect(worker.stub.messages).toHaveLength(34);
    client.dispose();
    await expect(available).rejects.toMatchObject({ code: 'DISPOSED' });
  });
});

it('releases an import aborted by a processing-state subscriber before the first worker message', async () => {
  const worker = workerStub();
  const client = createAnalyzer({ createWorker: () => worker.port });
  const controller = new AbortController();
  client.subscribe(() => {
    if (client.getSnapshot().status === 'processing') controller.abort();
  });
  await expect(
    client.analyze(new Blob(['capture']), { signal: controller.signal }),
  ).rejects.toMatchObject({ code: 'ABORTED' });
  expect(client.getSnapshot().status).toBe('idle');
  expect(worker.stub.postMessage).not.toHaveBeenCalled();
  expect(worker.stub.terminate).toHaveBeenCalledOnce();
  client.dispose();
});
