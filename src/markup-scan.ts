import {
  htmlCommentEnd,
  htmlRawTextEnd,
  isConventionalHtmlTag,
  isHtmlDoctype,
} from './html-template.js';

/** A lexical exclusion mask, not a DOM: programs, attributes and comments stay literal.
 * Scan raw containers independently so nested tokenizer contexts cannot expose code. */
function excludedText(text: string): Uint8Array | undefined {
  // CDATA can hide an apparent raw-container ending in tokenizer contexts
  // that this lexical mask does not interpret.
  if (text.includes('<![CDATA[')) return;
  const excluded = new Uint8Array(text.length);
  const containers =
    /<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext|select|template)(?=[\t\n\f\r />])/gi;
  let work = 0;
  for (const opening of text.matchAll(containers)) {
    if ((work += text.length - opening.index) > 256 * 1024) return;
    const start = opening.index;
    const end = tagEnd(text, start);
    if (end === undefined || !isConventionalHtmlTag(text.slice(start, end))) return;
    const name = opening[1].toLowerCase();
    if (name === 'plaintext') {
      excluded.fill(1, start);
      continue;
    }
    const close = htmlRawTextEnd(text, end, name);
    if (!close) return;
    if (name === 'script' && text.slice(end, close.index).includes('<!--')) return;
    excluded.fill(1, start, close.index + close[0].length);
  }
  for (let at = 0; at < text.length; at++) {
    if (excluded[at] || text[at] !== '<') continue;
    if (text.startsWith('<!--', at)) {
      const end = htmlCommentEnd(text, at);
      if (end === undefined) return;
      excluded.fill(1, at, end);
      at = end - 1;
      continue;
    }
    const end = tagEnd(text, at);
    if (end === undefined) return;
    const tag = text.slice(at, end);
    if (!isConventionalHtmlTag(tag) && !isHtmlDoctype(tag)) return;
    excluded.fill(1, at, end);
    at = end - 1;
  }
  return excluded;
}

function tagEnd(text: string, start: number): number | undefined {
  let quote = '';
  for (let end = start + 1; end < text.length; end++) {
    const char = text[end];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return end + 1;
  }
}

/** Contiguous lexical data regions. Excluded markup/program bytes remain literal. */
export function lexicalDataSpans(text: string): { start: number; end: number }[] | undefined {
  const excluded = excludedText(text);
  if (!excluded) return;
  const spans: { start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && !excluded[i]) continue;
    if (i > start) spans.push({ start, end: i });
    start = i + 1;
    if (spans.length > 400) return;
  }
  return spans;
}
