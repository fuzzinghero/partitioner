import { decodePercent, formPairs } from './percent.js';
import { literalTarget } from './families.js';
import { isNumberToken, numberSource, parseLosslessJson } from './lossless-json.js';
import { record } from './parse.js';
import { completeRequestMetadata, type RequestRow } from './request-index.js';
import type { Entry } from './types.js';

export interface InputValue {
  value: string;
  source: string;
  raw?: string;
}

/** Shared input admission defaults, independent of parser and response-work budgets. */
export const INPUT_LIMITS = Object.freeze({ values: 200, valueChars: 4096, bytes: 64 * 1024 });
export const inputStorageBytes = (input: InputValue) =>
  64 + 2 * (input.value.length + input.source.length + (input.raw?.length ?? 0));

/** Complete bounded UTF-8 request text, independent of query/text retention. */
export function capturedRequestText(entry: Entry, raw: unknown): string | undefined {
  const post = record(record(record(raw).request).postData);
  if (
    !entry.requestBody.hash ||
    (entry.requestBody.bytes ?? Infinity) > 64 * 1024 ||
    typeof post.text !== 'string' ||
    post.text.length > 90 * 1024
  )
    return;
  if (
    post._displayEncoding !== undefined &&
    !['utf-8-display', 'utf-8'].includes(String(post._displayEncoding))
  )
    return;
  const declarations = [
    post.mimeType,
    ...entry.requestHeaders
      .filter((h) => h.name.toLowerCase() === 'content-type')
      .map((h) => h.value),
  ];
  if (
    declarations.some(
      (v) =>
        typeof v === 'string' && /charset\s*=\s*(?!["']?(?:utf-?8|us-ascii)(?:["';\s]|$))/i.test(v),
    )
  )
    return;
  if (
    entry.requestHeaders.some(
      (h) =>
        h.name.toLowerCase() === 'content-encoding' && h.value.trim().toLowerCase() !== 'identity',
    )
  )
    return;
  try {
    if (post.encoding === undefined) return post.text;
    if (post.encoding === 'base64')
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        Uint8Array.from(atob(post.text), (c) => c.charCodeAt(0)),
      );
  } catch {
    /* Unavailable decoded bytes do not establish request evidence. */
  }
}

/** Values and occurrence provenance; field names are evidence, not response identities. */
export function slotInputs(
  entry: Entry,
  row: RequestRow | undefined,
  raw?: unknown,
  onLimit?: () => void,
): InputValue[] | undefined {
  if (!completeRequestMetadata(entry, row) || row?.categories.has('Incomplete')) return;
  if (['Form', 'Multipart'].some((kind) => row?.sources?.get(kind) === 'har')) return;
  if (
    raw !== undefined &&
    entry.requestBody.state === 'missing' &&
    entry.requestBodySize !== 0 &&
    record(record(raw).request).postData !== undefined
  )
    return;
  if (
    raw !== undefined &&
    entry.requestBody.state !== 'missing' &&
    entry.requestBody.bytes !== 0 &&
    capturedRequestText(entry, raw) === undefined
  )
    return;
  const representations = new Map<string, string>();
  const remember = (text: string, kind: string) => {
    const counts = new Map<string, number>();
    for (const pair of formPairs(text)) {
      const i = counts.get(pair.name) ?? 0;
      counts.set(pair.name, i + 1);
      const key =
        kind === 'Form'
          ? JSON.stringify([
              kind,
              `/${pair.name.replace(/~/g, '~0').replace(/\//g, '~1')}/${i}/value`,
            ])
          : JSON.stringify([kind, pair.name, i]);
      if (pair.raw !== pair.value) representations.set(key, pair.raw);
    }
  };
  const query = entry.url.split('#')[0].split('?').slice(1).join('?');
  if (query) remember(query, 'Query parameter');
  if (row?.categories.has('Form') && raw !== undefined) {
    const text = capturedRequestText(entry, raw);
    if (text !== undefined) remember(text, 'Form');
  }
  const inputs: InputValue[] = [];
  let bytes = 0;
  const add = (value: unknown, source: string) => {
    if (isNumberToken(value)) value = numberSource(value);
    if (typeof value !== 'string' && typeof value !== 'boolean') return;
    const text = String(value);
    const representation = representations.get(source);
    const input: InputValue = {
      value: text,
      source,
      ...(representation !== undefined ? { raw: representation } : {}),
    };
    bytes += inputStorageBytes(input);
    if (
      text.length > INPUT_LIMITS.valueChars ||
      bytes > INPUT_LIMITS.bytes ||
      inputs.length >= INPUT_LIMITS.values
    ) {
      onLimit?.();
      throw new Error('Input limit');
    }
    inputs.push(input);
  };
  try {
    for (const [kind, fields] of row!.categories) {
      if (
        !['Query parameter', 'Header', 'Cookie', 'JSON', 'Form', 'XML', 'Multipart'].includes(kind)
      )
        continue;
      for (const [key, raw] of fields) {
        if (kind === 'Multipart' && !key.endsWith('/value')) continue;
        const source = JSON.stringify([kind, key]);
        let value: unknown;
        try {
          value = ['JSON', 'Query parameter', 'Header', 'Cookie'].includes(kind)
            ? parseLosslessJson(raw)
            : raw;
        } catch {
          value = raw;
        }
        if (Array.isArray(value)) value.forEach((v, i) => add(v, JSON.stringify([kind, key, i])));
        else add(value, source);
      }
    }
    const path = literalTarget(entry.contextUrl ?? entry.url).path;
    for (const [i, segment] of path.split('/').entries()) {
      if (!segment) continue;
      if (/%(?![\da-f]{2})/i.test(segment)) return;
      const value = decodePercent(segment);
      const source = JSON.stringify(['Path', i]);
      if (value !== segment) representations.set(source, segment);
      add(value, source);
    }
    return inputs;
  } catch {
    return;
  }
}
