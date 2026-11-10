import { lexicalDataSpans } from './markup-scan.js';
import { markupSpans, multipartSpans } from './reflection-template.js';
import { isNumberToken, numberSource, parseLosslessJson } from './lossless-json.js';
import { structuredFields, structuredFormat, STRUCTURE_LIMITS } from './structured.js';
import { guardJson } from './parse.js';

export interface ResponseSlot {
  /** A tuple path avoids collisions between object keys, array indices and bookkeeping. */
  path: string;
  type: 'string' | 'number' | 'boolean' | 'null' | 'key' | 'expiry';
  value: string;
  literal?: string;
}
export interface ResponseSlots {
  skeleton: string;
  slots: readonly ResponseSlot[];
}

/** Complete bounded decomposition. Unsupported input has no partial representation. */
export function decomposeBody(text: string, mime: string): ResponseSlots | undefined {
  if (
    text.length > STRUCTURE_LIMITS.bytes ||
    new TextEncoder().encode(text).length > STRUCTURE_LIMITS.bytes
  )
    return;
  try {
    const format = structuredFormat(mime);
    if (format === 'JSON') {
      guardJson(text, STRUCTURE_LIMITS.depth, STRUCTURE_LIMITS.nodes * 4);
      const slots: ResponseSlot[] = [];
      let nodes = 0;
      const walk = (v: unknown, path: unknown[], depth: number): unknown => {
        if (++nodes > STRUCTURE_LIMITS.nodes || depth > STRUCTURE_LIMITS.depth)
          throw new Error('Structure limit');
        const put = (type: ResponseSlot['type'], value: string, slotPath = path) => {
          if (slots.length >= STRUCTURE_LIMITS.fields || value.length > STRUCTURE_LIMITS.valueChars)
            throw new Error('Slot limit');
          slots.push({
            path: JSON.stringify(slotPath),
            type,
            value,
          });
          return type;
        };
        if (isNumberToken(v)) return put('number', numberSource(v));
        if (v === null) return put('null', 'null');
        if (typeof v === 'string') return put('string', v);
        if (typeof v === 'boolean') return put('boolean', String(v));
        if (Array.isArray(v))
          return ['array', v.map((x, i) => walk(x, [...path, ['index', i]], depth + 1))];
        const object = v as Record<string, unknown>;
        const keys = Object.keys(object).sort();
        if (keys.length === 1) {
          put('key', keys[0], [...path, ['key']]);
          return [
            'object',
            [['reflected-key', walk(object[keys[0]], [...path, ['dynamic']], depth + 1)]],
          ];
        }
        return [
          'object',
          keys.map((k) => [k, walk(object[k], [...path, ['property', k]], depth + 1)]),
        ];
      };
      const skeleton = JSON.stringify(['JSON', walk(parseLosslessJson(text), [], 0)]);
      return { skeleton, slots };
    }
    if (format === 'Form') {
      const parsed = structuredFields(text, mime);
      if (!parsed) return;
      return {
        skeleton: parsed.shape,
        slots: [...parsed.fields]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([path, value]) => ({ path, type: 'string', value })),
      };
    }
    const xml = format === 'XML';
    const multipart = format === 'Multipart';
    const html = /^text\/html(?:;|$)/i.test(mime);
    if (xml || multipart) {
      if (!structuredFields(text, mime)) return;
    }
    if (html || xml || multipart || /^text\/plain(?:;|$)/i.test(mime)) {
      const spans =
        html || xml
          ? (markupSpans(text, xml, true) ?? (!xml ? lexicalDataSpans(text) : undefined))
          : multipart
            ? multipartSpans(text, mime)
            : [{ start: 0, end: text.length }];
      if (!spans) return;
      const slots: ResponseSlot[] = [],
        scaffold: unknown[] = [];
      let end = 0;
      for (const [i, span] of spans.entries()) {
        scaffold.push(text.slice(end, span.start));
        const value = text.slice(span.start, span.end);
        if (value.length > STRUCTURE_LIMITS.valueChars) return;
        scaffold.push(['value']);
        slots.push({ path: JSON.stringify(['span', i]), type: 'string', value });
        end = span.end;
      }
      scaffold.push(text.slice(end));
      if (slots.length > 400) return;
      return { skeleton: JSON.stringify([mime.split(';')[0].toLowerCase(), scaffold]), slots };
    }
  } catch {
    /* Malformed/ambiguous/over-budget content remains literal. */
  }
}
