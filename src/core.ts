import * as engine from './analyze.js';
import { HarError } from './errors.js';
import { compare as compareInternal } from './diff.js';
import {
  requestChanges as requestChangesInternal,
  requestChangesComplete as requestChangesCompleteInternal,
} from './request-analysis.js';
import type {
  Analysis as InternalAnalysis,
  Entry as InternalEntry,
  AnalyzeOptions,
  Limits,
} from './types.js';
import type { Analysis, Body, Entry } from './public-types.js';
import { createReport, reportLimits } from './report.js';
import type { ReportOptions } from './report-types.js';

// Keep grouping and replay evidence private while exposing ordinary serializable capture data.
// Core operations resolve handles returned by this module to their original bounded analysis.
const analyses = new WeakMap<Analysis, InternalAnalysis>();
const entries = new WeakMap<Entry, InternalEntry>();
const publicBody = (body: InternalEntry['body']): Body => {
  const { hash: _hash, shape: _shape, ...result } = body;
  return result;
};
const publicEntry = (entry: InternalEntry, standalone = false): Entry => {
  const {
    requestHeadersHash: _requestHeadersHash,
    responseHeaderFingerprint: _responseHeaderFingerprint,
    responseMimeAmbiguous: _responseMimeAmbiguous,
    contextUrl: _contextUrl,
    ...rest
  } = entry;
  const result = structuredClone({
    ...rest,
    requestBody: publicBody(entry.requestBody),
    body: publicBody(entry.body),
    ...(standalone ? { outcome: `unpartitioned-${entry.id}` } : {}),
  });
  entries.set(result, entry);
  return result;
};
const publicAnalysis = (analysis: InternalAnalysis): Analysis => {
  const { requestIndex: _requestIndex, entries: originalEntries, ...rest } = analysis;
  const result = {
    ...structuredClone(rest),
    entries: originalEntries.map((entry) => publicEntry(entry)),
  };
  analyses.set(result, analysis);
  return result;
};

const internalAnalysis = (analysis: Analysis): InternalAnalysis => {
  const internal = analyses.get(analysis);
  if (!internal)
    throw new HarError(
      'Analysis handle is unavailable. Use the original result returned by analyze().',
      'INVALID_ARGUMENT',
    );
  return internal;
};
const internalEntry = (entry: Entry): InternalEntry => {
  const internal = entries.get(entry);
  if (!internal)
    throw new HarError(
      'Entry handle is unavailable. Use the original entry returned by analyze() or analyzeEntry().',
      'INVALID_ARGUMENT',
    );
  return internal;
};

type Progress = (bytes: number, totalBytes: number, entries: number) => void;
export function analyze(input: Blob | ArrayBuffer, options?: AnalyzeOptions): Promise<Analysis>;
export function analyze(
  input: Blob | ArrayBuffer,
  progress?: Progress,
  override?: Partial<Limits>,
  options?: AnalyzeOptions,
): Promise<Analysis>;
export async function analyze(
  input: Blob | ArrayBuffer,
  optionsOrProgress?: AnalyzeOptions | Progress,
  override?: Partial<Limits>,
  options?: AnalyzeOptions,
): Promise<Analysis> {
  const result =
    typeof optionsOrProgress === 'function' || optionsOrProgress === undefined
      ? await engine.analyze(input, optionsOrProgress, override, options)
      : await engine.analyze(input, optionsOrProgress);
  return publicAnalysis(result);
}
/** Single-call portable report, including bounded representative HTTP exchanges. */
export async function analyzeReport(input: Blob | ArrayBuffer, options: ReportOptions = {}) {
  reportLimits(options);
  const result = await engine.analyze(input, options);
  return createReport(result, options);
}
/** Project an existing original analysis handle without parsing the capture again. */
export const buildReport = (analysis: Analysis, options: ReportOptions = {}) =>
  createReport(internalAnalysis(analysis), options);
export { REPORT_LIMITS } from './report.js';
export const analyzeEntry = async (
  ...args: Parameters<typeof engine.analyzeEntry>
): Promise<Entry> => publicEntry(await engine.analyzeEntry(...args), true);
export const groupPage = (
  analysis: Analysis,
  kind: 'endpoints' | 'outcomes',
  page: number,
  search: string,
  endpoint?: string,
  status?: string,
  pageSize?: number,
) => engine.groupPage(internalAnalysis(analysis), kind, page, search, endpoint, status, pageSize);
export const memberPage = (
  analysis: Analysis,
  ...args: Parameters<typeof engine.memberPage> extends [unknown, ...infer R] ? R : never
) => engine.memberPage(internalAnalysis(analysis), ...args);
export const requestChanges = (analysis: Analysis, id: number) =>
  requestChangesInternal(internalAnalysis(analysis), id);
export const requestChangesComplete = async (analysis: Analysis, id: number) =>
  requestChangesCompleteInternal(internalAnalysis(analysis), id);
export const compare = (reference: Entry, comparison: Entry) =>
  compareInternal(internalEntry(reference), internalEntry(comparison));
export { diffHeaders, diffJson, diffText } from './diff.js';
export { HarError } from './parse.js';
export { sampleHar } from './sample.js';
export * from './index.js';
export { requestScope, REQUEST_ANALYSIS_LIMITS } from './request-analysis.js';
export { structuredFields, STRUCTURE_LIMITS } from './structured.js';
