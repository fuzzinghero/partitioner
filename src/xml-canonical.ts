import { structuredFields } from './structured.js';

/** Supported XML only: normalize attribute syntax/order, preserving every value and other byte. */
export function xmlAttributeTemplate(text: string, mime: string, nodeLimit: number) {
  const parsed = structuredFields(text, mime, nodeLimit);
  if (!parsed) return;
  const tokens: unknown[] = [];
  let from = 0,
    at = 0;
  while ((at = text.indexOf('<', at)) >= 0) {
    if (
      text.startsWith('<!--', at) ||
      text.startsWith('<![CDATA[', at) ||
      text.startsWith('<?', at)
    ) {
      const end = text.startsWith('<!--', at)
        ? '-->'
        : text.startsWith('<![CDATA[', at)
          ? ']]>'
          : '?>';
      at = text.indexOf(end, at) + end.length;
      continue;
    }
    let end = at + 1,
      quote = '';
    for (; end < text.length; end++) {
      const c = text[end];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    const tag = text.slice(at, end + 1);
    const name = /^<([A-Za-z_][\w.-]*)/.exec(tag)?.[1];
    if (name) {
      const attrs = [
        ...tag.matchAll(/[ \t\r\n]+([A-Za-z_][\w.-]*)[ \t\r\n]*=[ \t\r\n]*("[^"<]*"|'[^'<]*')/g),
      ]
        .map((match) => [match[1], match[2]])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      tokens.push(['literal', text.slice(from, at)], ['element', name, attrs, /\/>$/.test(tag)]);
      from = end + 1;
    }
    at = end + 1;
  }
  tokens.push(['literal', text.slice(from)]);
  return { text: JSON.stringify(tokens), nodes: parsed.nodes };
}
