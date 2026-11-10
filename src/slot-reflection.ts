import { reflectionVariants } from './reflection-template.js';
import { INPUT_LIMITS, type InputValue } from './request-evidence.js';

export type TemplatePart = string | { reflected: number; encoding: string };
export interface SlotTemplate {
  parts: TemplatePart[];
  values: string[];
  sources: string[][];
  spans: { start: number; end: number }[];
}

export interface ReflectionCandidate {
  ambiguous?: boolean;
  encoding: string;
  sources: string[];
  input: string;
}

/** Prepare bounded encoding variants once per entry, shared by all response slots. */
export function prepareReflections(
  inputs: readonly InputValue[],
  spend: (work: number) => boolean,
) {
  const candidates = new Map<string, ReflectionCandidate>();
  for (const input of inputs) {
    if (!input.value) continue;
    for (const variant of reflectionVariants(
      { value: input.value, field: input.source, raw: input.raw },
      { maxChars: INPUT_LIMITS.valueChars },
    )) {
      if (!spend(variant.value.length + 1)) return;
      const existing = candidates.get(variant.value);
      if (existing && (existing.encoding !== variant.encoding || existing.input !== input.value))
        existing.ambiguous = true;
      if (existing) existing.sources.push(input.source);
      else
        candidates.set(variant.value, {
          encoding: variant.encoding,
          sources: [input.source],
          input: input.value,
        });
    }
  }
  return candidates;
}

/** Request-grounded spans precede affix discovery. Short inputs need token boundaries. */
export function reflectSlot(
  text: string,
  inputs: readonly InputValue[],
  spend: (work: number) => boolean,
): SlotTemplate | undefined {
  const candidates = prepareReflections(inputs, spend);
  return candidates && reflectPreparedSlot(text, candidates, spend);
}

export function reflectPreparedSlot(
  text: string,
  candidates: ReadonlyMap<string, ReflectionCandidate>,
  spend: (work: number) => boolean,
): SlotTemplate | undefined {
  const spans: {
    start: number;
    end: number;
    value: string;
    encoding: string;
    sources: string[];
  }[] = [];
  for (const [value, candidate] of candidates) {
    if (candidate.ambiguous || value.length > text.length) continue;
    if (!spend(text.length + value.length)) return;
    let at = 0;
    while ((at = text.indexOf(value, at)) !== -1) {
      if (!spend(value.length + 1)) return;
      const before = [...text.slice(Math.max(0, at - 2), at)].at(-1) ?? '';
      const after = String.fromCodePoint(text.codePointAt(at + value.length) ?? 0);
      const word = /^[\p{L}\p{M}\p{N}_]+$/u.test(value);
      if (!word || (!/[\p{L}\p{M}\p{N}_]/u.test(before) && !/[\p{L}\p{M}\p{N}_]/u.test(after)))
        spans.push({
          start: at,
          end: at + value.length,
          value: candidate.input,
          encoding: candidate.encoding,
          sources: candidate.sources,
        });
      at += value.length;
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const parts: TemplatePart[] = [],
    values: string[] = [],
    sources: string[][] = [];
  const selected: { start: number; end: number }[] = [];
  let end = 0;
  for (const span of spans) {
    if (span.start < end) continue;
    selected.push({ start: span.start, end: span.end });
    let alias = values.indexOf(span.value);
    if (alias < 0) {
      alias = values.length;
      values.push(span.value);
      sources.push([...new Set(span.sources)]);
    }
    parts.push(text.slice(end, span.start), { reflected: alias, encoding: span.encoding });
    end = span.end;
  }
  if (!parts.length) return;
  parts.push(text.slice(end));
  return { parts, values, sources, spans: selected };
}

/** Keep selected complete matches, rebuilding literals and aliases at the original offsets. */
export function selectReflection(
  text: string,
  template: SlotTemplate,
  keep: (span: { start: number; end: number }, index: number) => boolean,
): SlotTemplate | undefined {
  const parts: TemplatePart[] = [],
    values: string[] = [],
    sources: string[][] = [],
    spans: SlotTemplate['spans'] = [];
  let end = 0;
  for (const [index, span] of template.spans.entries()) {
    if (!keep(span, index)) continue;
    const part = template.parts[index * 2 + 1];
    if (typeof part === 'string') return;
    const value = template.values[part.reflected];
    let alias = values.indexOf(value);
    if (alias < 0) {
      alias = values.length;
      values.push(value);
      sources.push(template.sources[part.reflected]);
    }
    parts.push(text.slice(end, span.start), { ...part, reflected: alias });
    spans.push(span);
    end = span.end;
  }
  if (!spans.length) return;
  parts.push(text.slice(end));
  return { parts, values, sources, spans };
}
