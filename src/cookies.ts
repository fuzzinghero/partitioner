import { groupFieldValues, headerName, record } from './parse.js';
import { STRUCTURE_LIMITS } from './structured.js';
import type { Header } from './types.js';

const encoder = new TextEncoder();
const COOKIE_PAIR =
  /^[ \t]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)=([\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*|"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*")[ \t]*$/;
const unquoteCookie = (value: string) =>
  value.startsWith('"') && value.endsWith('"') && COOKIE_PAIR.test(`cookie=${value}`)
    ? value.slice(1, -1)
    : value;
type CookieLayout = [prefix: string, quoted: boolean, suffix: string];

function boundedValues(items: Header[], unquote = false): Map<string, string> | undefined {
  if (items.length > STRUCTURE_LIMITS.fields) return;
  let size = 0;
  for (const { name, value } of items) {
    if (name.length > STRUCTURE_LIMITS.valueChars || value.length > STRUCTURE_LIMITS.valueChars)
      return;
    size += encoder.encode(name).length + encoder.encode(value).length;
    if (size > STRUCTURE_LIMITS.bytes) return;
  }
  return groupFieldValues(
    unquote ? items.map((item) => ({ ...item, value: unquoteCookie(item.value) })) : items,
  );
}

/** One grammar for named values and the exact formatting around each value. */
function parseCookieHeaders(headers: Header[]) {
  const raw = headers.filter((header) => headerName(header.name) === 'cookie');
  if (!raw.length) return;
  let size = 0;
  const items: Header[] = [];
  const layout: CookieLayout[][] = [];
  for (const header of raw) {
    size += header.value.length;
    if (size > STRUCTURE_LIMITS.bytes) return;
    const field: CookieLayout[] = [];
    for (const pair of header.value.split(';')) {
      if (items.length >= STRUCTURE_LIMITS.fields) return;
      const match = COOKIE_PAIR.exec(pair);
      if (!match) return;
      items.push({ name: match[1], value: unquoteCookie(match[2]) });
      const prefixLength = pair.indexOf('=') + 1;
      field.push([
        pair.slice(0, prefixLength),
        match[2].startsWith('"'),
        pair.slice(prefixLength + match[2].length),
      ]);
    }
    layout.push(field);
  }
  const fields = boundedValues(items);
  if (fields) return { fields, layout: JSON.stringify(layout) };
}

/** A stable layout means all changing header bytes are represented by named values. */
export function cookieHeaderLayout(headers: Header[], fields?: ReadonlyMap<string, string>) {
  if (!fields) return;
  const parsed = parseCookieHeaders(headers);
  if (
    parsed &&
    parsed.fields.size === fields.size &&
    [...parsed.fields].every(([name, value]) => fields.get(name) === value)
  )
    return parsed.layout;
}

/** Malformed captured syntax stays unknown; exporter metadata cannot override it. */
export function cookieFields(headers: Header[], captured: unknown) {
  const header = parseCookieHeaders(headers)?.fields;
  let items: Header[] | undefined;
  if (Array.isArray(captured) && captured.length <= STRUCTURE_LIMITS.fields) {
    items = [];
    for (const item of captured) {
      const cookie = record(item);
      if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string') {
        items = undefined;
        break;
      }
      items.push({ name: cookie.name, value: cookie.value });
    }
  }
  const har = items && boundedValues(items, true);
  const conflict = Boolean(
    header &&
      har &&
      (header.size !== har.size || [...header].some(([name, value]) => har.get(name) !== value)),
  );
  return { header, har, conflict };
}
