import type { Analysis, Body, Entry, Group, RequestChange } from './types.js';
import type {
  AnalysisReport,
  HttpExchange,
  InputVariation,
  PartitionReport,
  ReportBody,
  ReportLimits,
  ReportOptions,
} from './report-types.js';
import { HarError, textPrefix } from './parse.js';
import { throwIfAborted } from './errors.js';
import { analyzeEntry } from './analyze.js';
import { requestChanges } from './request-analysis.js';
import { sourceFor } from './source.js';
import { streamEntries } from './stream.js';

export const REPORT_LIMITS: Readonly<ReportLimits> = Object.freeze({
  bodyChars: 4096,
  evidenceChars: 2 * 1024 * 1024,
  variationEntries: 10000,
  rereadBytes: 32 * 1024 * 1024,
});
const explanations: Record<NonNullable<Group['match']>, string> = {
  exact: 'Responses share the same captured body bytes and grouping metadata.',
  canonical: 'Responses match after supported content normalization and metadata comparison.',
  'inferred-noise':
    'Responses match after corroborated diagnostic or cookie normalization. This is heuristic.',
  'inferred-reflection':
    'Responses share an inferred structure after accounting for observed request reflections. This is heuristic.',
  'metadata-only': 'Response bodies are unavailable. Grouping uses status and content type.',
  unavailable: 'There was insufficient response evidence for content comparison.',
};

export function reportLimits(options: ReportOptions): ReportLimits {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    (options.diagnostics !== undefined && typeof options.diagnostics !== 'boolean')
  )
    throw new HarError('Invalid report options.', 'INVALID_OPTIONS');
  const supplied = options.reportLimits;
  if (
    supplied !== undefined &&
    (!supplied || typeof supplied !== 'object' || Array.isArray(supplied))
  )
    throw new HarError('Invalid report limits.', 'INVALID_OPTIONS');
  const result = { ...REPORT_LIMITS };
  for (const [key, value] of Object.entries(supplied ?? {})) {
    if (!Object.hasOwn(REPORT_LIMITS, key) || !Number.isSafeInteger(value) || value < 0)
      throw new HarError('Report limits must be nonnegative safe integers.', 'INVALID_OPTIONS');
    result[key as keyof ReportLimits] = value;
  }
  return result;
}
function bodyReport(body: Body, chars: number): ReportBody {
  const content = body.text ?? body.preview;
  const text = content === undefined ? undefined : textPrefix(content, chars);
  const truncated = Boolean(
    body.state === 'limited' ||
      body.displayTruncated ||
      body.preview !== undefined ||
      body.evicted ||
      body.previewDeferred ||
      (content !== undefined && text !== content),
  );
  const state =
    body.state === 'text'
      ? content === undefined
        ? 'omitted'
        : content === ''
          ? 'empty'
          : 'text'
      : body.state;
  return {
    state,
    ...(text !== undefined ? { text } : {}),
    bytes: body.bytes ?? null,
    truncated,
    ...(body.reason
      ? { reason: body.reason }
      : state === 'omitted'
        ? { reason: 'Body text was not retained within analysis limits.' }
        : {}),
  };
}
function exchange(entry: Entry, chars: number): HttpExchange {
  return {
    entry: entry.id,
    request: {
      method: entry.skipped || entry.requestMethodAvailable === false ? null : entry.method,
      url: entry.skipped || entry.requestUrlAvailable === false ? null : entry.url,
      httpVersion: entry.requestHttpVersion ?? null,
      headers: entry.requestHeaders.map((header) => ({ ...header })),
      body: bodyReport(entry.requestBody, chars),
    },
    response: {
      status: entry.status === 0 ? null : entry.status,
      statusText: entry.statusText ?? null,
      contentType: entry.responseMimeAvailable === false ? null : entry.mime,
      httpVersion: entry.responseHttpVersion ?? null,
      headers: entry.responseHeaders.map((header) => ({ ...header })),
      body: bodyReport(entry.body, chars),
      ...(entry.transportError ? { transportError: entry.transportError } : {}),
    },
    timeMs: entry.time,
    warnings: [
      ...(entry.skipped ? [entry.skipped] : []),
      ...(entry.diagnostics ?? []),
      ...(entry.requestHeadersHash === undefined
        ? ['Request headers are unavailable or incomplete.']
        : []),
      ...(entry.responseHeadersAvailable === false
        ? ['Response headers are unavailable or incomplete.']
        : []),
      ...(entry.status === 0 ? ['No HTTP response status was captured (HAR status 0).'] : []),
    ],
  };
}
function pathLabel(change: RequestChange): string {
  if (change.kind !== 'JSON') return change.key;
  if (!change.key) return '$';
  return change.key
    .slice(1)
    .split('/')
    .reduce((label, raw, index) => {
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (change.pathTypes?.[index] === 'array' && /^(0|[1-9]\d*)$/.test(key))
        return `${label}[${key}]`;
      return label + (/^[a-zA-Z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);
    }, '$');
}
function variation(change: RequestChange): InputVariation {
  return {
    id: change.id,
    category: change.kind,
    key: change.key,
    label: pathLabel(change),
    comparedRequests: change.compared,
    presentRequests: change.present,
    distinctValues: change.distinctValues ?? change.examples.length,
    moreValues: change.moreValues,
    values: change.examples.map((example) => {
      let value: string | string[] = example.value;
      let format: InputVariation['values'][number]['format'] = 'text';
      if (example.state === 'empty-body') format = 'empty-body';
      else if (change.kind === 'JSON') {
        format = 'json';
        if (!example.truncated) {
          try {
            const decoded: unknown = JSON.parse(value);
            if (typeof decoded === 'string') {
              value = decoded;
              format = 'text';
            }
          } catch {
            /* Keep exact, possibly partial JSON evidence. */
          }
        }
      } else if (['Query', 'Header', 'Cookie'].includes(change.kind)) {
        try {
          const decoded: unknown = JSON.parse(value);
          if (Array.isArray(decoded) && decoded.every((item) => typeof item === 'string')) {
            value = decoded;
            format = 'values';
          }
        } catch {
          /* Unrecognized envelopes remain explicit text excerpts. */
        }
      }
      return {
        entry: example.entry,
        requestCount: example.count,
        value,
        format,
        truncated: example.truncated,
      };
    }),
  };
}

/** Builds a bounded, portable projection. Grouping always comes from the existing engine. */
export async function createReport(
  analysis: Analysis,
  options: ReportOptions = {},
): Promise<AnalysisReport> {
  throwIfAborted(options.signal);
  const limits = reportLimits(options);
  let evidenceChars = 0,
    variationEntries = 0,
    rereadBytes = 0;
  const source = sourceFor(analysis);
  const take = (value: unknown): boolean => {
    const chars = JSON.stringify(value).length;
    if (chars > limits.evidenceChars - evidenceChars) return false;
    evidenceChars += chars;
    return true;
  };
  const hydrate = async (entry: Entry): Promise<Entry> => {
    if (
      !source ||
      !(
        entry.body.evicted ||
        entry.requestBody.evicted ||
        entry.body.previewDeferred ||
        entry.requestBody.previewDeferred
      )
    )
      return entry;
    if (entry.sourceStart === undefined || entry.sourceEnd === undefined) return entry;
    const bytes = entry.sourceEnd - entry.sourceStart;
    if (bytes > limits.rereadBytes - rereadBytes) return entry;
    rereadBytes += bytes;
    const configured = {
      ...source.limits,
      fileBytes: null,
      totalBodyBytes: Math.min(
        Number.MAX_SAFE_INTEGER,
        source.limits.bodyBytes * 2 + limits.bodyChars * 6,
      ),
    };
    const wrapped = new Blob([
      '{"log":{"entries":[',
      source.file.slice(entry.sourceStart, entry.sourceEnd),
      ']}}',
    ]);
    for await (const row of streamEntries(wrapped, configured, undefined, options.signal)) {
      const full = await analyzeEntry(row.raw, entry.id, configured, { bytes: 0, nodes: 0 });
      if (
        full.body.hash !== entry.body.hash ||
        full.requestBody.hash !== entry.requestBody.hash ||
        full.url !== entry.url ||
        full.method !== entry.method
      )
        throw new HarError('Capture evidence changed. Reimport the HAR.', 'SOURCE_CHANGED');
      return {
        ...entry,
        body: {
          ...entry.body,
          text: full.body.text,
          preview: full.body.preview,
          evicted: full.body.evicted,
          previewDeferred: full.body.previewDeferred,
        },
        requestBody: {
          ...entry.requestBody,
          text: full.requestBody.text,
          preview: full.requestBody.preview,
          evicted: full.requestBody.evicted,
          previewDeferred: full.requestBody.previewDeferred,
        },
      };
    }
    return entry;
  };
  const report: AnalysisReport = {
    schemaVersion: 1,
    source: { format: 'har', bytes: source?.file.size ?? 0 },
    summary: {
      capturedRequests: analysis.summary.total,
      analyzedRequests: analysis.summary.analyzed,
      skippedRequests: analysis.summary.skipped,
      requestContexts: analysis.endpoints.length,
      responsePartitions: analysis.outcomes.length,
      missingResponseBodies: analysis.summary.missing,
      limitedResponseBodies: analysis.entries.filter((entry) => entry.body.state === 'limited')
        .length,
      warnings: [...analysis.summary.warnings],
    },
    contexts: [],
    coverage: {
      samplesIncluded: 0,
      samplesOmitted: 0,
      variationPartitionsIncluded: 0,
      variationPartitionsOmitted: 0,
      reportLimits: limits,
    },
    ...(options.diagnostics
      ? {
          diagnostics: {
            summary: structuredClone(analysis.summary),
          },
        }
      : {}),
  };
  const partitions = new Map<string, Group[]>();
  for (const group of analysis.outcomes) {
    const context = analysis.entries[group.representative].endpoint;
    const groups = partitions.get(context) ?? [];
    groups.push(group);
    partitions.set(context, groups);
  }
  for (const context of analysis.endpoints) {
    const members = context.members.map((id) => analysis.entries[id]);
    const item: AnalysisReport['contexts'][number] = {
      id: context.id,
      label: context.label,
      methods: [
        ...new Set(
          members
            .filter((e) => !e.skipped && e.requestMethodAvailable !== false)
            .map((e) => e.method),
        ),
      ],
      requestCount: members.length,
      partitionCount: context.variants,
      partitions: [],
    };
    // Spend the existing finite budget on failed exchanges before high-volume
    // response partitions; retain the usual presentation order below.
    const groups = (partitions.get(context.id) ?? []).sort(
      (a, b) =>
        Number(analysis.entries[b.representative].status === 0) -
          Number(analysis.entries[a.representative].status === 0) ||
        b.members.length - a.members.length ||
        (a.number ?? 0) - (b.number ?? 0),
    );
    for (const group of groups) {
      throwIfAborted(options.signal);
      const representative = analysis.entries[group.representative];
      const rows = group.members.map((id) => analysis.entries[id]);
      const basis = group.match ?? 'unavailable';
      const partition: PartitionReport = {
        id: group.id,
        number: group.number ?? item.partitions.length + 1,
        requestCount: rows.length,
        statuses: [...new Set(rows.map((e) => (e.status === 0 ? null : e.status)))],
        contentTypes: [
          ...new Set(rows.map((e) => (e.responseMimeAvailable === false ? null : e.mime))),
        ],
        responseBytes: { min: group.minBytes, max: group.maxBytes },
        timeMs: { min: group.minTime, max: group.maxTime },
        grouping: {
          basis,
          explanation:
            rows.length === 1
              ? 'Single observation. No comparison available.'
              : explanations[basis],
          heuristic:
            basis === 'inferred-reflection' ||
            basis === 'inferred-noise' ||
            Boolean(
              group.normalizations?.some(
                (rule) =>
                  rule === 'cookie-rotation' ||
                  rule === 'response-telemetry' ||
                  rule === 'response-headers',
              ),
            ),
          ...(group.normalizations ? { normalizations: [...group.normalizations] } : {}),
        },
        sample: null,
        variations: {
          method:
            representative.skipped || representative.requestMethodAvailable === false
              ? null
              : representative.method,
          fields: [],
          notices: [],
          coverage: {
            state: 'omitted',
            comparedRequests: 0,
            incompleteEvidence: 0,
            reason: representative.skipped
              ? 'The representative entry could not be analyzed.'
              : 'Report variation or evidence budget reached.',
          },
        },
      };
      if (evidenceChars < limits.evidenceChars) {
        const sample = exchange(await hydrate(representative), limits.bodyChars);
        if (take(sample)) partition.sample = sample;
      }
      if (partition.sample) report.coverage.samplesIncluded++;
      else {
        partition.sampleOmittedReason = 'Report evidence budget reached.';
        report.coverage.samplesOmitted++;
      }
      if (
        !representative.skipped &&
        members.length <= limits.variationEntries - variationEntries &&
        evidenceChars < limits.evidenceChars
      ) {
        variationEntries += members.length;
        const changes = requestChanges(analysis, representative.id);
        const variations: PartitionReport['variations'] = {
          method: changes.method ?? null,
          fields: changes.changes.map(variation),
          notices: [...(changes.notices ?? [])],
          coverage: {
            state: changes.incomplete || changes.entries !== rows.length ? 'partial' : 'available',
            comparedRequests: changes.entries,
            incompleteEvidence: changes.incomplete,
            ...(changes.incomplete || changes.entries !== rows.length
              ? {
                  reason:
                    'Some input evidence was unavailable, exceeded analysis limits, or belongs to another HTTP method.',
                }
              : {}),
          },
        };
        if (take(variations)) partition.variations = variations;
      }
      if (partition.variations.coverage.state === 'omitted')
        report.coverage.variationPartitionsOmitted++;
      else report.coverage.variationPartitionsIncluded++;
      item.partitions.push(partition);
      // Allow cancellation during large report projections as well as source reads.
      if ((report.coverage.samplesIncluded + report.coverage.samplesOmitted) % 50 === 0)
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    item.partitions.sort((a, b) => b.requestCount - a.requestCount || a.number - b.number);
    report.contexts.push(item);
  }
  throwIfAborted(options.signal);
  return report;
}
