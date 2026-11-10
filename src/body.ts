import { parseLosslessJson, isNumberToken, numberSource } from './lossless-json.js';
import { xmlAttributeTemplate } from './xml-canonical.js';
import { structuredFields, structuredFormat, STRUCTURE_LIMITS } from './structured.js';
import { guardJson, HarError, record } from './parse.js';
import type { Body, Entry, Limits } from './types.js';
import { PREVIEW_CHARS } from './types.js';

const encoder = new TextEncoder();

export interface Budget {
  bytes: number;
  nodes: number;
  shapes?: Map<string, Pick<Body, 'shape' | 'shapeKind' | 'shapeWarning'>>;
}
export const sha256 = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
export const isJson = (mime: string) => structuredFormat(mime) === 'JSON';
/** Shared response boundary identity; missing declarations need validated detection. */
export const responseMimeIdentity = (entry: Entry) =>
  entry.responseMimeAvailable === false
    ? entry.body.shapeKind === 'Detected JSON canonical values'
      ? ['not-declared', 'detected-json']
      : ['unavailable', entry.id]
    : entry.mime.split(';')[0].trim().toLowerCase();
const isText = (mime: string) => {
  const base = mime.split(';', 1)[0].trim();
  return (
    /^multipart\/form-data(?:;|$)/i.test(base) ||
    /^(text\/|application\/(json|.*\+json|javascript|xml|.*\+xml|x-www-form-urlencoded)(?:;|$))/i.test(
      base,
    )
  );
};
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const codeUnit = text.charCodeAt(i);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

/** Value-preserving canonical JSON with ordered arrays and lossless numeric lexemes. */
export function jsonShape(value: unknown, limits: Limits, budget: Budget): string {
  let nodes = 0;
  const walk = (node: unknown, depth: number): unknown => {
    if (
      ++nodes > limits.shapeNodes ||
      ++budget.nodes > limits.totalShapeNodes ||
      depth > limits.shapeDepth
    )
      throw new HarError('JSON structure budget exceeded.');
    if (isNumberToken(node)) return ['number', numberSource(node)];
    if (node === null) return ['null'];
    if (Array.isArray(node)) return ['array', node.map((item) => walk(item, depth + 1))];
    if (typeof node === 'object')
      return [
        'object',
        Object.keys(node)
          .sort()
          .map((key) => [key, walk((node as Record<string, unknown>)[key], depth + 1)]),
      ];
    return [typeof node, node];
  };
  return JSON.stringify(walk(value, 0));
}

export async function readBody(
  contentValue: unknown,
  mime: string,
  limits: Limits,
  budget: Budget,
  analyzeShape = true,
): Promise<Body> {
  const content = record(contentValue);
  const limited = (sourceText?: string, bytes?: number): Body => {
    const result: Body = {
      state: 'limited',
      bytes,
      reason: `Body exceeds the ${limits.bodyBytes.toLocaleString('en-US')} byte analysis limit. It was not grouped or compared by body contents.`,
    };
    if (sourceText !== undefined && content.encoding === undefined && isText(mime)) {
      let preview = sourceText.slice(0, PREVIEW_CHARS);
      if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
      const size = encoder.encode(preview).length;
      if (budget.bytes + size <= limits.totalBodyBytes) {
        result.preview = preview;
        budget.bytes += size;
      } else result.previewDeferred = true;
    }
    return result;
  };
  const marker = record(content.text);
  if (marker.__harLimited)
    return limited(typeof marker.preview === 'string' ? marker.preview : undefined);
  if (typeof content.text !== 'string')
    return {
      state: 'missing',
      reason: 'No body captured.',
    };
  if (
    content._displayEncoding !== undefined &&
    !['utf-8-display', 'utf-8'].includes(String(content._displayEncoding))
  )
    return { state: 'invalid', reason: 'The captured body uses an unsupported display encoding.' };
  const text =
    content.encoding === 'base64' ? content.text.replace(/[\t\n\f\r ]/g, '') : content.text;
  if (content.encoding !== undefined && content.encoding !== 'base64')
    return { state: 'invalid', reason: 'The captured body uses an unsupported encoding.' };
  // Bound allocations before atob/UTF-8 conversion. Body bytes are counted separately from HAR size.
  if (
    text.length >
    (content.encoding === 'base64' ? Math.ceil(limits.bodyBytes / 3) * 4 + 4 : limits.bodyBytes)
  ) {
    return limited(text);
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    if (content.encoding === 'base64') {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))
        throw new Error();
      bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    } else {
      if (!wellFormed(text))
        return {
          state: 'invalid',
          reason:
            'The captured body contains invalid Unicode, so it could not be compared reliably.',
        };
      bytes = encoder.encode(text);
    }
  } catch {
    return { state: 'invalid', reason: 'The captured body contains invalid base64 data.' };
  }
  if (bytes.length > limits.bodyBytes) {
    return limited(text, bytes.length);
  }
  const hash = await sha256(bytes);
  // HAR content.text is already decoded; retained Content-Encoding does not trigger decompression.
  const generic =
    analyzeShape && bytes.length <= 64 * 1024 && (mime === '' || /^text\/plain(?:;|$)/i.test(mime));
  if (!isText(mime) && !generic)
    return {
      state: 'binary',
      hash,
      bytes: bytes.length,
      reason: 'The captured body contains binary data or a content type without a text preview.',
    };
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { state: 'binary', hash, bytes: bytes.length, reason: 'Body is not valid UTF-8 text.' };
  }
  const result: Body = { state: 'text', text: decoded, hash, bytes: bytes.length };
  const cacheKey = `${mime}:${hash}`,
    cached = analyzeShape ? budget.shapes?.get(cacheKey) : undefined;
  if (cached) Object.assign(result, cached);
  if (analyzeShape && !cached && (isJson(mime) || (generic && /^[ \t\r\n]*[\[{]/.test(decoded)))) {
    try {
      guardJson(decoded, limits.shapeDepth, limits.shapeNodes * 4);
      const shape = jsonShape(parseLosslessJson(decoded), limits, budget);
      result.shape = await sha256(encoder.encode(shape));
      result.shapeKind = isJson(mime) ? 'JSON canonical values' : 'Detected JSON canonical values';
    } catch {
      result.shapeWarning =
        'JSON could not be parsed or exceeded analysis limits. Responses were compared using body bytes.';
    }
  }
  if (mime === '' && !result.shape)
    return {
      state: 'binary',
      hash,
      bytes: bytes.length,
      reason: 'No declared text type or validated JSON document was captured.',
    };
  if (analyzeShape && !cached && structuredFormat(mime) === 'XML') {
    try {
      const remaining = limits.totalShapeNodes - budget.nodes;
      if (remaining <= 0) throw new Error();
      const parsed = xmlAttributeTemplate(decoded, mime, Math.min(remaining, limits.shapeNodes));
      if (parsed) {
        budget.nodes += parsed.nodes;
        result.shape = await sha256(encoder.encode(parsed.text));
        result.shapeKind = 'XML canonical attributes';
      }
    } catch {
      budget.nodes = Math.min(
        limits.totalShapeNodes,
        budget.nodes + Math.min(STRUCTURE_LIMITS.nodes, limits.shapeNodes),
      );
      result.shapeWarning =
        'XML could not be completely interpreted within its limits. Responses were compared using captured body bytes.';
    }
  }
  if (
    analyzeShape &&
    !cached &&
    !isJson(mime) &&
    /^application\/x-www-form-urlencoded(?:;|$)/i.test(mime)
  ) {
    try {
      const remaining = limits.totalShapeNodes - budget.nodes;
      if (remaining <= 0) throw new Error();
      const parsed = structuredFields(decoded, mime, Math.min(remaining, limits.shapeNodes));
      if (parsed) {
        budget.nodes += parsed.nodes;
        result.shape = await sha256(
          encoder.encode(
            JSON.stringify([
              parsed.shape,
              [...parsed.fields].sort(([a], [b]) => a.localeCompare(b)),
            ]),
          ),
        );
        result.shapeKind = `${parsed.format} canonical values`;
      }
    } catch {
      budget.nodes = Math.min(
        limits.totalShapeNodes,
        budget.nodes + Math.min(STRUCTURE_LIMITS.nodes, limits.shapeNodes),
      );
      result.shapeWarning =
        'Structured response could not be parsed or exceeded analysis limits. Responses were compared using captured body bytes.';
    }
  }
  if (analyzeShape && !cached) {
    budget.shapes ??= new Map();
    if (budget.shapes.size >= 4096) budget.shapes.delete(budget.shapes.keys().next().value!);
    budget.shapes.set(cacheKey, {
      shape: result.shape,
      shapeKind: result.shapeKind,
      shapeWarning: result.shapeWarning,
    });
  }
  if (budget.bytes + bytes.length <= limits.totalBodyBytes) budget.bytes += bytes.length;
  else {
    result.text = undefined;
    result.evicted = true;
  }
  return result;
}
