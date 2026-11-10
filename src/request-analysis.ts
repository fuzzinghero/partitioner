import type {
  Entry,
  RequestChanges,
  RequestChange,
  RequestContrast,
  RequestChangeKind,
  Analysis,
} from './types.js';
import { sourceFor } from './source.js';
import { cookieHeaderLayout } from './cookies.js';
import { readBody } from './body.js';
import { parseLosslessJson, formatJson, isNumberToken } from './lossless-json.js';
import { streamEntries } from './stream.js';
import { HarError, textPrefix, record, headerName, requestMediaType } from './parse.js';
import {
  createRequestIndex,
  indexRequest,
  requestScope,
  REQUEST_ANALYSIS_LIMITS,
} from './request-index.js';
import type { RequestRow, RequestCategories } from './request-index.js';

export {
  createRequestIndex,
  indexRequest,
  requestScope,
  REQUEST_ANALYSIS_LIMITS,
} from './request-index.js';
export type { RequestRow, RequestIndex } from './request-index.js';

// Require more than a bare majority to report a deviation. Frequency is not a baseline
// or causal confidence.
const DOMINANT_VALUE_SHARE = 0.6;
const CATEGORY_ORDER: readonly RequestChangeKind[] = [
  'Path',
  'Query',
  'JSON',
  'XML',
  'Form',
  'Multipart',
  'Endpoint',
  'Header',
  'Cookie',
  'Body',
  'Protocol',
];

type EvidenceChange<T extends { kind: string }> = Omit<T, 'kind' | 'id'> & { kind: string };
type EvidenceContrast = Omit<RequestContrast, 'changes'> & {
  changes: EvidenceChange<RequestContrast['changes'][number]>[];
};

function jsonPathTypes(
  containers: Map<string, string>,
  key: string,
): NonNullable<RequestChange['pathTypes']> {
  if (!key) return [];
  let parent = '';
  return key
    .slice(1)
    .split('/')
    .map((segment) => {
      const type = containers.get(parent);
      parent += `/${segment}`;
      return type === 'object' || type === 'array' ? type : 'unknown';
    });
}

/** Only complete captured body bytes can corroborate an unambiguous length header. */
function routineContentLength(entry?: Entry, allowAbsent = false): boolean {
  if (!entry || entry.diagnostics?.some((message) => message.startsWith('Request headers')))
    return false;
  const lengths = entry.requestHeaders.filter(
    (header) => headerName(header.name) === 'content-length',
  );
  if (
    !entry.requestBody.hash ||
    entry.requestBody.bytes === undefined ||
    entry.requestHeaders.some(
      (header) =>
        headerName(header.name) === 'transfer-encoding' ||
        (headerName(header.name) === 'content-encoding' &&
          header.value.trim().toLowerCase() !== 'identity'),
    )
  )
    return false;
  if (!lengths.length) return allowAbsent && entry.requestHeadersHash !== undefined;
  if (lengths.length !== 1 || !/^[ \t]*[0-9]+[ \t]*$/.test(lengths[0].value)) return false;
  const declared = Number(lengths[0].value);
  return Number.isSafeInteger(declared) && declared === entry.requestBody.bytes;
}

/** Translate evidence only at the query boundary; internal dimensions still drive comparisons. */
function customerChanges<T extends { kind: string; key: string }>(
  changes: T[],
  {
    hideContentLength = false,
    hideCookieHeader = false,
  }: {
    hideContentLength?: boolean;
    hideCookieHeader?: boolean;
  } = {},
) {
  return changes.flatMap(
    (change): (Omit<T, 'kind'> & { kind: RequestChangeKind; id: string })[] => {
      if (hideCookieHeader && change.kind === 'Header' && change.key === 'cookie') return [];
      if (hideContentLength && change.kind === 'Header' && change.key === 'content-length')
        return [];
      let kind: RequestChangeKind;
      let key = change.key;
      switch (change.kind) {
        case 'Path parameter':
          kind = 'Path';
          break;
        case 'Query parameter':
          kind = 'Query';
          break;
        case 'Protocol':
        case 'HTTP method':
          kind = 'Endpoint';
          break;
        case 'Raw query':
          kind = 'Query';
          key = 'Query string';
          break;
        case 'Raw headers':
          // Header order and casing are internal comparison evidence, not a request parameter.
          return [];
        case 'Body format':
          kind = 'Body';
          key = change.key === 'Media type' ? 'Content type' : 'Content type parameters';
          break;
        case 'Body':
          kind = 'Body';
          break;
        case 'JSON':
        case 'XML':
        case 'Form':
        case 'Multipart':
        case 'Header':
        case 'Cookie':
          kind = change.kind;
          break;
        default:
          return [];
      }
      return [{ ...change, kind, key, id: JSON.stringify([change.kind, change.key]) }];
    },
  );
}

function comparisonCategories(entry: Entry, row: RequestRow, family: string): RequestCategories {
  const categories = new Map(row.categories);
  if (categories.has('Raw headers'))
    categories.set(
      'Raw headers',
      new Map([
        [
          'Header order and casing',
          JSON.stringify(entry.requestHeaders.map((header) => header.name)),
        ],
      ]),
    );
  const containers = categories.get('JSON structure');
  if (containers) {
    // Container labels must be real captured JSON, not invented empty objects or arrays.
    // Bound work when extracting nested subtrees from a potentially hostile capture.
    try {
      const text = entry.requestBody.text;
      if (text === undefined || text.length > 32768 || containers.size > 100) throw new Error();
      const root = parseLosslessJson(text);
      const fields = new Map(categories.get('JSON') ?? []);
      for (const path of containers.keys()) {
        let node = root;
        for (const encoded of path ? path.slice(1).split('/') : []) {
          const segment = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
          if (
            node === null ||
            typeof node !== 'object' ||
            isNumberToken(node) ||
            !Object.prototype.hasOwnProperty.call(node, segment)
          )
            throw new Error();
          node = (node as Record<string, unknown>)[segment];
        }
        const value = formatJson(node);
        if (value === undefined) throw new Error();
        fields.set(path, value);
      }
      categories.set('JSON', fields);
    } catch {
      // Preserve already-indexed scalar fields while treating unavailable containers as unknown.
      const fields = new Map(categories.get('JSON') ?? []);
      for (const path of containers.keys()) fields.delete(path);
      categories.set('JSON', fields);
      categories.set('JSON unavailable', new Map([...containers.keys()].map((path) => [path, ''])));
      categories.set('Incomplete', new Map());
    }
    categories.delete('JSON structure');
  }
  const rawBody = categories.get('Raw body');
  if (rawBody || categories.has('Body')) {
    // Hashes remain internal; only complete captured text is actionable evidence.
    if (entry.requestBody.state === 'text' && entry.requestBody.text !== undefined)
      categories.set('Body', new Map([['Content', entry.requestBody.text]]));
    else {
      categories.delete('Body');
      categories.set('Incomplete', new Map());
    }
    categories.delete('Raw body');
  }
  if (entry.requestUrlAvailable === false || !entry.url) {
    categories.delete('Path parameter');
    categories.set('Incomplete', new Map());
    return categories;
  }
  const actualPath = requestScope(entry.contextUrl ?? entry.url).url;
  if (family.includes('{param')) {
    const parts = actualPath.split('/');
    const template = family.split('/');
    const pathFields = new Map<string, string>();
    template.forEach((part, position) => {
      if (/^\{param\d+\}$/.test(part))
        pathFields.set(`Segment ${part.slice(6, -1)}`, parts[position] ?? '');
    });
    pathFields.set('Trailing path', parts.slice(template.length).join('/'));
    categories.set('Path parameter', pathFields);
  } else categories.set('Path parameter', new Map([['Path', actualPath]]));
  return categories;
}

/** Bound decoded repeated fields without cutting JSON syntax or escape sequences. */
function evidenceExcerpt(kind: string, value?: string): { value?: string; truncated: boolean } {
  if (value === undefined) return { truncated: false };
  if (['Query parameter', 'Raw query', 'Raw headers', 'Header', 'Cookie'].includes(kind)) {
    try {
      const items: unknown = JSON.parse(value);
      if (Array.isArray(items) && items.every((item) => typeof item === 'string')) {
        let remaining = 512;
        let truncated = items.length > 50;
        const bounded: string[] = [];
        for (const item of items.slice(0, 50)) {
          if (!remaining && item.length) {
            truncated = true;
            break;
          }
          const excerpt = textPrefix(item, remaining);
          remaining -= excerpt.length;
          truncated ||= excerpt.length !== item.length;
          bounded.push(excerpt);
          if (excerpt.length !== item.length) break;
        }
        return { value: JSON.stringify(bounded), truncated };
      }
    } catch {
      // Unrecognized evidence is kept as an explicitly truncated excerpt below.
    }
  }
  return { value: textPrefix(value, 512), truncated: value.length > 512 };
}

type ContrastBudget = { work: number; limited: boolean };

function contrast(
  reference: number,
  comparison: number,
  before: RequestCategories,
  after: RequestCategories,
  responseChanged: boolean,
  budget: ContrastBudget,
  beforeUnavailable?: RequestRow['unavailable'],
  afterUnavailable?: RequestRow['unavailable'],
): EvidenceContrast | undefined {
  const changes: EvidenceContrast['changes'] = [];
  let complete =
    !before.has('Incomplete') &&
    !after.has('Incomplete') &&
    ![...(beforeUnavailable?.values() ?? []), ...(afterUnavailable?.values() ?? [])].some(
      (keys) => keys.size > 0,
    );
  const visit = () => {
    if (budget.work >= REQUEST_ANALYSIS_LIMITS.contrastWork) {
      budget.limited = true;
      return false;
    }
    budget.work++;
    return true;
  };
  for (const kind of new Set([...before.keys(), ...after.keys()])) {
    if (!visit()) return;
    if (kind === 'Incomplete' || kind === 'JSON unavailable') continue;
    const a = before.get(kind);
    const b = after.get(kind);
    if (!a || !b) {
      // Optional interpretations have separate availability from captured wire evidence.
      if (kind !== 'Cookie') complete = false;
      continue;
    }
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      if (!visit()) return;
      if (
        beforeUnavailable?.get(kind)?.has(key) ||
        afterUnavailable?.get(kind)?.has(key) ||
        (kind === 'JSON' &&
          (before.get('JSON unavailable')?.has(key) || after.get('JSON unavailable')?.has(key)))
      ) {
        complete = false;
        continue;
      }
      const referenceValue = a.get(key);
      const observed = b.get(key);
      if (referenceValue === observed) continue;
      if (changes.length >= 200) {
        complete = false;
        break;
      }
      const referenceExcerpt = evidenceExcerpt(kind, referenceValue);
      const observedExcerpt = evidenceExcerpt(kind, observed);
      changes.push({
        kind,
        key,
        reference: referenceExcerpt.value,
        observed: observedExcerpt.value,
        truncated: referenceExcerpt.truncated || observedExcerpt.truncated,
      });
    }
  }
  return { reference, comparison, changes, complete, responseChanged, causal: false };
}

function withoutRedundantRawChanges<
  T extends { kind: string; key: string; observed?: string; reference?: string },
>(changes: T[], { jsonContainers }: { jsonContainers?: ReadonlySet<string> } = {}): T[] {
  const jsonParents = new Set<string>();
  for (const change of changes) {
    if (change.kind !== 'JSON') continue;
    let path = change.key;
    while (path.includes('/')) {
      path = path.slice(0, path.lastIndexOf('/'));
      jsonParents.add(path);
    }
  }
  const kinds = new Set(changes.map((change) => change.kind));
  return changes.filter((change) => {
    if (change.kind === 'JSON' && jsonParents.has(change.key)) {
      const values = [change.reference, change.observed].filter(
        (value): value is string => value !== undefined,
      );
      const containerOnly =
        jsonContainers?.has(change.key) ||
        (values.length > 0 &&
          (values.every((value) => value.startsWith('{')) ||
            values.every((value) => value.startsWith('['))));
      if (containerOnly) return false;
    }
    switch (change.kind) {
      case 'Raw query':
        return !kinds.has('Query parameter');
      case 'Body':
        return !['JSON', 'XML', 'Form', 'Multipart'].some((kind) => kinds.has(kind));
      default:
        return true;
    }
  });
}

type ContrastCandidate = { evidence: EvidenceContrast; distance: number };
const MAX_CONTRASTS = 5;

function compareCandidates(left: ContrastCandidate, right: ContrastCandidate): number {
  if (left.evidence.complete !== right.evidence.complete) {
    return left.evidence.complete ? -1 : 1;
  }
  const leftHasChanges = left.evidence.changes.length > 0;
  const rightHasChanges = right.evidence.changes.length > 0;
  if (leftHasChanges !== rightHasChanges) return leftHasChanges ? -1 : 1;
  return left.distance - right.distance || left.evidence.reference - right.evidence.reference;
}

/** Keep a few nearest observed examples, not a causal or exhaustive mutation search. */
function createContrastSelector(id: number, current?: RequestCategories, currentRow?: RequestRow) {
  // Fallback examples must not spend the search budget for other response partitions.
  const changedBudget: ContrastBudget = { work: 0, limited: false };
  const unchangedBudget: ContrastBudget = { work: 0, limited: false };
  const changedResponses = new Map<string, ContrastCandidate>();
  const unchangedResponses = new Map<string, ContrastCandidate>();
  let unexplainedResponse: EvidenceContrast | undefined;

  const consider = (
    source: Entry,
    categories: RequestCategories,
    responseChanged: boolean,
    row: RequestRow,
  ) => {
    const budget = responseChanged ? changedBudget : unchangedBudget;
    if (!current || budget.limited) return;
    const evidence = contrast(
      source.id,
      id,
      categories,
      current,
      responseChanged,
      budget,
      row.unavailable,
      currentRow?.unavailable,
    );
    if (!evidence) return;
    if (evidence.complete && evidence.changes.length === 0 && responseChanged) {
      // Identical captured inputs with different responses are evidence worth preserving.
      unexplainedResponse ??= evidence;
      return;
    }
    if (!responseChanged && evidence.changes.length === 0) return;
    const candidates = responseChanged ? changedResponses : unchangedResponses;
    const signature = responseChanged ? `${source.outcome}:${source.method}` : source.method;
    const candidate = { evidence, distance: withoutRedundantRawChanges(evidence.changes).length };
    const existing = candidates.get(signature);
    if (existing && compareCandidates(candidate, existing) >= 0) return;
    candidates.set(signature, candidate);
    if (candidates.size > MAX_CONTRASTS) {
      const worst = [...candidates].sort((left, right) => compareCandidates(right[1], left[1]))[0];
      candidates.delete(worst[0]);
    }
  };
  const finish = () => {
    const candidates = changedResponses.size ? changedResponses : unchangedResponses;
    const availableSlots = MAX_CONTRASTS - (unexplainedResponse ? 1 : 0);
    const selected = [...candidates.values()]
      .sort(compareCandidates)
      .slice(0, availableSlots)
      .map((candidate) => candidate.evidence);
    if (unexplainedResponse) selected.push(unexplainedResponse);
    return selected;
  };
  return {
    consider,
    finish,
    isLimited: () => changedBudget.limited || unchangedBudget.limited,
  };
}

function createCollector(
  analysis: Analysis,
  id: number,
  currentRow?: RequestRow,
  currentEntry?: Entry,
) {
  const entry = currentEntry ?? analysis.entries[id];
  const sameMethod = (source: Entry) =>
    entry?.requestMethodAvailable !== false &&
    source.requestMethodAvailable !== false &&
    source.method === entry?.method;
  const family = entry?.family ?? requestScope(entry?.contextUrl ?? entry?.url ?? '').url;
  const cohort = analysis.endpoints.find((g) => g.id === entry?.endpoint)?.members ?? [];
  const partitionIds = analysis.outcomes.find((g) => g.id === entry?.outcome)?.members ?? [];
  const selectedIds = new Set(
    partitionIds.filter((sourceId) => sameMethod(analysis.entries[sourceId])),
  );
  const methods = new Map<string, { method: string; count: number; entry: number }>();
  for (const sourceId of partitionIds) {
    if (analysis.entries[sourceId].requestMethodAvailable === false) continue;
    const method = analysis.entries[sourceId].method;
    const item = methods.get(method) ?? { method, count: 0, entry: sourceId };
    item.count++;
    methods.set(method, item);
  }
  const current: {
    entry: number;
    changes: EvidenceChange<NonNullable<RequestChanges['current']>['changes'][number]>[];
  } = { entry: id, changes: [] };
  const comparableCounts = new Map<string, number>();
  const selectedComparableCounts = new Map<string, number>();
  const unavailableCounts = new Map<string, { count: number; selected: number }>();
  type FieldCounts = {
    kind: string;
    key: string;
    present: number;
    selectedPresent: number;
    pathTypes?: RequestChange['pathTypes'];
    values: Map<
      string,
      {
        count: number;
        selected: number;
        entry: number;
        displayValue?: string;
        displayTruncated?: boolean;
        containerDocument?: string;
        containerStart?: number;
        containerLength?: number;
        containerKind?: 'object' | 'array';
      }
    >;
  };
  const fields = new Map<string, FieldCounts>();
  const jsonContainers = new Map<string, string>();
  // A document is retained once per source; per-field records point into it.
  const containerDocuments = new Map<number, string>();
  let containerHashChars = 0;
  let containerComparisonChars = 0;
  const unavailableContainerFields = new Set<string>();
  const containerIdentity = (field: FieldCounts, value: string): string | undefined => {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    const prefix = `\0container:${value.length}:${hash >>> 0}`;
    let key = prefix;
    let collision = 0;
    while (field.values.has(key)) {
      containerComparisonChars += value.length;
      if (containerComparisonChars > REQUEST_ANALYSIS_LIMITS.rereadBytes) return undefined;
      const candidate = field.values.get(key)!;
      if (
        candidate.containerDocument?.slice(
          candidate.containerStart,
          candidate.containerStart! + candidate.containerLength!,
        ) === value
      )
        return key;
      key = `${prefix}:${++collision}`;
    }
    return key;
  };
  let incomplete = 0;
  let work = 0;
  let valueBytes = 0;
  let limited = false;
  let contentTypeConflict = false;
  let cookieHeadersCovered = true;
  let cookieLayout: string | undefined;
  const currentCategories =
    currentRow && entry ? comparisonCategories(entry, currentRow, family) : undefined;
  const contrastSelector = createContrastSelector(id, currentCategories, currentRow);
  const add = (sourceId: number, row?: RequestRow, sourceEntry?: Entry) => {
    if (limited) return;
    if (!row) {
      incomplete++;
      cookieHeadersCovered = false;
      return;
    }
    const source = sourceEntry ?? analysis.entries[sourceId];
    const categories = comparisonCategories(source, row, family);
    if (sameMethod(source) && cookieHeadersCovered) {
      const layout = cookieHeaderLayout(source.requestHeaders, categories.get('Cookie'));
      if (
        !categories.has('Header') ||
        layout === undefined ||
        (cookieLayout !== undefined && cookieLayout !== layout)
      ) {
        cookieHeadersCovered = false;
      }
      cookieLayout ??= layout;
    }
    if (sameMethod(source) && categories.has('JSON')) {
      for (const [path, type] of row.categories.get('JSON structure') ?? []) {
        if (
          ++work > REQUEST_ANALYSIS_LIMITS.work ||
          (!jsonContainers.has(path) &&
            jsonContainers.size >= REQUEST_ANALYSIS_LIMITS.fieldsPerScope)
        ) {
          limited = true;
          return;
        }
        if (type !== 'array' && type !== 'object') continue;
        const previous = jsonContainers.get(path);
        jsonContainers.set(
          path,
          previous === undefined ? type : previous === type ? type : 'unknown',
        );
      }
    }
    const format = categories.get('Body format');
    const contentTypes = source.requestHeaders.filter(
      (header) => headerName(header.name) === 'content-type',
    );
    if (format && contentTypes.length) {
      const full = format.get('Captured media type');
      contentTypeConflict ||=
        contentTypes.length !== 1 ||
        (full !== undefined
          ? full !== contentTypes[0].value.trim()
          : format.get('Media type') !== contentTypes[0].value.split(';')[0].trim().toLowerCase());
    }
    if (
      sourceId !== id &&
      (source.outcome !== entry?.outcome ||
        row.categories !== currentRow?.categories ||
        source.url !== entry?.url)
    ) {
      contrastSelector.consider(source, categories, source.outcome !== entry?.outcome, row);
    }
    const selected = selectedIds.has(sourceId);
    const routineLength = routineContentLength(source);
    for (const [kind, values] of categories) {
      if (kind === 'Incomplete') {
        incomplete++;
        continue;
      }
      if (kind === 'JSON unavailable') continue;
      if (kind !== 'HTTP method' && !sameMethod(source)) continue;
      comparableCounts.set(kind, (comparableCounts.get(kind) ?? 0) + 1);
      if (selected)
        selectedComparableCounts.set(kind, (selectedComparableCounts.get(kind) ?? 0) + 1);
      // Omitted exporter file metadata is unknown, even when its sibling form values are known.
      const unavailable = new Set(row.unavailable?.get(kind) ?? []);
      if (kind === 'JSON')
        for (const key of categories.get('JSON unavailable')?.keys() ?? []) unavailable.add(key);
      for (const key of unavailable) {
        if (++work > REQUEST_ANALYSIS_LIMITS.work) {
          limited = true;
          return;
        }
        const fieldKey = JSON.stringify([kind, key]);
        if (
          !unavailableCounts.has(fieldKey) &&
          unavailableCounts.size >= REQUEST_ANALYSIS_LIMITS.fieldsPerScope
        ) {
          limited = true;
          return;
        }
        const counts = unavailableCounts.get(fieldKey) ?? { count: 0, selected: 0 };
        counts.count++;
        if (selected) counts.selected++;
        unavailableCounts.set(fieldKey, counts);
      }
      for (const [key, value] of values) {
        if (++work > REQUEST_ANALYSIS_LIMITS.work) {
          limited = true;
          return;
        }
        const fieldKey = JSON.stringify([kind, key]);
        if (unavailableContainerFields.has(fieldKey)) continue;
        let field = fields.get(fieldKey);
        if (!field) {
          if (fields.size >= REQUEST_ANALYSIS_LIMITS.fieldsPerScope) {
            incomplete++;
            continue;
          }
          field = {
            kind,
            key,
            present: 0,
            selectedPresent: 0,
            values: new Map(),
          };
          fields.set(fieldKey, field);
        }
        // Hashes are internal identities only. Keep a bounded excerpt for customer evidence.
        const bodyIdentity =
          kind === 'Body' && key === 'Content' ? source.requestBody.hash : undefined;
        const isContainer = kind === 'JSON' && (value.startsWith('{') || value.startsWith('['));
        const document = isContainer ? categories.get('JSON')?.get('') : undefined;
        const start = document?.indexOf(value) ?? -1;
        const useSpan = isContainer && document !== undefined && start >= 0;
        if (useSpan && containerHashChars + value.length > REQUEST_ANALYSIS_LIMITS.rereadBytes) {
          const unknown = unavailableCounts.get(fieldKey) ?? { count: 0, selected: 0 };
          unknown.count++;
          if (selected) unknown.selected++;
          unavailableCounts.set(fieldKey, unknown);
          incomplete++;
          continue;
        }
        if (useSpan) containerHashChars += value.length;
        field.present++;
        if (selected) field.selectedPresent++;
        const identity = useSpan ? containerIdentity(field, value) : (bodyIdentity ?? value);
        if (identity === undefined) {
          unavailableContainerFields.add(fieldKey);
          incomplete++;
          continue;
        }
        const excerpt = bodyIdentity || useSpan ? evidenceExcerpt(kind, value) : undefined;
        if (!field.values.has(identity)) {
          if (useSpan && !containerDocuments.has(sourceId)) {
            containerDocuments.set(sourceId, document);
            valueBytes += 128 + document.length * 2;
          }
          valueBytes += 128 + (identity.length + (excerpt?.value?.length ?? 0)) * 2;
          if (valueBytes > REQUEST_ANALYSIS_LIMITS.retainedBytes) {
            limited = true;
            return;
          }
        }
        const count = field.values.get(identity) ?? {
          count: 0,
          selected: 0,
          entry: sourceId,
          ...(excerpt ? { displayValue: excerpt.value, displayTruncated: excerpt.truncated } : {}),
          ...(useSpan
            ? {
                containerDocument: document,
                containerStart: start,
                containerLength: value.length,
                containerKind: value.startsWith('{') ? ('object' as const) : ('array' as const),
              }
            : {}),
        };
        count.count++;
        // Accurate lengths remain in baseline evidence, but are not useful payload samples.
        if (selected && !(kind === 'Header' && key === 'content-length' && routineLength)) {
          if (!count.selected) count.entry = sourceId;
          count.selected++;
        }
        field.values.set(identity, count);
      }
    }
  };
  const finish = (sourceLimited = false): RequestChanges => {
    const changes: EvidenceChange<RequestChange>[] = [];
    const redundantJsonContainers = new Set<string>();
    for (const field of limited || sourceLimited ? [] : fields.values()) {
      if (unavailableContainerFields.has(JSON.stringify([field.kind, field.key]))) continue;
      if (field.kind === 'JSON') field.pathTypes = jsonPathTypes(jsonContainers, field.key);
      const unknown = unavailableCounts.get(JSON.stringify([field.kind, field.key]));
      const comparable = (comparableCounts.get(field.kind) ?? 0) - (unknown?.count ?? 0);
      const absent = comparable - field.present;
      if (field.values.size + (absent ? 1 : 0) < 2) continue;
      if (field.kind === 'JSON') {
        const values = [...field.values.entries()];
        if (
          values.every(
            ([value, count]) => count.containerKind === 'object' || value.startsWith('{'),
          ) ||
          values.every(([value, count]) => count.containerKind === 'array' || value.startsWith('['))
        ) {
          redundantJsonContainers.add(field.key);
          if (!absent) continue;
        }
      }
      const mostFrequent = [...field.values].sort((a, b) => b[1].count - a[1].count)[0];
      const absenceDominates = absent > (mostFrequent?.[1].count ?? 0);
      const dominantCount = Math.max(absent, mostFrequent?.[1].count ?? 0);
      const hasDominantValue = dominantCount / comparable >= DOMINANT_VALUE_SHARE;
      const compared = (selectedComparableCounts.get(field.kind) ?? 0) - (unknown?.selected ?? 0);
      const currentFields = currentCategories?.get(field.kind);
      const observed = currentFields?.get(field.key);
      let differs = observed !== undefined;
      if (hasDominantValue && !absenceDominates) {
        const observedIdentity =
          field.kind === 'Body' && field.key === 'Content' && observed !== undefined
            ? (entry?.requestBody.hash ?? observed)
            : field.kind === 'JSON' &&
                observed !== undefined &&
                (observed.startsWith('{') || observed.startsWith('[')) &&
                mostFrequent?.[1].containerKind
              ? containerIdentity(field, observed)
              : observed;
        if (observedIdentity === undefined && observed !== undefined) {
          incomplete++;
          continue;
        }
        differs = observedIdentity !== mostFrequent?.[0];
      }
      // Known absence is only useful with a dominant observed reference, never as a sample value.
      if (
        currentFields &&
        !currentRow?.unavailable?.get(field.kind)?.has(field.key) &&
        !(field.kind === 'JSON' && currentCategories?.get('JSON unavailable')?.has(field.key)) &&
        differs &&
        (observed !== undefined || (hasDominantValue && !absenceDominates))
      ) {
        const reference =
          hasDominantValue && !absenceDominates
            ? (mostFrequent?.[1].displayValue ?? mostFrequent?.[0])
            : undefined;
        const observedExcerpt = evidenceExcerpt(field.kind, observed);
        const referenceExcerpt = evidenceExcerpt(field.kind, reference);
        if (reference !== undefined)
          referenceExcerpt.truncated ||= mostFrequent?.[1].displayTruncated ?? false;
        current.changes.push({
          kind: field.kind,
          key: field.key,
          observed: observedExcerpt.value,
          reference: referenceExcerpt.value,
          inference: hasDominantValue ? 'deviation' : 'variation',
          truncated: observedExcerpt.truncated || referenceExcerpt.truncated,
        });
      }
      const variants = [...field.values].filter(
        ([value, count]) =>
          count.selected && (!hasDominantValue || absenceDominates || value !== mostFrequent?.[0]),
      );
      if (!variants.length) continue;
      const affected = variants.reduce((sum, [, count]) => sum + count.selected, 0);
      const examples = variants.slice(0, REQUEST_ANALYSIS_LIMITS.examples).map(([value, count]) => {
        const excerpt = evidenceExcerpt(field.kind, count.displayValue ?? value);
        return {
          entry: count.entry,
          count: count.selected,
          value: excerpt.value!,
          truncated: excerpt.truncated || (count.displayTruncated ?? false),
        };
      });
      const distinctValues = variants.length;
      changes.push({
        kind: field.kind,
        key: field.key,
        ...(field.pathTypes ? { pathTypes: field.pathTypes } : {}),
        present: field.selectedPresent,
        compared,
        affected,
        distinctValues,
        inference: hasDominantValue ? 'deviation' : 'variation',
        moreValues: distinctValues > examples.length,
        examples,
      });
    }
    const jsonRoot = fields.get(JSON.stringify(['JSON', '']));
    const isEmptyJsonBody = (item: Entry) => {
      const lengths = item.requestHeaders.filter(
        (header) => headerName(header.name) === 'content-length',
      );
      const contentTypes = item.requestHeaders.filter(
        (header) => headerName(header.name) === 'content-type',
      );
      return (
        item.requestBodySize === 0 &&
        (item.requestBody.state === 'missing' ||
          (item.requestBody.state === 'text' && item.requestBody.text === '')) &&
        !item.diagnostics?.some((message) => message.startsWith('Request headers')) &&
        lengths.length === 1 &&
        /^[ \t]*0+[ \t]*$/.test(lengths[0].value) &&
        contentTypes.length === 1 &&
        /^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|\s*$)/i.test(contentTypes[0].value) &&
        !item.requestHeaders.some((header) => headerName(header.name) === 'transfer-encoding')
      );
    };
    const emptyJsonBody =
      !limited &&
      !sourceLimited &&
      selectedIds.size > 0 &&
      jsonRoot?.present &&
      [...selectedIds].every((sourceId) => isEmptyJsonBody(analysis.entries[sourceId]));
    if (emptyJsonBody)
      changes.push({
        kind: 'JSON',
        key: '',
        present: 0,
        compared: selectedIds.size,
        affected: selectedIds.size,
        distinctValues: 1,
        inference: 'variation',
        moreValues: false,
        examples: [
          { entry: id, count: selectedIds.size, value: '', truncated: false, state: 'empty-body' },
        ],
      });
    const hideCookieHeader =
      cookieHeadersCovered &&
      !limited &&
      !sourceLimited &&
      changes.some((change) => change.kind === 'Cookie');
    const visible = customerChanges(
      withoutRedundantRawChanges(changes, { jsonContainers: redundantJsonContainers }),
      {
        hideCookieHeader,
      },
    ).sort(
      (a, b) =>
        (a.inference === 'deviation' ? 0 : 1) - (b.inference === 'deviation' ? 0 : 1) ||
        CATEGORY_ORDER.indexOf(a.kind) - CATEGORY_ORDER.indexOf(b.kind) ||
        (b.affected ?? 0) - (a.affected ?? 0) ||
        a.key.localeCompare(b.key),
    );
    // Candidate selection retains raw evidence; public results show customer fields.
    current.changes = withoutRedundantRawChanges(current.changes);
    const visibleMethods = [...methods.values()].slice(0, 50);
    const currentMethod = methods.get(entry?.method ?? '');
    if (currentMethod && !visibleMethods.includes(currentMethod))
      visibleMethods[49] = currentMethod;
    const contrasts = contrastSelector.finish();
    const notices = new Set<string>();
    if (contentTypeConflict)
      notices.add('Body content type metadata conflicts with the Content-Type header.');
    return {
      ...(contentTypeConflict ? { contentTypeConflict: true } : {}),
      ...(notices.size ? { notices: [...notices] } : {}),
      endpoint: family,
      method: entry?.requestMethodAvailable === false ? undefined : entry?.method,
      partitionEntries: partitionIds.length,
      methods: visibleMethods,
      methodCount: methods.size,
      current: {
        ...current,
        changes: customerChanges(current.changes, {
          hideContentLength: routineContentLength(entry),
          hideCookieHeader:
            hideCookieHeader && current.changes.some((change) => change.kind === 'Cookie'),
        }).map((change) => ({
          ...change,
          ...(change.kind === 'JSON'
            ? { pathTypes: fields.get(JSON.stringify(['JSON', change.key]))?.pathTypes }
            : {}),
        })),
      },
      contrasts: contrasts.map((evidence) => ({
        ...evidence,
        // A hidden order/casing difference means the visible contrast is not exhaustive.
        complete:
          evidence.complete && !evidence.changes.some((change) => change.kind === 'Raw headers'),
        changes: customerChanges(withoutRedundantRawChanges(evidence.changes), {
          hideContentLength:
            routineContentLength(entry, true) &&
            routineContentLength(analysis.entries[evidence.reference], true),
          hideCookieHeader:
            hideCookieHeader && evidence.changes.some((change) => change.kind === 'Cookie'),
        }),
      })),
      contrastsLimited: sourceLimited || contrastSelector.isLimited(),
      entries: selectedIds.size,
      cohortEntries: cohort.filter((sourceId) => sameMethod(analysis.entries[sourceId])).length,
      changes: visible,
      incomplete: incomplete + (limited || sourceLimited ? 1 : 0),
    };
  };
  return { add, finish, cohort, isLimited: () => limited };
}

function validateEntryId(analysis: Analysis, id: number): void {
  if (!Number.isSafeInteger(id) || id < 0 || id >= analysis.entries.length)
    throw new HarError('Select an available entry.', 'INVALID_ARGUMENT');
}

export function requestChanges(analysis: Analysis, id: number): RequestChanges {
  validateEntryId(analysis, id);
  const collector = createCollector(analysis, id, analysis.requestIndex?.rows.get(id));
  for (const sourceId of collector.cohort)
    collector.add(sourceId, analysis.requestIndex?.rows.get(sourceId));
  return collector.finish();
}

/** Query the complete source cohort with bounded aggregation, including evicted index rows. */
export async function requestChangesComplete(
  analysis: Analysis,
  id: number,
): Promise<RequestChanges> {
  validateEntryId(analysis, id);
  const source = sourceFor(analysis);
  const index = analysis.requestIndex;
  if (!source) return requestChanges(analysis, id);
  let rereadBytes = 0;
  let rereadEntries = 0;
  let sourceLimited = false;
  const read = async (sourceId: number): Promise<{ row?: RequestRow; entry?: Entry }> => {
    const retained = index?.rows.get(sourceId);
    const entry = analysis.entries[sourceId];
    if (
      retained &&
      !entry?.requestBody.evicted &&
      (!index?.limited || !retained.categories.has('Incomplete'))
    )
      return { row: retained, entry };
    if (!entry || entry.skipped || entry.sourceStart === undefined || entry.sourceEnd === undefined)
      return { row: retained, entry };
    if (sourceLimited) return { row: retained, entry };
    const bytes = entry.sourceEnd - entry.sourceStart;
    if (
      !Number.isSafeInteger(entry.sourceStart) ||
      !Number.isSafeInteger(entry.sourceEnd) ||
      entry.sourceStart < 0 ||
      bytes < 0 ||
      entry.sourceEnd > source.file.size ||
      rereadEntries >= REQUEST_ANALYSIS_LIMITS.rereadEntries ||
      bytes > REQUEST_ANALYSIS_LIMITS.rereadBytes - rereadBytes
    ) {
      sourceLimited = true;
      return { row: retained, entry };
    }
    rereadBytes += bytes;
    rereadEntries++;
    const wrapped = new Blob([
      '{"log":{"entries":[',
      source.file.slice(entry.sourceStart, entry.sourceEnd),
      ']}}',
    ]);
    for await (const item of streamEntries(wrapped, { ...source.limits, fileBytes: null })) {
      const req = record(record(item.raw).request);
      if (
        (entry.requestUrlAvailable !== false &&
          typeof req.url === 'string' &&
          req.url !== entry.url) ||
        (entry.requestMethodAvailable !== false &&
          typeof req.method === 'string' &&
          req.method !== entry.method)
      )
        throw new HarError(
          'Capture evidence does not match the retained entry. Reimport the HAR.',
          'SOURCE_CHANGED',
        );
      let hydrated = entry;
      if (entry.requestBody.evicted) {
        const post = record(req.postData);
        const mime = requestMediaType(post, entry.requestHeaders).mime;
        const body = await readBody(
          post,
          mime,
          { ...source.limits, totalBodyBytes: source.limits.bodyBytes },
          { bytes: 0, nodes: 0 },
          false,
        );
        if (body.hash !== entry.requestBody.hash)
          throw new HarError(
            'Capture evidence does not match the retained entry. Reimport the HAR.',
            'SOURCE_CHANGED',
          );
        hydrated = { ...entry, requestBody: body };
      }
      const temporary = createRequestIndex();
      indexRequest(temporary, hydrated, item.raw);
      return { row: temporary.rows.get(sourceId), entry: hydrated };
    }
    return {};
  };
  const current = await read(id);
  const collector = createCollector(analysis, id, current.row, current.entry);
  for (const sourceId of collector.cohort) {
    if (collector.isLimited()) break;
    const item = sourceId === id ? current : await read(sourceId);
    collector.add(sourceId, item.row, item.entry);
  }
  // If only body hydration was bounded, use the complete retained index instead of
  // publishing partially hydrated body evidence or discarding indexed fields.
  if (
    sourceLimited &&
    index &&
    !index.limited &&
    collector.cohort.every((sourceId) => index.rows.has(sourceId))
  ) {
    const retained = requestChanges(analysis, id);
    return { ...retained, incomplete: retained.incomplete + 1, contrastsLimited: true };
  }
  return collector.finish(sourceLimited);
}
