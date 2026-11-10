export type ValueGrammar = 'timestamp:iso' | 'timestamp:http' | 'opaque' | `measurement:${string}`;

/** Strict calendar syntax, independent of response clock correlation. Bare numbers are not dates. */
export function timestampGrammar(value: string): 'timestamp:iso' | 'timestamp:http' | undefined {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (m) {
    const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
    const check = new Date(0);
    check.setUTCFullYear(year, month - 1, day);
    check.setUTCHours(hour, minute, second, 0);
    if (
      check.getUTCFullYear() === year &&
      check.getUTCMonth() === month - 1 &&
      check.getUTCDate() === day &&
      check.getUTCHours() === hour &&
      check.getUTCMinutes() === minute &&
      check.getUTCSeconds() === second
    )
      return 'timestamp:iso';
    return;
  }
  const normalized = value.replace(/, (\d) /, ', 0$1 ');
  if (new Date(normalized).toUTCString() === normalized && / GMT$/.test(normalized))
    return 'timestamp:http';
}

/** Value syntax is evidence for a cohort, never equality by itself. */
export function valueGrammar(value: string): ValueGrammar | undefined {
  if (value.length > 8192) return;
  const stamp = timestampGrammar(value);
  if (stamp) return stamp;
  const measurement = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(ms|s|us|µs|ns)$/.exec(value);
  if (measurement) return `measurement:${measurement[1]}`;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    return 'opaque';
  if (/^[0-9a-f]{16,128}$/i.test(value) && new Set(value.toLowerCase()).size >= 6) return 'opaque';
  if (
    value.length < 16 ||
    value.length > 4096 ||
    !/^[A-Za-z0-9_+/=.-]+$/.test(value) ||
    !/[A-Za-z]/.test(value) ||
    !/\d/.test(value)
  )
    return;
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    entropy -= p * Math.log2(p);
  }
  if (entropy >= 3.2) return 'opaque';
}
export function distributionValue(value: string, type: string): boolean {
  if (type === 'number' || (type === 'string' && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)))
    return true;
  return (
    type === 'string' &&
    value.length >= 8 &&
    /^[A-Za-z0-9_+/=.-]+$/.test(value) &&
    /[A-Za-z]/.test(value) &&
    /\d/.test(value) &&
    !/^[A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)+$/.test(value)
  );
}
