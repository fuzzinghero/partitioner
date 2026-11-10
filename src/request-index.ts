import { formPairs } from './percent.js';
import { literalTarget } from './families.js';
import {
  record,
  requestMediaType,
  headerName,
  groupFieldValues,
  normalizedMediaType,
} from './parse.js';
import { cookieFields } from './cookies.js';
import { structuredFields, structuredFormat, STRUCTURE_LIMITS } from './structured.js';
import type { Entry } from './types.js';

const encoder = new TextEncoder();

export const REQUEST_ANALYSIS_LIMITS = {
  fieldsPerScope: 500,
  retainedBytes: 24 * 1024 * 1024,
  work: 5_000_000,
  examples: 5,
  contrastWork: 100_000,
  rereadBytes: 32 * 1024 * 1024,
  rereadEntries: 1000,
};
export type RequestCategories = Map<string, Map<string, string>>;
export type RequestFieldSource = 'headers' | 'body' | 'har';
export type RequestRow = {
  scope: string;
  categories: RequestCategories;
  /** Media type without parameters survives failed or unavailable body interpretation. */
  bodyMime?: string;
  /** Provenance is independent of the logical change category. */
  sources?: Map<string, RequestFieldSource>;
  /** Exporter metadata cannot establish absence of omitted file contents or metadata. */
  unavailable?: Map<string, Set<string>>;
};
type Pools = {
  fields: Map<string, { id: number; fields: Map<string, string> }>;
  vectors: Map<string, RequestCategories>;
  metadata?: Map<string, Pick<RequestRow, 'sources' | 'unavailable' | 'bodyMime'>>;
};
export interface RequestIndex {
  pools?: Pools;
  rows: Map<number, RequestRow>;
  bytes: number;
  work: number;
  limited: boolean;
}
export const createRequestIndex = (): RequestIndex => ({
  rows: new Map(),
  bytes: 0,
  work: 0,
  limited: false,
});

export function requestScope(url: string): { url: string; parent: string } {
  const { origin, path } = literalTarget(url);
  return { url: origin + path, parent: origin + path.slice(0, path.lastIndexOf('/') + 1) };
}

/** Request-reflection candidates require available captured routing and metadata.
 * Response-noise analysis and exact equality are independent of this inventory. */
export function completeRequestMetadata(entry: Entry, row: RequestRow | undefined): boolean {
  return (
    !!row &&
    entry.requestMethodAvailable !== false &&
    entry.requestUrlAvailable !== false &&
    !!entry.requestHeadersHash &&
    row.categories.has('Header') &&
    row.categories.has('Query parameter') &&
    !(entry.requestBody.state === 'missing' && (entry.requestBodySize ?? 0) > 0)
  );
}

function harFormFields(captured: unknown) {
  if (!Array.isArray(captured) || captured.length > STRUCTURE_LIMITS.fields) return;
  const fields = new Map<string, string>(),
    unavailable = new Set<string>(),
    counts = new Map<string, number>();
  let bytes = 0;
  for (const item of captured) {
    const param = record(item);
    if (
      typeof param.name !== 'string' ||
      (param.value === undefined && param.fileName === undefined)
    )
      return;
    for (const key of ['name', 'value', 'fileName', 'contentType']) {
      if (param[key] !== undefined && typeof param[key] !== 'string') return;
      const value = (param[key] as string) ?? '';
      if (value.length > STRUCTURE_LIMITS.valueChars) return;
      bytes += encoder.encode(value).length;
      if (bytes > STRUCTURE_LIMITS.bytes) return;
    }
    const n = counts.get(param.name) ?? 0;
    counts.set(param.name, n + 1);
    const path = `/${param.name.replace(/~/g, '~0').replace(/\//g, '~1')}/${n}`;
    for (const [key, suffix] of [
      ['value', 'value'],
      ['fileName', '@filename'],
      ['contentType', '@content-type'],
    ]) {
      if (typeof param[key] === 'string') fields.set(`${path}/${suffix}`, param[key]);
      else unavailable.add(`${path}/${suffix}`);
    }
    if (fields.size > STRUCTURE_LIMITS.fields) return;
  }
  return { fields, unavailable };
}

function formFields(fields: Map<string, string>) {
  return new Map([...fields].map(([key, value]) => [`${key}/value`, value]));
}

/** Extract one bounded transient row before any capture-wide query admission decision. */
export function collectRequestRow(entry: Entry, raw: unknown): RequestRow | undefined {
  if (entry.skipped) return;
  const identity = requestScope(entry.contextUrl ?? entry.url);
  let incomplete = false;
  const categories = new Map<string, Map<string, string>>();
  const sources = new Map<string, RequestFieldSource>();
  const unavailable = new Map<string, Set<string>>();
  const diagnose = (message: string) => {
    if (!entry.diagnostics?.includes(message)) (entry.diagnostics ??= []).push(message);
  };
  const request = record(record(raw).request);
  const post = record(request.postData);
  if (
    entry.requestMethodAvailable !== false &&
    typeof request.method === 'string' &&
    request.method === entry.method
  )
    categories.set('HTTP method', new Map([['Method', entry.method]]));
  else incomplete = true;
  if (
    Array.isArray(request.headers) &&
    !entry.diagnostics?.some((d) => d.startsWith('Request headers'))
  ) {
    categories.set('Header', groupFieldValues(entry.requestHeaders, true));
    if (entry.requestHeadersHash)
      categories.set(
        'Raw headers',
        new Map([['Ordered fields (SHA-256)', entry.requestHeadersHash]]),
      );
    if (!entry.requestHeaders.some((h) => headerName(h.name) === 'cookie')) {
      categories.set('Cookie', new Map());
      sources.set('Cookie', 'headers');
    }
  } else incomplete = true;
  const cookies = cookieFields(entry.requestHeaders, request.cookies);
  const hasCookieHeader = entry.requestHeaders.some((h) => headerName(h.name) === 'cookie');
  if (cookies.header && categories.has('Header')) {
    categories.set('Cookie', cookies.header);
    sources.set('Cookie', 'headers');
  } else if (
    !hasCookieHeader &&
    cookies.har &&
    (!categories.has('Cookie') || cookies.har.size > 0)
  ) {
    categories.set('Cookie', cookies.har);
    sources.set('Cookie', 'har');
    diagnose('Request cookies use HAR metadata. No Cookie header was captured.');
  }
  if (cookies.conflict)
    diagnose('Request Cookie headers conflict with HAR cookies. Header values are authoritative.');
  if (entry.requestHttpVersion)
    categories.set('Protocol', new Map([['HTTP version', entry.requestHttpVersion]]));
  if (entry.requestUrlAvailable === false || !entry.url) {
    incomplete = true;
    if (
      Array.isArray(request.queryString) &&
      !entry.diagnostics?.some((message) => message.startsWith('Query fields'))
    )
      categories.set('Query parameter', groupFieldValues(entry.query));
  } else
    try {
      // URL query is authoritative when present. HAR pairs are a fallback when omitted from URL.
      const queryUrl = entry.url.split('#')[0];
      const query = queryUrl.includes('?') ? queryUrl.slice(queryUrl.indexOf('?') + 1) : undefined;
      categories.set(
        'Raw query',
        new Map([['Query representation', JSON.stringify(query === undefined ? [] : [query])]]),
      );
      if (query !== undefined) {
        if (query.length > 8192 || query.split('&').length > 200 || /%(?![\da-f]{2})/i.test(query))
          throw new Error();
        categories.set('Query parameter', groupFieldValues([...formPairs(query)]));
      } else if (entry.diagnostics?.some((d) => d.startsWith('Query fields'))) incomplete = true;
      // Exporters commonly use null for an empty query array. With a captured
      // URL and no query component it has the same evidence as an omitted array.
      else categories.set('Query parameter', groupFieldValues(entry.query));
    } catch {
      incomplete = true;
    }
  if (entry.requestBody.hash)
    categories.set('Body', new Map([['Content hash (SHA-256)', entry.requestBody.hash]]));
  const { mime, incomplete: mediaIncomplete } = requestMediaType(post, entry.requestHeaders);
  const bodyMime = mime.split(';')[0].trim().toLowerCase();
  incomplete ||= mediaIncomplete;
  if (mime && (post.text !== undefined || post.params !== undefined)) {
    categories.set('Body format', new Map([['Media type', bodyMime]]));
    if (mime.includes(';')) categories.get('Body format')!.set('Captured media type', mime);
  }
  if (post.text !== undefined || post.params !== undefined)
    categories.set(
      'Body representation',
      new Map([
        [
          'Representation',
          typeof post.text === 'string'
            ? post.text === ''
              ? 'Empty text'
              : 'Opaque text'
            : 'Unavailable text',
        ],
      ]),
    );
  if (typeof post.text === 'string') {
    try {
      const format = structuredFormat(mime);
      if (format === 'XML' || format === 'Multipart') {
        const contentTypes = entry.requestHeaders.filter(
          (field) => headerName(field.name) === 'content-type',
        );
        const captured =
          contentTypes.length === 1 ? normalizedMediaType(contentTypes[0].value) : undefined;
        const signature = (value: string) => {
          const separator = value.indexOf(';');
          return (
            (separator < 0 ? value : value.slice(0, separator)).trim().toLowerCase() +
            (format === 'Multipart' && separator >= 0 ? value.slice(separator).trim() : '')
          );
        };
        if (
          contentTypes.length > 0 &&
          (captured === undefined || signature(captured) !== signature(mime))
        )
          throw new Error('Ambiguous request media type');
      }
      if (entry.requestBody.state === 'invalid' || entry.requestBody.state === 'limited')
        throw new Error('Request body unavailable for interpretation');
      let text = post.text;
      if (post.encoding === 'base64') {
        // Use the same decoded bytes as body comparison, independently of text retention.
        if (
          entry.requestBody.state !== 'text' ||
          entry.requestBody.bytes === undefined ||
          entry.requestBody.bytes > STRUCTURE_LIMITS.bytes
        )
          throw new Error('Decoded request body unavailable for structure extraction');
        text =
          entry.requestBody.text ??
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            Uint8Array.from(atob(text.replace(/[\t\n\f\r ]/g, '')), (char) => char.charCodeAt(0)),
          );
      }
      const parsed = structuredFields(text, mime);
      if (parsed) {
        const isForm = parsed.format === 'Form';
        const fields = isForm ? formFields(parsed.fields) : parsed.fields;
        const kind = parsed.format;
        categories.set(kind, fields);
        sources.set(kind, 'body');
        if (isForm && post.params !== undefined) {
          const har = harFormFields(post.params);
          if (!har)
            diagnose(
              'HAR form parameters are invalid or excessive. Body values are authoritative.',
            );
          else if (
            [...new Set([...fields.keys(), ...har.fields.keys()])].some(
              (key) => !har.unavailable.has(key) && fields.get(key) !== har.fields.get(key),
            )
          )
            diagnose(
              'Request body fields conflict with HAR form parameters. Body values are authoritative.',
            );
        }
        if (parsed.containers) categories.set('JSON structure', parsed.containers);
        if (entry.requestBody.hash && (kind === 'JSON' || kind === 'Form'))
          categories.set('Raw body', new Map([['Content hash (SHA-256)', entry.requestBody.hash]]));
        // XML/multipart fields are supplemental: order, markup and part headers stay significant.
        if (kind === 'JSON' || kind === 'Form') categories.delete('Body');
        categories.get('Body representation')?.set('Representation', kind);
      } else if (!entry.requestBody.hash) incomplete = true;
    } catch {
      incomplete = true;
    }
  } else if (post.text === undefined && post.params !== undefined) {
    const har = harFormFields(post.params);
    if (har) {
      const kind = /^multipart\/form-data(?:;|$)/i.test(mime) ? 'Multipart' : 'Form';
      categories.set(kind, har.fields);
      categories.set('Body representation', new Map([['Representation', kind]]));
      sources.set(kind, 'har');
      unavailable.set(kind, har.unavailable);
      diagnose('Request form fields use HAR parameters. Body text was not captured.');
    } else incomplete = true;
  } else if (post.text !== undefined) incomplete = true;
  for (const [kind, fields] of categories) {
    if (
      fields.size > STRUCTURE_LIMITS.fields ||
      [...fields].some(([k, v]) => k.length > 8192 || v.length > STRUCTURE_LIMITS.valueChars)
    ) {
      categories.delete(kind);
      sources.delete(kind);
      unavailable.delete(kind);
      if (kind !== 'Cookie') incomplete = true;
      continue;
    }
  }
  if (incomplete) categories.set('Incomplete', new Map());
  return {
    scope: identity.url,
    categories,
    sources,
    unavailable,
    bodyMime,
  };
}

/** Query retention never determines which transient fields are eligible for reflection. */
export function indexRequest(
  index: RequestIndex,
  entry: Entry,
  raw: unknown,
): RequestRow | undefined {
  const row = collectRequestRow(entry, raw);
  if (!row) return;
  const work = [...row.categories.values()].reduce((sum, fields) => sum + fields.size, 0);
  if (index.work + work > REQUEST_ANALYSIS_LIMITS.work) {
    index.limited = true;
    return row;
  }
  index.work += work;
  retainRequestRow(index, entry.id, row);
  return row;
}

function retainRequestRow(index: RequestIndex, id: number, row: RequestRow) {
  const { categories } = row;
  // Intern complete category vectors: repeated schemas/values cost references per entry,
  // rather than copying a map and all its strings for every captured request.
  const pools: Pools = (index.pools ??= { fields: new Map(), vectors: new Map() });
  const metadataKey = JSON.stringify([
    row.bodyMime,
    [...(row.sources ?? [])],
    [...(row.unavailable ?? [])].map(([kind, keys]) => [kind, [...keys]]),
  ]);
  const metadata = pools.metadata?.get(metadataKey);
  let bytes = 128;
  if (!metadata) {
    bytes += 128 + metadataKey.length * 2 + (row.sources?.size ?? 0) * 96;
    for (const keys of row.unavailable?.values() ?? [])
      bytes += 64 + [...keys].reduce((sum, key) => sum + 64 + key.length * 2, 0);
  }
  const pending: { key: string; id: number; fields: Map<string, string> }[] = [];
  const vector: number[] = [];
  for (const [kind, fields] of categories) {
    const key = JSON.stringify([kind, [...fields]]),
      existing = pools.fields.get(key);
    if (existing) {
      categories.set(kind, existing.fields);
      vector.push(existing.id);
    } else {
      const id = pools.fields.size + pending.length;
      bytes +=
        key.length * 2 +
        128 +
        [...fields].reduce((sum, [k, v]) => sum + 96 + (k.length + v.length) * 2, 0);
      pending.push({ key, id, fields });
      vector.push(id);
    }
  }
  const vectorKey = vector.join(','),
    shared = pools.vectors.get(vectorKey);
  if (!shared) bytes += 128 + categories.size * 64 + vectorKey.length * 2;
  if (index.bytes + bytes > REQUEST_ANALYSIS_LIMITS.retainedBytes) {
    index.limited = true;
    return;
  }
  for (const item of pending) pools.fields.set(item.key, item);
  if (!shared) pools.vectors.set(vectorKey, categories);
  const retainedMetadata = metadata ?? {
    sources: row.sources,
    unavailable: row.unavailable,
    bodyMime: row.bodyMime,
  };
  if (!metadata) (pools.metadata ??= new Map()).set(metadataKey, retainedMetadata);
  index.bytes += bytes;
  index.rows.set(id, { scope: row.scope, ...retainedMetadata, categories: shared ?? categories });
}
