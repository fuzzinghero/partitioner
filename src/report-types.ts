import type { AnalyzeOptions, Group, Header, RequestChangeKind, Summary } from './types.js';

export interface ReportLimits {
  /** Per-body display limit, in UTF-16 code units. Does not change grouping. */
  bodyChars: number;
  /** Shared budget for serialized samples and variations, in UTF-16 code units. */
  evidenceChars: number;
  /** Sum of context sizes visited by variation queries. Prevents quadratic report work. */
  variationEntries: number;
  /** Shared source-byte budget for recovering evicted representative bodies. */
  rereadBytes: number;
}
export interface ReportOptions extends AnalyzeOptions {
  reportLimits?: Partial<ReportLimits>;
  /** Include operational budgets and counters separately from the readable summary. */
  diagnostics?: boolean;
}
export interface ReportBody {
  state: 'text' | 'empty' | 'missing' | 'binary' | 'limited' | 'invalid' | 'omitted';
  /** Exact captured text or a prefix, never pretty-printed or numerically coerced. */
  text?: string;
  bytes: number | null;
  /** Analysis, retention or display limits omitted some body content. */
  truncated: boolean;
  reason?: string;
}
export interface HttpExchange {
  /** Zero-based HAR position. Values in variations use the same identity. */
  entry: number;
  request: {
    method: string | null;
    url: string | null;
    httpVersion: string | null;
    /** Ordered pairs preserve duplicate headers. */
    headers: Header[];
    body: ReportBody;
  };
  response: {
    /** Null means no HTTP status was available, including HAR status zero. */
    status: number | null;
    statusText: string | null;
    contentType: string | null;
    httpVersion: string | null;
    headers: Header[];
    body: ReportBody;
    transportError?: string;
  };
  timeMs: number | null;
  warnings: string[];
}
export interface InputVariation {
  /** Opaque source identity; display categories and keys can coincide. */
  id: string;
  category: RequestChangeKind;
  /** Original field name or JSON Pointer; label is the readable display path. */
  key: string;
  label: string;
  comparedRequests: number;
  presentRequests: number;
  distinctValues: number;
  moreValues: boolean;
  values: {
    entry: number;
    requestCount: number;
    /** Repeated values stay together; JSON numbers/containers retain exact JSON text. */
    value: string | string[];
    format: 'text' | 'json' | 'values' | 'empty-body';
    truncated: boolean;
  }[];
}
export interface PartitionReport {
  id: string;
  number: number;
  requestCount: number;
  statuses: (number | null)[];
  contentTypes: (string | null)[];
  responseBytes: { min: number | null; max: number | null };
  timeMs: { min: number | null; max: number | null };
  grouping: {
    basis: NonNullable<Group['match']>;
    explanation: string;
    heuristic: boolean;
    normalizations?: Group['normalizations'];
  };
  sample: HttpExchange | null;
  sampleOmittedReason?: string;
  variations: {
    /** Observed associations, not evidence that a particular input caused a response. */
    method: string | null;
    fields: InputVariation[];
    notices: string[];
    coverage: {
      state: 'available' | 'partial' | 'omitted';
      comparedRequests: number;
      /** Evidence limitations, not a request count. */
      incompleteEvidence: number;
      reason?: string;
    };
  };
}
/** Portable data: no local handles, internal fingerprints or source offsets. */
export interface AnalysisReport {
  schemaVersion: 1;
  source: { format: 'har'; bytes: number };
  summary: {
    capturedRequests: number;
    analyzedRequests: number;
    skippedRequests: number;
    requestContexts: number;
    responsePartitions: number;
    missingResponseBodies: number;
    limitedResponseBodies: number;
    warnings: string[];
  };
  contexts: {
    id: string;
    label: string;
    methods: string[];
    requestCount: number;
    partitionCount: number;
    partitions: PartitionReport[];
  }[];
  coverage: {
    samplesIncluded: number;
    samplesOmitted: number;
    variationPartitionsIncluded: number;
    variationPartitionsOmitted: number;
    reportLimits: ReportLimits;
  };
  diagnostics?: { summary: Summary };
}
