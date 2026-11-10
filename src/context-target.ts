import { guardJson, headerName, record } from './parse.js';
import type { Header, Limits } from './types.js';

/** Resolve context only; never rewrite the captured request target or headers. */
export function contextTarget(
  url: string,
  headers: Header[],
  comment: unknown,
  limits: Limits,
  diagnostics: string[],
): string | undefined {
  if (!url.startsWith('/')) return;
  const origin = (scheme: unknown, authority: unknown): string | undefined => {
    if (
      typeof scheme !== 'string' ||
      !/^https?$/i.test(scheme) ||
      typeof authority !== 'string' ||
      !/^[^/?#@\\\s]+$/.test(authority)
    )
      return;
    try {
      const parsed = new URL(`${scheme}://${authority}`);
      if (parsed.hostname) return parsed.origin;
    } catch {
      /* Invalid target hints cannot establish an origin. */
    }
  };
  let resolved: string | undefined;
  let assumedScheme = false;
  // Fuzzing Hero HAR comments retain the transport target independently of fuzzed Host values.
  if (typeof comment === 'string' && comment.length <= limits.fieldChars) {
    try {
      guardJson(comment, Math.min(limits.jsonDepth, 16), Math.min(limits.jsonTokens, 4096));
      const meta = record(record(JSON.parse(comment)).meta);
      for (const prefix of ['target', 'protocol']) {
        if (meta[`${prefix}_path`] !== url) continue;
        resolved = origin(meta[`${prefix}_scheme`], meta[`${prefix}_authority`]);
        if (resolved) break;
      }
    } catch {
      /* A free-form, malformed, or excessive comment is not routing evidence. */
    }
  }
  if (!resolved) {
    const values = (name: string) => headers.filter((h) => headerName(h.name) === name);
    const schemes = values(':scheme');
    const authorities = values(':authority');
    const hosts = values('host');
    const authority = authorities.length ? authorities : hosts;
    if (schemes.length > 1 || authority.length !== 1) return;
    const scheme = schemes[0]?.value ?? 'http';
    assumedScheme = schemes.length === 0;
    resolved = origin(scheme, authority[0].value);
    // Without independent target metadata, conflicting authority evidence stays unresolved.
    if (resolved && [...authorities, ...hosts].some((h) => origin(scheme, h.value) !== resolved))
      return;
  }
  if (resolved && resolved.length + url.length <= limits.fieldChars) {
    if (assumedScheme)
      diagnostics.push('Request context assumes HTTP because no scheme was captured.');
    return resolved + url;
  }
}
