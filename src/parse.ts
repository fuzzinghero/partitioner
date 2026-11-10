import type { Header, Limits } from './types.js';
import { HarError } from './errors.js';
export { HarError } from './errors.js';

const encoder = new TextEncoder();
export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Reject excessive JSON work before parsing. Brackets inside strings are inert. */
export function guardJson(text: string, depthLimit: number, tokenLimit: number) {
  let depth = 0,
    tokens = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      tokens++;
    } else if (c === '{' || c === '[') {
      depth++;
      tokens++;
    } else if (c === '}' || c === ']') depth--;
    else if (c === ',' || c === ':') tokens++;
    if (depth > depthLimit || tokens > tokenLimit)
      throw new HarError('JSON nesting or structure budget exceeded. Use a smaller capture.');
  }
}

export function headers(value: unknown, limits: Limits): Header[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > limits.headers)
    throw new HarError('Invalid or excessive headers/query pairs.');
  let bytes = 0;
  return value.map((item) => {
    const h = record(item);
    if (typeof h.name !== 'string' || typeof h.value !== 'string')
      throw new HarError('Invalid header/query pair.');
    bytes += encoder.encode(h.name).length + encoder.encode(h.value).length;
    if (
      h.name.length > limits.fieldChars ||
      h.value.length > limits.fieldChars ||
      bytes > limits.headerBytes
    )
      throw new HarError('Header/query text budget exceeded.');
    return { name: h.name, value: h.value };
  });
}

/** Bounded UTF-16 display prefix without splitting a Unicode surrogate pair. */
export function textPrefix(text: string, chars: number): string {
  const value = text.slice(0, chars);
  return /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
}

/** HTTP field-name folding applies only to ASCII letters. */
export const headerName = (name: string) => name.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Keep repeated values ordered within each field, with optional HTTP name folding. */
export function groupFieldValues(items: Header[], foldHeaderNames = false): Map<string, string> {
  const grouped = new Map<string, string[]>();
  for (const item of items) {
    const key = foldHeaderNames ? headerName(item.name) : item.name;
    const values = grouped.get(key) ?? [];
    values.push(item.value);
    grouped.set(key, values);
  }
  return new Map([...grouped].map(([key, values]) => [key, JSON.stringify(values)]));
}

/** Validate and trim the base media type; preserve parameter text and case. */
export function normalizedMediaType(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 256) return;
  const separator = value.indexOf(';');
  const base = (separator < 0 ? value : value.slice(0, separator)).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(base)) return;
  return base + (separator < 0 ? '' : value.slice(separator));
}

/** Use the same bounded request media type for decoding and field interpretation. */
export function requestMediaType(post: Record<string, unknown>, fields: Header[]) {
  const reported = post.mimeType;
  const accepted = normalizedMediaType(reported);
  if (accepted !== undefined) return { mime: accepted, incomplete: false };
  const fallbacks = fields.filter((field) => headerName(field.name) === 'content-type');
  const value = fallbacks.length === 1 ? fallbacks[0].value : undefined;
  const fallback = normalizedMediaType(value);
  return {
    mime: fallback ?? '',
    incomplete:
      reported !== undefined ||
      fallbacks.length > 1 ||
      (value !== undefined && fallback === undefined),
  };
}
