/** Standard JSON number lexemes are kept intact; no precision-erasing comparison. */
const numeric = Symbol('JSON numeric token');
type NumberToken = { [numeric]: true; source: string };
export const isNumberToken = (v: unknown): v is NumberToken =>
  v !== null && typeof v === 'object' && (v as NumberToken)[numeric] === true;
export const numberSource = (v: NumberToken) => v.source;

export function parseLosslessJson(text: string): unknown {
  let supported = true;
  const parse = JSON.parse as (
    text: string,
    reviver: (key: string, value: unknown, context?: { source?: string }) => unknown,
  ) => unknown;
  const result = parse(text, (_key, value, context) => {
    if (typeof value !== 'number') return value;
    if (context?.source === undefined) {
      supported = false;
      return value;
    }
    return { [numeric]: true, source: context.source };
  });
  if (!supported || duplicateKeys(text))
    throw new Error('Use exact text comparison for ambiguous or unsupported JSON.');
  return result;
}

function duplicateKeys(text: string): boolean {
  const stack: { object: boolean; key: boolean; keys: Set<string> }[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i],
      frame = stack.at(-1);
    if (c === '"') {
      const start = i;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') i += 2;
        else if (text[i] === '"') break;
        else i++;
      }
      if (frame?.object && frame.key) {
        const key = JSON.parse(text.slice(start, i + 1));
        if (frame.keys.has(key)) return true;
        frame.keys.add(key);
        frame.key = false;
      }
    } else if (c === '{' || c === '[')
      stack.push({ object: c === '{', key: c === '{', keys: new Set() });
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ',' && frame?.object) frame.key = true;
  }
  return false;
}

export function formatJson(value: unknown): string | undefined {
  if (isNumberToken(value)) return value.source;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(formatJson).join(',')}]`;
  return `{${Object.keys(value)
    .map((key) => `${JSON.stringify(key)}:${formatJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}
