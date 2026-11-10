import { StructuralAnalysis } from './structural-analysis.js';
import { HeaderStorage } from './header-storage.js';
import { fingerprintResponseHeaders } from './response-policy.js';
import { createRequestIndex, indexRequest, requestScope } from './request-index.js';
import { analyzeEntry } from './entry.js';
import { partitionEntries } from './partition.js';
import type { PartitionEntry } from './partition.js';
import { retainSource } from './source.js';
import { HarError } from './parse.js';
import { streamEntries } from './stream.js';
import { resolveLimits, resolvePageSize } from './limits.js';
import { throwIfAborted } from './errors.js';
import { PAGE_ROWS } from './types.js';
import type {
  Analysis,
  AnalyzeOptions,
  Entry,
  EntryRow,
  Group,
  GroupRow,
  Limits,
  Page,
} from './types.js';

export { analyzeEntry } from './entry.js';

const emptyBody = () => ({ state: 'missing' as const });

type ProgressCallback = (bytes: number, totalBytes: number, entries: number) => void;

/** Stream a capture, collect bounded evidence, then partition using all available contexts. */
export function analyze(input: Blob | ArrayBuffer, options?: AnalyzeOptions): Promise<Analysis>;
/** Legacy positional form; options.limits override the third argument. */
export function analyze(
  input: Blob | ArrayBuffer,
  progress?: ProgressCallback,
  override?: Partial<Limits>,
  options?: AnalyzeOptions,
): Promise<Analysis>;
export async function analyze(
  input: Blob | ArrayBuffer,
  optionsOrProgress?: AnalyzeOptions | ProgressCallback,
  override?: Partial<Limits>,
  legacyOptions?: AnalyzeOptions,
): Promise<Analysis> {
  try {
    return await analyzeCapture(input, optionsOrProgress, override, legacyOptions);
  } catch (error) {
    if (error instanceof HarError) throw error;
    throw new HarError('Analysis failed safely.', 'INTERNAL_ERROR');
  }
}

async function analyzeCapture(
  input: Blob | ArrayBuffer,
  optionsOrProgress?: AnalyzeOptions | ProgressCallback,
  override?: Partial<Limits>,
  legacyOptions?: AnalyzeOptions,
): Promise<Analysis> {
  const options =
    typeof optionsOrProgress === 'function' || optionsOrProgress === undefined
      ? legacyOptions
      : optionsOrProgress;
  if (
    options !== undefined &&
    (!options || typeof options !== 'object' || Array.isArray(options))
  ) {
    throw new HarError('Invalid analysis options.', 'INVALID_OPTIONS');
  }
  if (options?.onProgress !== undefined && typeof options.onProgress !== 'function') {
    throw new HarError('Invalid progress callback.', 'INVALID_OPTIONS');
  }
  const progress = (done: number, total: number, entries: number) => {
    if (typeof optionsOrProgress === 'function') optionsOrProgress(done, total, entries);
    options?.onProgress?.({ done, total, entries });
    throwIfAborted(options?.signal);
  };
  throwIfAborted(options?.signal);
  const started = performance.now(),
    limits = resolveLimits(override, options?.limits);
  const file = input instanceof ArrayBuffer ? new Blob([input]) : input,
    budget = { bytes: 0, nodes: 0 };
  const providedContexts = new Map<number, string>();
  if (options?.contexts !== undefined) {
    if (!Array.isArray(options.contexts) || options.contexts.length > limits.entries)
      throw new HarError('Invalid context associations.', 'INVALID_OPTIONS');
    for (const [group, members] of options.contexts.entries()) {
      if (!Array.isArray(members) || !members.length || members.length > limits.entries)
        throw new HarError('Invalid context members.', 'INVALID_OPTIONS');
      const label = `Provided context ${group + 1}`;
      for (const id of members) {
        if (!Number.isInteger(id) || id < 0 || id >= limits.entries || providedContexts.has(id))
          throw new HarError('Invalid or overlapping context members.', 'INVALID_OPTIONS');
        providedContexts.set(id, label);
      }
    }
  }
  const requestIndex = createRequestIndex(),
    headerCache = { bytes: 0, values: new Map<string, string>() };
  const entries: PartitionEntry[] = [];
  const structural = new StructuralAnalysis();
  const headerStorage = new HeaderStorage();

  const summary = {
    limits: { ...limits },
    total: 0,
    analyzed: 0,
    skipped: 0,
    missing: 0,
    truncated: 0,
    binary: 0,
    invalid: 0,
    shapeLimited: 0,
    retainedBytes: 0,
    deferred: 0,
    metadataEstimate: 0,
    reflection: {
      work: 0,
      entryLimited: 0,
      captureLimited: 0,
      candidateLimited: 0,
      fingerprinted: 0,
    },
    elapsedMs: 0,
    warnings: [] as string[],
  };
  progress(0, file.size, 0);
  for await (const source of streamEntries(
    file,
    limits,
    (bytes) => progress(bytes, file.size, entries.length),
    options?.signal,
  )) {
    throwIfAborted(options?.signal);
    const id = source.id;
    let entry: Entry;
    try {
      entry = await analyzeEntry(source.raw, id, limits, budget);
      summary.analyzed++;
    } catch (error) {
      summary.skipped++;
      entry = {
        id,
        method: '(skipped)',
        url: '',
        status: null,
        mime: '',
        time: null,
        reportedSize: null,
        requestHeaders: [],
        responseHeaders: [],
        query: [],
        requestBody: emptyBody(),
        body: emptyBody(),
        endpoint: 'skipped',
        outcome: 'skipped',
        skipped: error instanceof HarError ? error.message : 'Entry could not be analyzed.',
      };
    }
    const preparedEntry = Object.assign(entry, {
      responseHeaderFingerprint: await fingerprintResponseHeaders(entry, headerCache),
    });
    const requestRow = indexRequest(requestIndex, entry, source.raw);
    summary.metadataEstimate += structural.observe(entry, requestRow, source.raw);
    entry.sourceStart = source.start;
    entry.sourceEnd = source.end;
    const headerBytes =
      headerStorage.retain(entry.requestHeaders) +
      headerStorage.retain(entry.responseHeaders) +
      headerStorage.retain(entry.query);
    const metadataText = [
      entry.method,
      entry.url,
      entry.contextUrl,
      entry.mime,
      entry.requestHttpVersion,
      entry.responseHttpVersion,
      entry.statusText,
      entry.transportError,
      ...(entry.diagnostics ?? []),
    ];
    summary.metadataEstimate +=
      640 + metadataText.reduce((sum, value) => sum + (value?.length ?? 0) * 2, 0) + headerBytes;
    if (summary.metadataEstimate > limits.metadataBytes)
      throw new HarError(
        'Estimated metadata budget exceeded. No partial result accepted; split the capture.',
        'LIMIT_EXCEEDED',
      );
    entries.push(preparedEntry);
    if (!entry.skipped) {
      if (entry.body.state === 'missing') summary.missing++;
      if ([entry.body.state, entry.requestBody.state].includes('limited')) summary.truncated++;
      if (entry.body.state === 'binary') summary.binary++;
      if ([entry.body.state, entry.requestBody.state].includes('invalid')) summary.invalid++;
      if (entry.body.shapeWarning) summary.shapeLimited++;
      if (
        entry.body.evicted ||
        entry.requestBody.evicted ||
        entry.body.previewDeferred ||
        entry.requestBody.previewDeferred
      )
        summary.deferred++;
    }
  }
  throwIfAborted(options?.signal);
  const { endpoints, outcomes, familyInferenceLimited, ambiguousReflections } = partitionEntries(
    entries,
    providedContexts,
    structural,
  );
  Object.assign(summary.reflection, structural.stats);
  if (structural.stats.candidateLimited)
    summary.warnings.push(
      'Request reflection candidate limit reached; affected entries were compared literally.',
    );
  if (structural.stats.entryLimited)
    summary.warnings.push(
      'Request reflection work limit reached; affected entries were compared literally.',
    );
  summary.reflection.fingerprinted = outcomes
    .filter((group) => group.match === 'inferred-reflection')
    .reduce((n, group) => n + group.members.length, 0);
  if (ambiguousReflections)
    summary.warnings.push(
      `Inference skipped for ${ambiguousReflections} response ${ambiguousReflections === 1 ? 'group' : 'groups'} with conflicting reflection explanations.`,
    );
  if (familyInferenceLimited) {
    summary.warnings.push(
      'Related-URL grouping reached its analysis limit. Remaining URLs keep their original paths.',
    );
  }

  summary.total = entries.length;
  summary.retainedBytes = budget.bytes;
  summary.elapsedMs = performance.now() - started;
  if (entries.some((entry) => entry.diagnostics?.length))
    summary.warnings.push(
      'Some capture fields are invalid, too large, or conflicting. Analysis of those fields may be incomplete.',
    );
  if (summary.skipped)
    summary.warnings.push(
      `${summary.skipped.toLocaleString()} entries could not be analyzed. Their original entry numbers remain available.`,
    );
  if (summary.missing)
    summary.warnings.push(
      `${summary.missing.toLocaleString()} response bodies were not captured. These responses are grouped using status and content type.`,
    );
  if (summary.truncated)
    summary.warnings.push(
      `${summary.truncated.toLocaleString()} ${summary.truncated === 1 ? 'entry has' : 'entries have'} request or response bodies exceeding the analysis limit. Responses with oversized bodies are placed in separate partitions because their bodies cannot be compared.`,
    );
  if (summary.invalid) summary.warnings.push('Some body encodings were invalid or unsupported.');
  if (summary.shapeLimited)
    summary.warnings.push(
      'Some response bodies could not be parsed or exceeded analysis limits. Those bodies were compared using their captured bytes.',
    );
  if (summary.deferred)
    summary.warnings.push(
      'Some body previews will load from the local HAR when opened. Analysis results are unchanged.',
    );
  if (requestIndex.limited)
    summary.warnings.push(
      'Request-change analysis reached its work or memory limit; some changes may be unavailable.',
    );
  const result = {
    requestIndex,
    entries,
    endpoints,
    outcomes,
    summary,
  };
  retainSource(result, file, limits);
  return result;
}

/** Optional single-query cache for a worker-owned, immutable analysis. */
export interface GroupPageCache {
  analysis?: Analysis;
  key?: string;
  groups?: Group[];
  contexts?: Map<string, Group>;
  scopeMethods?: Map<string, string | undefined>;
}

export function groupPage(
  analysis: Analysis,
  kind: 'endpoints' | 'outcomes',
  page: number,
  search: string,
  endpoint?: string,
  status = '',
  pageSize = PAGE_ROWS,
  cache?: GroupPageCache,
): Page<GroupRow> {
  pageSize = resolvePageSize(pageSize);
  if (!Number.isFinite(page)) throw new HarError('Page must be finite.', 'INVALID_ARGUMENT');
  if (cache && cache.analysis !== analysis) {
    cache.analysis = analysis;
    cache.key = undefined;
    cache.groups = undefined;
    cache.contexts = new Map(analysis.endpoints.map((context) => [context.id, context]));
    cache.scopeMethods = new Map();
  }
  const key = JSON.stringify([kind, search, endpoint, status]);
  const groups =
    cache?.key === key && cache.groups
      ? cache.groups
      : analysis[kind].filter((g) => {
          const entry = analysis.entries[g.representative];
          return (
            (!endpoint || entry.endpoint === endpoint) &&
            (!status || g.members.some((id) => String(analysis.entries[id].status) === status)) &&
            (!search ||
              `${g.label} ${entry.family ?? ''}`.toLowerCase().includes(search.toLowerCase()) ||
              g.members.some((id) =>
                `${analysis.entries[id].method} ${analysis.entries[id].url}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              ))
          );
        });
  if (cache) {
    cache.key = key;
    cache.groups = groups;
  }
  const current = Math.max(
    0,
    Math.min(Math.floor(page), Math.max(0, Math.ceil(groups.length / pageSize) - 1)),
  );
  const visible = groups.slice(current * pageSize, (current + 1) * pageSize);
  const neededContexts = new Set(
    visible.map((group) => analysis.entries[group.representative].endpoint),
  );
  const scopeMethods = cache?.scopeMethods ?? new Map<string, string | undefined>();
  // Build the context lookup once per capture and resolve each context at most once.
  const contexts =
    cache?.contexts ?? new Map(analysis.endpoints.map((context) => [context.id, context]));
  for (const id of neededContexts) {
    if (scopeMethods.has(id)) continue;
    const context = contexts.get(id);
    if (!context?.members.length) continue;
    const method = analysis.entries[context.members[0]].method;
    const uniform = context.members.every((member) => analysis.entries[member].method === method);
    scopeMethods.set(id, uniform ? method : undefined);
  }
  return {
    rows: visible.map(({ members, ...g }) => {
      const entry = analysis.entries[g.representative];
      const scope = entry.family ?? requestScope(entry.contextUrl ?? entry.url).url;

      return {
        ...g,
        ...(g.normalizations ? { normalizations: [...g.normalizations] } : {}),
        scope,
        scopeMethod: scopeMethods.has(entry.endpoint)
          ? scopeMethods.get(entry.endpoint)
          : entry.method,
        count: members.length,
        endpoint: entry.endpoint,
        method: entry.method,
        url: entry.url,
      };
    }),
    total: groups.length,
    page: current,
    pageSize,
  };
}

export function memberPage(
  analysis: Analysis,
  group: string,
  kind: 'endpoints' | 'outcomes',
  page: number,
  search: string,
  status: string,
  anchor?: number,
  method?: string,
  pageSize = PAGE_ROWS,
): Page<EntryRow> {
  pageSize = resolvePageSize(pageSize);
  if (!Number.isFinite(page)) throw new HarError('Page must be finite.', 'INVALID_ARGUMENT');
  const ids = analysis[kind].find((g) => g.id === group)?.members ?? [];
  const entries = ids
    .map((id) => analysis.entries[id])
    .filter(
      (entry) =>
        (!method || entry.method === method) &&
        `${entry.id + 1} ${entry.method} ${entry.url} ${entry.mime}`
          .toLowerCase()
          .includes(search.toLowerCase()) &&
        (!status || String(entry.status) === status),
    );
  if (anchor !== undefined) {
    const index = entries.findIndex((entry) => entry.id === anchor);
    if (index >= 0) page = Math.floor(index / pageSize);
  }
  const current = Math.max(
    0,
    Math.min(Math.floor(page), Math.max(0, Math.ceil(entries.length / pageSize) - 1)),
  );
  return {
    rows: entries.slice(current * pageSize, (current + 1) * pageSize).map((entry) => ({
      id: entry.id,
      method: entry.method,
      url: entry.url,
      status: entry.status,
      mime: entry.mime,
      time: entry.time,
      bytes: entry.body.bytes,
      bodyState: entry.body.state,
      skipped: entry.skipped,
    })),
    total: entries.length,
    page: current,
    pageSize,
  };
}
