import { decodePercent } from './percent.js';
import {
  htmlCommentEnd,
  htmlRawTextEnd,
  isHtmlDoctype,
  isSupportedHtmlTag,
} from './html-template.js';
export type ReflectionCandidate = { value: string; field: string; raw?: string };
type Variant = ReflectionCandidate & { encoding: string };

/** Generate a small closed set of representations, never recursively decode a response. */
export function reflectionVariants(
  candidate: ReflectionCandidate,
  options: { maxChars: number } = { maxChars: 4096 },
): Variant[] {
  const variants = new Map<string, Variant>();
  const add = (value: string, encoding: string) => {
    if (value && value.length <= options.maxChars && !variants.has(value))
      variants.set(value, { ...candidate, value, encoding });
  };
  const value = candidate.value;
  add(value, 'literal');
  if (candidate.raw !== undefined) add(candidate.raw, 'url');
  try {
    const encoded = encodeURIComponent(value);
    add(encoded, 'url');
    add(
      encoded.replace(/%[A-F\d]{2}/g, (s) => s.toLowerCase()),
      'url',
    );
    add(encoded.replace(/%20/g, '+'), 'form');
    add(encodeURIComponent(encoded), 'url-twice');
    if (/%[a-f\d]{2}/i.test(value)) {
      const decoded = decodePercent(value);
      add(decoded, 'url-decoded');
    }
  } catch {
    /* Malformed escapes and non-scalar Unicode remain literal. */
  }
  const html = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  add(html, 'entities');
  add(html.replace(/"/g, '&quot;').replace(/'/g, '&#39;'), 'entities');
  add(html.replace(/"/g, '&quot;').replace(/'/g, '&apos;'), 'entities');
  add(
    value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
    'entities',
  );
  add(
    value.replace(/[&<>"']/g, (c) => `&#x${c.charCodeAt(0).toString(16)};`),
    'entities',
  );
  add(JSON.stringify(value).slice(1, -1), 'json-escaped');
  return [...variants.values()];
}

type Span = { start: number; end: number };

/** Literal markup is kept outside value spans; active HTML contexts are never generalized. */
export function markupSpans(text: string, xml: boolean, comments = false): Span[] | undefined {
  const spans: Span[] = [];
  let position = 0;
  while (position < text.length) {
    if (spans.length > 400) return;
    if (text[position] !== '<') {
      const end = text.indexOf('<', position);
      spans.push({ start: position, end: end < 0 ? text.length : end });
      position = spans.at(-1)!.end;
      continue;
    }
    if (!xml && text.startsWith('<!--', position)) {
      const end = htmlCommentEnd(text, position);
      if (end === undefined) return;
      if (comments) spans.push({ start: position + 4, end: end - 3 });
      position = end;
      continue;
    }
    if (text.startsWith('<!--', position) || (xml && text.startsWith('<![CDATA[', position))) {
      const cdata = text.startsWith('<![CDATA[', position);
      const end = text.indexOf(cdata ? ']]>' : '-->', position + (cdata ? 9 : 4));
      if (end < 0) return;
      if (cdata) spans.push({ start: position + 9, end });
      position = end + 3;
      continue;
    }
    const start = position;
    let quote = '';
    for (position++; position < text.length; position++) {
      const c = text[position];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (position >= text.length || quote) return;
    const tag = text.slice(start, ++position);
    if (!xml && !isSupportedHtmlTag(tag) && !isHtmlDoctype(tag)) return;
    if (/^<!doctype\b/i.test(tag)) {
      if (xml || !isHtmlDoctype(tag)) return;
      continue;
    }
    if (/^<\//.test(tag) || (xml && /^<\?xml\b/.test(tag))) continue;
    const opening = /^<([a-z_][\w.-]*)\b/i.exec(tag);
    if (!opening) return;
    const raw =
      !xml &&
      /^(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)$/i.test(
        opening[1],
      );
    // Only quoted XML values and inert HTML attributes are eligible. Names/syntax remain literal.
    const attributes = tag.slice(opening[0].length, -1);
    const pattern = /\s+([\w.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/y;
    let at = 0;
    while (at < attributes.length) {
      if (/^\s*\/?\s*$/.test(attributes.slice(at))) break;
      pattern.lastIndex = at;
      const match = pattern.exec(attributes);
      if (!match) return;
      at = pattern.lastIndex;
      const value = match[2] ?? match[3];
      if (
        value === undefined ||
        raw ||
        (!xml &&
          (!/^(value|title|alt|placeholder|data-[\w-]+)$/i.test(match[1]) ||
            (match[1].toLowerCase() === 'value' && !/^(input|button|option)$/i.test(opening[1]))))
      )
        continue;
      const offset = start + opening[0].length + at - value.length - 1;
      spans.push({ start: offset, end: offset + value.length });
    }
    const closing = /^<\/([a-z_][\w.-]*)[\t\n\f\r ]*>/i.exec(text.slice(position));
    const voidElement =
      !xml &&
      /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(opening[1]);
    if (
      !raw &&
      !voidElement &&
      !/\/>$/.test(tag) &&
      closing &&
      (xml ? closing[1] === opening[1] : closing[1].toLowerCase() === opening[1].toLowerCase())
    )
      spans.push({ start: position, end: position });
    if (raw) {
      if (opening[1].toLowerCase() === 'plaintext') {
        position = text.length;
        continue;
      }
      const match = htmlRawTextEnd(text, position, opening[1]);
      if (!match) return;
      // Escaped script states can keep apparent end tags executable. Fail closed
      // rather than approximate the HTML script tokenizer with an end-tag regex.
      if (
        opening[1].toLowerCase() === 'script' &&
        text.slice(position, match.index).includes('<!--')
      )
        return;
      position = match.index + match[0].length;
    }
  }
  return spans.length <= 400 ? spans : undefined;
}

export function multipartSpans(text: string, mime: string): Span[] | undefined {
  const boundary = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(mime);
  if (!boundary) return;
  const delimiter = '--' + (boundary[1] ?? boundary[2]).replace(/\\([\x20-\x7e])/g, '$1');
  const spans: Span[] = [];
  let position = delimiter.length + 2;
  while (position < text.length) {
    const headersEnd = text.indexOf('\r\n\r\n', position);
    if (headersEnd < 0) return;
    const end = text.indexOf('\r\n' + delimiter, headersEnd + 4);
    if (end < 0) return;
    const headers = text.slice(position, headersEnd);
    const partType = /^content-type:[ \t]*([^\r\n]*)/im.exec(headers)?.[1];
    if (
      !/;\s*filename\s*=/i.test(headers) &&
      (partType === undefined || /^text\/plain(?:[ \t;]|$)/i.test(partType))
    )
      spans.push({ start: headersEnd + 4, end });
    position = end + 2 + delimiter.length;
    if (text.slice(position, position + 2) === '--') break;
    position += 2;
  }
  return spans;
}
