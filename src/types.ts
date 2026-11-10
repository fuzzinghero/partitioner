import type { RequestIndex } from './request-index.js';

export interface CaptureOptions {
  /** Per-capture overrides of the host's default processing budgets. */
  limits?: Partial<Limits>;
  /** Disjoint groups of zero-based HAR entry IDs to treat as related. No baseline is implied. */
  contexts?: readonly (readonly number[])[];
}
export interface AnalysisProgress {
  done: number;
  total: number;
  entries: number;
}
export interface AnalyzeOptions extends CaptureOptions {
  /** Cooperative cancellation in core; terminates an in-progress browser import. */
  signal?: AbortSignal;
  onProgress?: (progress: AnalysisProgress) => void;
}
export interface Limits {
  /** Input admission limit in bytes; null lets the host accept any file size. */
  fileBytes: number | null;
  /** Maximum entries in the capture, including entries that cannot be analyzed. */
  entries: number;
  /** Maximum decoded bytes per body eligible for hashing and interpretation. */
  bodyBytes: number;
  /** Retained text/preview budget in UTF-8 bytes; complete hashes survive text eviction. */
  totalBodyBytes: number;
  /** Estimated retained entry metadata, not a measured JavaScript heap limit. */
  metadataBytes: number;
  /** Maximum nesting and token count for the streamed HAR JSON document. */
  jsonDepth: number;
  jsonTokens: number;
  /** Per-body canonicalization depth and work limits. Format-specific guards also apply. */
  shapeDepth: number;
  shapeNodes: number;
  /** Canonicalization work shared across all bodies in the capture. */
  totalShapeNodes: number;
  /** Maximum retained items in each headers, query, or HAR form-parameter array. */
  headers: number;
  /** Maximum UTF-8 bytes in a captured header/query list. */
  headerBytes: number;
  /** Maximum UTF-16 code units in a captured metadata field. */
  fieldChars: number;
}
const MiB = 1024 * 1024;
export const LIMITS: Readonly<Limits> = Object.freeze({
  fileBytes: null,
  entries: 100000,
  bodyBytes: 2 * MiB,
  totalBodyBytes: 32 * MiB,
  metadataBytes: 96 * MiB,
  jsonDepth: 64,
  jsonTokens: 50000000,
  shapeDepth: 32,
  shapeNodes: 20000,
  totalShapeNodes: 10000000,
  headers: 200,
  headerBytes: 64 * 1024,
  fieldChars: 8192,
});
export const PAGE_ROWS = 50;
export const MAX_PAGE_ROWS = 1000;
export const PREVIEW_CHARS = 16384;
export const DIFF_LIMITS = {
  bytes: 64 * 1024,
  nodes: 10000,
  depth: 32,
  changes: 200,
  lines: 400,
  cells: 160000,
};
export interface Header {
  name: string;
  value: string;
}
export type BodyState = 'text' | 'binary' | 'missing' | 'limited' | 'invalid';
export interface Body {
  state: BodyState;
  text?: string;
  /** SHA-256 of complete decoded bytes, never a prefix or preview. */
  hash?: string;
  bytes?: number;
  reason?: string;
  /** Value-preserving canonical fingerprint. This is not a schema-only hash. */
  shape?: string;
  shapeKind?: string;
  shapeWarning?: string;
  /** Complete text was dropped to meet retention limits and may be reread from the source. */
  evicted?: boolean;
  /** Display-only prefix of a body excluded from complete-body analysis. */
  preview?: string;
  previewDeferred?: boolean;
  displayTruncated?: boolean;
}
export interface Entry {
  /** Zero-based position in log.entries, preserved even when an entry is skipped. */
  id: number;
  method: string;
  /** False excludes the displayed method placeholder/malformed value from request evidence. */
  requestMethodAvailable?: boolean;
  url: string;
  requestUrlAvailable?: boolean;
  /** Internal context target reconstructed from captured origin evidence; url remains literal. */
  contextUrl?: string;
  /** Null means unavailable; zero remains a captured HAR status. */
  status: number | null;
  mime: string;
  responseMimeAvailable?: boolean;
  /** Internal guard: contradictory MIME evidence cannot justify semantic comparison. */
  responseMimeAmbiguous?: boolean;
  diagnostics?: string[];
  transportError?: string;
  transportErrorUnavailable?: boolean;
  requestHttpVersion?: string;
  responseHttpVersion?: string;
  statusText?: string;
  time: number | null;
  reportedSize: number | null;
  responseHeaderFingerprint?: string;
  responseHeadersAvailable?: boolean;
  requestHeadersHash?: string;
  requestHeaders: Header[];
  responseHeaders: Header[];
  query: Header[];
  /** Reported HAR request body size in bytes; absent when unavailable. */
  requestBodySize?: number;
  requestBody: Body;
  body: Body;
  /** Context ID and response-partition ID within this analysis. Treat both as opaque. */
  endpoint: string;
  outcome: string;
  skipped?: string;
  family?: string;
  /** Byte range in the original HAR, with an exclusive end, for deferred reads. */
  sourceStart?: number;
  sourceEnd?: number;
}
export type NormalizationRule =
  | 'response-telemetry'
  | 'response-headers'
  | 'cookie-rotation'
  | 'detected-json'
  | 'xml-attributes';
export interface Group {
  /** Evidence used for grouping. Inferred reflection remains a heuristic. */
  match?:
    | 'exact'
    | 'canonical'
    | 'inferred-reflection'
    | 'inferred-noise'
    | 'metadata-only'
    | 'unavailable';
  normalizations?: NormalizationRule[];
  mixed?: boolean;
  number?: number;
  id: string;
  label: string;
  members: number[];
  /** Number of response partitions in a context; zero on response-partition groups. */
  variants: number;
  status?: number | null;
  mime?: string;
  minBytes: number | null;
  maxBytes: number | null;
  minTime: number | null;
  maxTime: number | null;
  representative: number;
}
export interface Summary {
  /** Reflection work is independent of query retention. Counts are entries skipped by each budget. */
  reflection?: {
    work: number;
    entryLimited: number;
    captureLimited: number;
    candidateLimited: number;
    fingerprinted: number;
  };
  /** Effective core limits used for this capture, including host overrides. */
  limits?: Readonly<Limits>;
  total: number;
  analyzed: number;
  skipped: number;
  missing: number;
  truncated: number;
  binary: number;
  invalid: number;
  shapeLimited: number;
  retainedBytes: number;
  deferred: number;
  metadataEstimate: number;
  elapsedMs: number;
  warnings: string[];
}
export interface Analysis {
  requestIndex?: RequestIndex;
  entries: Entry[];
  /** Related request contexts, which may include multiple URLs or HTTP methods. */
  endpoints: Group[];
  /** Response partitions belonging to those contexts. */
  outcomes: Group[];
  summary: Summary;
}
export interface EntryRow {
  id: number;
  method: string;
  url: string;
  status: number | null;
  mime: string;
  time: number | null;
  bytes?: number;
  bodyState: BodyState;
  skipped?: string;
}
export interface GroupRow extends Omit<Group, 'members'> {
  count: number;
  endpoint: string;
  method: string;
  url: string;
  scope?: string;
  scopeMethod?: string;
}
export interface Page<T> {
  /** Effective page size; omitted only by older producers. */
  pageSize?: number;
  rows: T[];
  total: number;
  page: number;
}
export interface Change {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  reference?: string;
  comparison?: string;
}
export interface Comparison {
  reference: number;
  comparison: number;
  metadata: Change[];
  headers: Change[];
  body: { kind: string; message: string; changes: Change[]; limited: boolean };
}

/** Customer categories; parser bookkeeping and evidence provenance remain internal. */
export type RequestChangeKind =
  | 'Path'
  | 'Query'
  | 'JSON'
  | 'XML'
  | 'Form'
  | 'Multipart'
  | 'Endpoint'
  | 'Header'
  | 'Cookie'
  | 'Body'
  | 'Protocol';

export interface RequestChange {
  /** Opaque field identity; use for selection instead of customer labels or keys. */
  id: string;
  affected?: number;
  distinctValues?: number;
  inference?: 'deviation' | 'variation';
  kind: RequestChangeKind;
  key: string;
  /** Parent containers for JSON Pointer segments; unknown when captured shapes disagree. */
  pathTypes?: ('object' | 'array' | 'unknown')[];
  present: number;
  compared: number;
  moreValues: boolean;
  examples: {
    entry: number;
    count: number;
    value: string;
    truncated: boolean;
    state?: 'empty-body';
  }[];
}
export interface RequestContrast {
  reference: number;
  comparison: number;
  responseChanged: boolean;
  /** Observational differences cannot establish which mutation caused a response. */
  causal: false;
  complete: boolean;
  changes: {
    id: string;
    kind: RequestChangeKind;
    key: string;
    observed?: string;
    reference?: string;
    truncated: boolean;
  }[];
}
export interface RequestChanges {
  /** Exporter body metadata and captured Content-Type headers disagree in this cohort. */
  contentTypeConflict?: boolean;
  /** Readable structural differences; parser bookkeeping is not an input field. */
  notices?: string[];
  contrasts?: RequestContrast[];
  /** Candidate selection reached a work or source-reread limit; returned examples remain valid. */
  contrastsLimited?: boolean;
  method?: string;
  partitionEntries?: number;
  methodCount?: number;
  methods?: { method: string; count: number; entry: number }[];
  /** Selected-request differences against common field values, not a single baseline request. */
  current?: {
    entry: number;
    changes: {
      id: string;
      kind: RequestChangeKind;
      key: string;
      observed?: string;
      reference?: string;
      inference: 'deviation' | 'variation';
      pathTypes?: ('object' | 'array' | 'unknown')[];
      truncated: boolean;
    }[];
  };
  endpoint: string;
  entries: number;
  cohortEntries?: number;
  changes: RequestChange[];
  /** Count of unavailable/limited evidence encountered; this is not a count of requests. */
  incomplete: number;
}
