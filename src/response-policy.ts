import { headerName } from './parse.js';
import { sha256 } from './body.js';
import type { Entry } from './types.js';

const encoder = new TextEncoder();

// Only explicit transport/diagnostic noise is ignored. Unknown headers remain significant.
const VOLATILE_RESPONSE_HEADERS = new Set(['date', 'content-length', 'traceparent', 'tracestate']);

function validTracestate(value: string): boolean {
  // Longer fields remain evidence rather than expanding noise-validation work.
  if (value.length > 512) return false;
  const members = value.split(',');
  if (members.length > 32) return false;
  const keys = new Set<string>();
  for (const member of members) {
    const trimmed = member.replace(/^[ \t]+|[ \t]+$/g, '');
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    const key = trimmed.slice(0, separator),
      content = trimmed.slice(separator + 1);
    if (
      separator < 0 ||
      !/^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})$/.test(
        key,
      ) ||
      !/^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/.test(content) ||
      keys.has(key)
    )
      return false;
    keys.add(key);
  }
  return keys.size > 0;
}

/** These names are owned by validated protocol policy, including malformed values. */
export function hasProtocolNoisePolicy(name: string): boolean {
  return VOLATILE_RESPONSE_HEADERS.has(name);
}

export function responseHeaderKey(entry: Entry): string {
  if (entry.diagnostics?.some((d) => d.startsWith('Response headers')))
    return `unavailable:${entry.id}`;
  if (entry.responseHeadersAvailable === false) return 'not-captured';
  const headers = new Map<string, string[]>();
  for (const { name, value } of entry.responseHeaders) {
    const key = headerName(name);
    const values = headers.get(key) ?? [];
    values.push(value);
    headers.set(key, values);
  }
  const ignore = (name: string, values: string[]) => {
    if (
      !hasProtocolNoisePolicy(name) ||
      values.length !== 1 ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\r\n]/.test(values[0])
    )
      return false;
    if (name === 'content-length') return /^[ \t]*\d+[ \t]*$/.test(values[0]);
    if (name === 'date')
      return (
        /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12]\d|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/.test(
          values[0],
        ) &&
        // Round-trip rejects impossible dates and mismatched weekdays.
        new Date(values[0]).toUTCString() === values[0]
      );
    if (name === 'traceparent') {
      // Only the understood version is noise; future formats remain captured evidence.
      const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(values[0]);
      return Boolean(match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2]));
    }
    if (name === 'tracestate') return validTracestate(values[0]);
    return true;
  };
  return JSON.stringify(
    [...headers]
      .filter(([name, values]) => !ignore(name, values))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export interface HeaderFingerprintCache {
  bytes: number;
  values: Map<string, string>;
}
/** Keep large captured headers out of partition/index keys; bound memoized source strings. */
export async function fingerprintResponseHeaders(
  entry: Entry,
  cache: HeaderFingerprintCache,
): Promise<string> {
  const key = responseHeaderKey(entry),
    cached = cache.values.get(key);
  if (cached) return cached;
  const hash = await sha256(encoder.encode(key));
  const bytes = key.length * 2 + 192,
    maximum = 1024 * 1024;
  if (bytes <= maximum) {
    while (cache.bytes + bytes > maximum || cache.values.size >= 4096) {
      const first = cache.values.keys().next().value!;
      cache.values.delete(first);
      cache.bytes -= first.length * 2 + 192;
    }
    cache.values.set(key, hash);
    cache.bytes += bytes;
  }
  return hash;
}
