import { resolveLimits, fileLimitMessage } from './limits.js';
import { HarError, throwIfAborted } from './errors.js';
import type { HarErrorCode } from './errors.js';
import type { Summary, AnalyzeOptions, Limits, AnalysisProgress } from './types.js';
import type { Command, DataReply, Reply, Request, ReplyFor } from './protocol.js';

export interface AnalyzerSnapshot {
  status: 'idle' | 'processing' | 'ready' | 'error';
  summary: Summary | null;
  progress: AnalysisProgress | null;
  error: string;
  errorCode?: HarErrorCode;
}
// Keep shared declarations usable in Node projects that do not include DOM types.
type HostWorker = typeof globalThis extends { Worker: { prototype: infer W } } ? W : never;

export interface AnalyzerOptions {
  /** Host defaults; per-import limits override individual fields. */
  limits?: Partial<Limits>;
  /** Optional worker construction override for an alternative host/bundler or tests. */
  createWorker?: () => HostWorker;
}
export interface OperationOptions {
  /** Cancels the caller's wait. Sent query work keeps its queue slot until it settles. */
  signal?: AbortSignal;
}
export interface GroupQuery extends OperationOptions {
  page?: number;
  pageSize?: number;
  search?: string;
  context?: string;
  status?: number | string | null;
}
export interface MemberQuery extends OperationOptions {
  kind?: 'contexts' | 'partitions';
  page?: number;
  pageSize?: number;
  search?: string;
  status?: number | string | null;
  anchor?: number;
  method?: string;
}
type Pending = {
  type: DataReply['type'];
  resolve: (value: DataReply) => void;
  reject: (error: HarError) => void;
  cleanup: () => void;
  settled: boolean;
};
const emptySnapshot = (): AnalyzerSnapshot => ({
  status: 'idle',
  summary: null,
  progress: null,
  error: '',
  errorCode: undefined,
});
const defaultWorker = () =>
  new Worker(new URL('./har.worker.js', import.meta.url), { type: 'module' });
const cancelled = () => new HarError('Analysis was cancelled.', 'ABORTED');

/** Owns a capture and its worker. The typed methods reject; legacy methods resolve null on failure. */
export class AnalyzerClient {
  private worker: Worker | null = null;
  private generation = 0;
  private sequence = 0;
  private ready = false;
  private disposed = false;
  private pending = new Map<number, Pending>();
  private listeners = new Set<() => void>();
  private snapshot = emptySnapshot();
  constructor(private readonly options: AnalyzerOptions = {}) {}
  getSnapshot = (): AnalyzerSnapshot => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(value: Partial<AnalyzerSnapshot>) {
    this.snapshot = { ...this.snapshot, ...value };
    this.listeners.forEach((listener) => listener());
  }
  private release(error = cancelled()) {
    this.generation++;
    this.ready = false;
    const worker = this.worker;
    this.worker = null;
    try {
      worker?.terminate();
    } catch {
      /* Still settle callers if a host worker fails to terminate. */
    }
    for (const pending of this.pending.values()) {
      pending.cleanup();
      if (!pending.settled) pending.reject(error);
    }
    this.pending.clear();
  }
  private fail(error: HarError) {
    this.release(error);
    this.update({
      status: 'error',
      error: error.message,
      errorCode: error.code,
      summary: null,
      progress: null,
    });
  }
  private send(command: Command, signal?: AbortSignal): Promise<DataReply> {
    if (this.disposed) return Promise.reject(new HarError('The analyzer is disposed.', 'DISPOSED'));
    if (!this.worker) return Promise.reject(new HarError('Import a capture first.', 'NOT_READY'));
    if (signal?.aborted) {
      if (command.type === 'import' || command.type === 'sample') this.cancel();
      return Promise.reject(cancelled());
    }
    if (this.pending.size >= 32)
      return Promise.reject(new HarError('The query queue is full.', 'QUEUE_FULL'));
    const seq = ++this.sequence;
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (command.type === 'import' || command.type === 'sample') {
          this.cancel();
          return;
        }
        const pending = this.pending.get(seq);
        if (!pending || pending.settled) return;
        pending.settled = true;
        pending.cleanup();
        reject(cancelled());
        // Keep the slot: cancelling a wait cannot grow the worker's queue without bound.
      };
      const pending: Pending = {
        type: command.type === 'import' || command.type === 'sample' ? 'ready' : command.type,
        resolve,
        reject,
        settled: false,
        cleanup: () => signal?.removeEventListener('abort', abort),
      };
      this.pending.set(seq, pending);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.worker!.postMessage({ ...command, seq } satisfies Request);
      } catch {
        this.fail(
          new HarError(
            'The worker could not accept this operation. Please reimport the HAR.',
            'WORKER_FAILED',
          ),
        );
      }
    });
  }
  private query<C extends Command>(command: C, signal?: AbortSignal): Promise<ReplyFor<C>> {
    if (this.disposed) return Promise.reject(new HarError('The analyzer is disposed.', 'DISPOSED'));
    try {
      throwIfAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!this.ready) return Promise.reject(new HarError('Import a capture first.', 'NOT_READY'));
    // The pending record checks the reply discriminator before resolving.
    return this.send(command, signal) as Promise<ReplyFor<C>>;
  }
  private begin(
    source: { type: 'import'; file: Blob } | { type: 'sample' },
    options: AnalyzeOptions = {},
  ): Promise<DataReply> {
    if (this.disposed) return Promise.reject(new HarError('The analyzer is disposed.', 'DISPOSED'));
    const file = source.type === 'import' ? source.file : null;
    let limits: Limits;
    try {
      throwIfAborted(options.signal);
      if (
        source.type === 'import' &&
        (!file ||
          typeof file.size !== 'number' ||
          !Number.isFinite(file.size) ||
          file.size < 0 ||
          typeof file.slice !== 'function')
      )
        throw new HarError('Select a HAR file to analyze.', 'INVALID_ARGUMENT');
      if (options.onProgress !== undefined && typeof options.onProgress !== 'function') {
        throw new HarError('Invalid progress callback.', 'INVALID_OPTIONS');
      }
      limits = resolveLimits(this.options.limits, options.limits);
      if (file && limits.fileBytes !== null && file.size > limits.fileBytes) {
        throw new HarError(fileLimitMessage(limits.fileBytes), 'LIMIT_EXCEEDED');
      }
    } catch (error) {
      const failure =
        error instanceof HarError
          ? error
          : new HarError('Invalid analysis options.', 'INVALID_OPTIONS');
      if (failure.code !== 'ABORTED') this.fail(failure);
      return Promise.reject(failure);
    }
    this.release();
    const current = this.generation;
    this.update(emptySnapshot());
    if (current !== this.generation) return Promise.reject(cancelled());
    let progressListener = options.onProgress;
    try {
      const next = (this.options.createWorker ?? defaultWorker)();
      if (current !== this.generation) {
        next.terminate();
        return Promise.reject(cancelled());
      }
      this.worker = next;
      next.onmessage = (event: MessageEvent<Reply>) => {
        if (this.generation !== current) return;
        const reply = event.data;
        if (reply.type === 'progress') {
          const progress = { done: reply.done, total: reply.total, entries: reply.entries };
          this.update({ progress });
          if (this.generation === current) {
            try {
              progressListener?.(progress);
            } catch {
              this.fail(new HarError('The progress callback failed.', 'INTERNAL_ERROR'));
            }
          }
          return;
        }
        const pending = this.pending.get(reply.seq);
        if (!pending) return;
        this.pending.delete(reply.seq);
        pending.cleanup();
        if (pending.settled) return;
        if (reply.type === 'error') {
          const error = new HarError(reply.message, reply.code ?? 'INTERNAL_ERROR');
          pending.reject(error);
          if (!this.ready) this.fail(error);
          else this.update({ error: error.message, errorCode: error.code });
          return;
        }
        if (reply.type !== pending.type) {
          const error = new HarError(
            'Unexpected worker reply. Reimport the capture.',
            'WORKER_FAILED',
          );
          pending.reject(error);
          this.fail(error);
          return;
        }
        if (reply.type === 'ready') {
          this.ready = true;
          progressListener = undefined;
          pending.resolve(reply);
          this.update({ status: 'ready', summary: reply.summary, progress: null });
        } else pending.resolve(reply);
      };
      next.onerror = (event) => {
        event.preventDefault();
        if (this.generation !== current) return;
        this.fail(
          new HarError(
            'The analysis worker failed. Try a smaller HAR or a supported browser.',
            'WORKER_FAILED',
          ),
        );
      };
      next.onmessageerror = () => {
        if (this.generation !== current) return;
        this.fail(
          new HarError('Worker communication failed. Reimport the capture.', 'WORKER_FAILED'),
        );
      };
      this.update({
        status: 'processing',
        progress: { done: 0, total: file?.size ?? 0, entries: 0 },
      });
      if (current !== this.generation) return Promise.reject(cancelled());
      return this.send(
        source.type === 'import'
          ? { ...source, limits, contexts: options.contexts }
          : { type: 'sample', limits },
        options.signal,
      );
    } catch {
      const error = new HarError(
        'A dedicated Web Worker is required. Check browser support and the site’s worker policy.',
        'WORKER_UNAVAILABLE',
      );
      this.fail(error);
      return Promise.reject(error);
    }
  }

  /** Import a capture and resolve its summary. AbortSignal only applies to this import. */
  analyze = async (file: Blob, options?: AnalyzeOptions): Promise<Summary> => {
    const reply = await this.begin({ type: 'import', file }, options);
    if (reply.type !== 'ready') throw new HarError('Unexpected import reply.', 'WORKER_FAILED');
    return reply.summary;
  };
  getPartitions = async (options: GroupQuery = {}) =>
    (
      await this.query(
        {
          type: 'groups',
          kind: 'outcomes',
          page: options.page ?? 0,
          pageSize: options.pageSize,
          search: options.search ?? '',
          endpoint: options.context,
          status: options.status === undefined ? '' : String(options.status),
        },
        options.signal,
      )
    ).data;
  getContexts = async (options: GroupQuery = {}) =>
    (
      await this.query(
        {
          type: 'groups',
          kind: 'endpoints',
          page: options.page ?? 0,
          pageSize: options.pageSize,
          search: options.search ?? '',
          endpoint: options.context,
          status: options.status === undefined ? '' : String(options.status),
        },
        options.signal,
      )
    ).data;
  getMembers = async (group: string, options: MemberQuery = {}) =>
    (
      await this.query(
        {
          type: 'members',
          group,
          kind: options.kind === 'contexts' ? 'endpoints' : 'outcomes',
          page: options.page ?? 0,
          pageSize: options.pageSize,
          search: options.search ?? '',
          status: options.status === undefined ? '' : String(options.status),
          anchor: options.anchor,
          method: options.method,
        },
        options.signal,
      )
    ).data;
  getEntry = async (id: number, options?: OperationOptions) =>
    (await this.query({ type: 'entry', id }, options?.signal)).data;
  getRequestChanges = async (id: number, options?: OperationOptions) =>
    (await this.query({ type: 'request-changes', id }, options?.signal)).data;
  compare = async (reference: number, comparison: number, options?: OperationOptions) =>
    (await this.query({ type: 'compare', reference, comparison }, options?.signal)).data;

  /** Compatibility interface: failures resolve null and details remain in the snapshot. */
  request = <C extends Command>(command: C): Promise<ReplyFor<C> | null> => {
    const operation =
      command.type === 'import' || command.type === 'sample'
        ? this.begin(
            command.type === 'import' ? { type: 'import', file: command.file } : { type: 'sample' },
            {
              limits: command.limits,
              ...(command.type === 'import' ? { contexts: command.contexts } : {}),
            },
          )
        : this.query(command);
    return operation.catch(() => null) as Promise<ReplyFor<C> | null>;
  };
  start = (file: Blob | null, contexts?: AnalyzeOptions['contexts'], limits?: Partial<Limits>) => {
    if (this.disposed) return;
    return this.begin(file === null ? { type: 'sample' } : { type: 'import', file }, {
      contexts,
      limits,
    }).catch(() => null);
  };
  importFile = (file: Blob, options?: AnalyzeOptions) => {
    if (this.disposed) return;
    return this.begin({ type: 'import', file }, options).catch(() => null);
  };
  loadSample = () => this.start(null);
  cancel = () => {
    this.release();
    this.update(emptySnapshot());
  };
  dispose = () => {
    this.disposed = true;
    this.release(new HarError('The analyzer is disposed.', 'DISPOSED'));
    this.update(emptySnapshot());
    this.listeners.clear();
  };
}
export const createAnalyzer = (options?: AnalyzerOptions) => new AnalyzerClient(options);

/** @deprecated Use AnalyzerClient. */
export { AnalyzerClient as HarAnalyzerClient };
/** @deprecated Use createAnalyzer. */
export const createHarAnalyzer = createAnalyzer;
