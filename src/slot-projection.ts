import { selectReflection } from './slot-reflection.js';
import { valueGrammar } from './value-grammar.js';
import type { SlotTemplate, TemplatePart } from './slot-reflection.js';

export interface SlotProjection {
  shape: (string | { token: number } | Exclude<TemplatePart, string>)[];
  values: string[];
  reflection?: SlotTemplate;
  /** Known discarded copies remain literal and cannot vote in variance inference. */
  literalTokens?: readonly boolean[];
}

/** Tokenize literal regions only after whole-span request matching. No request affects a cohort key. */
export function projectSlot(
  text: string,
  reflection?: SlotTemplate,
  copies: readonly { start: number; end: number }[] = [],
): SlotProjection | undefined {
  if ((reflection?.spans.length ?? 0) > 400 || copies.length > 400) return;
  const shape: SlotProjection['shape'] = [],
    values: string[] = [];
  const pattern =
    /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:ms|us|µs|ns|s)\b|[\p{L}\p{M}\p{N}_+/-]+(?:\.[\p{L}\p{M}\p{N}_+/-]+)*(?:={1,2}(?![\p{L}\p{M}\p{N}_+/.=-]))?/giu;
  if (reflection?.spans.length) {
    const protectedTokens = [...text.matchAll(pattern)].filter(
      (m) =>
        valueGrammar(m[0])?.startsWith('timestamp:') ||
        valueGrammar(m[0])?.startsWith('measurement:') ||
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(m[0]),
    );
    reflection = selectReflection(
      text,
      reflection,
      (span) =>
        !protectedTokens.some(
          (m) =>
            span.start < m.index + m[0].length &&
            span.end > m.index &&
            !(span.start <= m.index && span.end >= m.index + m[0].length),
        ),
    );
    if (!reflection) return;
  }
  const literalTokens: boolean[] = [];
  let offset = 0,
    reflectedSpan = 0;
  const literal = (text: string) => {
    let end = 0;
    for (const m of text.matchAll(pattern)) {
      if (values.length >= 400) return false;
      shape.push(text.slice(end, m.index), { token: values.length });
      values.push(m[0]);
      if (copies.length)
        literalTokens.push(
          copies.some(
            (span) => span.start < offset + m.index + m[0].length && span.end > offset + m.index,
          ),
        );
      end = m.index + m[0].length;
    }
    shape.push(text.slice(end));
    return true;
  };
  for (const part of reflection?.parts ?? [text]) {
    if (typeof part === 'string') {
      if (!literal(part)) return;
      offset += part.length;
    } else {
      shape.push(part);
      const span = reflection?.spans[reflectedSpan++];
      offset += span ? span.end - span.start : 0;
    }
  }
  return { shape, values, reflection, ...(copies.length ? { literalTokens } : {}) };
}
