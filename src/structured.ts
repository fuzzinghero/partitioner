import { formPairs } from './percent.js';
/** Bounded, transparent field extraction. No DOM, entity resolution, or executable markup. */
import { guardJson, normalizedMediaType } from './parse.js';
import { parseLosslessJson, isNumberToken, numberSource } from './lossless-json.js';
import { xmlFields, multipartFields } from './request-body-fields.js';

const encoder = new TextEncoder();

export const STRUCTURE_LIMITS = {
  bytes: 64 * 1024,
  fields: 200,
  nodes: 2000,
  depth: 32,
  valueChars: 8192,
};
export interface StructuredFields {
  format: 'JSON' | 'XML' | 'Form' | 'Multipart';
  fields: Map<string, string>;
  containers?: Map<string, string>;
  /** Extracted path/type description; XML/multipart output is not a response identity. */
  shape: string;
  nodes: number;
}
const pointer = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
export function structuredFormat(mime: string): StructuredFields['format'] | null {
  const base = normalizedMediaType(mime)?.split(';')[0] ?? '';
  if (/(?:\/json|\+json)$/i.test(base)) return 'JSON';
  if (/(?:\/xml|\+xml)$/i.test(base)) return 'XML';
  if (/^application\/x-www-form-urlencoded(?:;|$)/i.test(base)) return 'Form';
  if (/^multipart\/form-data(?:;|$)/i.test(base)) return 'Multipart';
  return null;
}

export function structuredFields(
  text: string,
  mime: string,
  nodeLimit = STRUCTURE_LIMITS.nodes,
): StructuredFields | null {
  const format = structuredFormat(mime);
  if (!format) return null;
  if (text.length > STRUCTURE_LIMITS.bytes || encoder.encode(text).length > STRUCTURE_LIMITS.bytes)
    throw new Error('Structure size limit');
  const fields = new Map<string, string>(),
    shapes: string[] = [];
  const containers = new Map<string, string>();
  let nodes = 0;
  const step = () => {
    if (++nodes > Math.min(nodeLimit, STRUCTURE_LIMITS.nodes))
      throw new Error('Structure work limit');
  };
  const put = (path: string, value: string, type = 'string') => {
    if (
      ++nodes > Math.min(nodeLimit, STRUCTURE_LIMITS.nodes) ||
      fields.size >= STRUCTURE_LIMITS.fields ||
      value.length > STRUCTURE_LIMITS.valueChars ||
      path.length > STRUCTURE_LIMITS.valueChars ||
      fields.has(path)
    )
      throw new Error('Structure field limit or duplicate path');
    fields.set(path, value);
    shapes.push(JSON.stringify([path, type]));
  };
  if (format === 'JSON') {
    guardJson(text, STRUCTURE_LIMITS.depth, STRUCTURE_LIMITS.nodes * 4);
    const walk = (value: unknown, path: string, depth: number) => {
      if (++nodes > Math.min(nodeLimit, STRUCTURE_LIMITS.nodes) || depth > STRUCTURE_LIMITS.depth)
        throw new Error('Structure work limit');
      if (isNumberToken(value)) {
        put(path, numberSource(value), 'number');
        return;
      }
      if (value === null || typeof value !== 'object') {
        put(path, JSON.stringify(value), value === null ? 'null' : typeof value);
        return;
      }
      shapes.push(JSON.stringify([path, Array.isArray(value) ? 'array' : 'object']));
      const keys = Object.keys(value);
      if (fields.size + containers.size >= STRUCTURE_LIMITS.fields)
        throw new Error('Structure field limit');
      containers.set(path, Array.isArray(value) ? 'array' : 'object');
      if (!keys.length)
        put(path, Array.isArray(value) ? '[]' : '{}', Array.isArray(value) ? 'array' : 'object');
      for (const key of keys.sort())
        walk((value as Record<string, unknown>)[key], `${path}/${pointer(key)}`, depth + 1);
    };
    walk(parseLosslessJson(text), '', 0);
  } else if (format === 'Form') {
    if (/%(?![\da-f]{2})/i.test(text)) throw new Error('Malformed percent escape');
    const counts = new Map<string, number>();
    for (const { name, value } of formPairs(text)) {
      const occurrence = counts.get(name) ?? 0;
      counts.set(name, occurrence + 1);
      put(`/${pointer(name)}/${occurrence}`, value);
    }
  } else if (format === 'XML') {
    xmlFields(text, put, step, STRUCTURE_LIMITS.depth);
  } else {
    multipartFields(text, mime, put, step);
  }
  return {
    format,
    fields,
    containers: format === 'JSON' ? containers : undefined,
    nodes,
    shape: JSON.stringify([format, shapes.sort()]),
  };
}
