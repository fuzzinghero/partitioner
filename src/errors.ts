/** Stable operation failures. Messages never include capture contents or abort reasons. */
export type HarErrorCode =
  | 'INVALID_HAR'
  | 'INVALID_OPTIONS'
  | 'INVALID_ARGUMENT'
  | 'LIMIT_EXCEEDED'
  | 'SOURCE_CHANGED'
  | 'ABORTED'
  | 'DISPOSED'
  | 'NOT_READY'
  | 'QUEUE_FULL'
  | 'WORKER_UNAVAILABLE'
  | 'WORKER_FAILED'
  | 'INTERNAL_ERROR';

export class HarError extends Error {
  readonly code: HarErrorCode;

  constructor(message: string, code: HarErrorCode = 'INVALID_HAR') {
    super(message);
    this.code = code;
    this.name = 'HarError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal === undefined) return;
  if (
    !signal ||
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function' ||
    typeof signal.removeEventListener !== 'function'
  ) {
    throw new HarError('Invalid cancellation signal.', 'INVALID_OPTIONS');
  }
  if (signal.aborted) throw new HarError('Analysis was cancelled.', 'ABORTED');
}
