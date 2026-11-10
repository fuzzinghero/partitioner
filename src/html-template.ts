/** Validate the small HTML tag subset shared by both non-DOM inference paths. */
export function isSupportedHtmlTag(tag: string): boolean {
  // Foreign integration points and select descendants require tree-builder
  // namespace/insertion-mode state to classify raw text and executable children.
  if (/^<\/?(?:svg|math|select)(?=[\t\n\f\r />])/i.test(tag)) return false;
  return isConventionalHtmlTag(tag);
}

/** Validate tag syntax without interpreting element behavior or namespaces. */
export function isConventionalHtmlTag(tag: string): boolean {
  if (tag.startsWith('</')) return /^<\/[a-z][\w.-]*[\t\n\f\r ]*>$/i.test(tag);
  const opening = /^<[a-z][\w.-]*(?=[\t\n\f\r />])/i.exec(tag);
  if (!opening) return false;
  const attribute =
    /[\t\n\f\r ]+[\w.-]+(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"[^"]*"|'[^']*'|[^\t\n\f\r "'`=<>]+))?/y;
  let position = opening[0].length;
  while (position < tag.length) {
    attribute.lastIndex = position;
    const match = attribute.exec(tag);
    if (!match) return /^[\t\n\f\r ]*\/?>$/.test(tag.slice(position));
    position = attribute.lastIndex;
  }
  return false;
}

/** Only the minimal HTML declaration is interpreted without a DOCTYPE tokenizer. */
export function isHtmlDoctype(tag: string): boolean {
  return /^<!doctype[\t\n\f\r ]+html[\t\n\f\r ]*>$/i.test(tag);
}

/** Only conventional comments are interpreted; other HTML tokenizer states stay literal. */
export function htmlCommentEnd(text: string, start: number): number | undefined {
  const end = text.indexOf('-->', start + 4);
  if (end < 0 || /[<>]|--/.test(text.slice(start + 4, end))) return;
  return end + 3;
}

/** A known raw-text name closes at the first HTML-delimited end tag.
 * Unsupported attributes/solidus syntax must not make us search past that tag. */
export function htmlRawTextEnd(
  text: string,
  start: number,
  name: string,
): RegExpExecArray | undefined {
  const boundary = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'ig');
  boundary.lastIndex = start;
  const first = boundary.exec(text);
  if (!first) return;
  const supported = new RegExp(`</${name}[\\t\\n\\f\\r ]*>`, 'iy');
  supported.lastIndex = first.index;
  return supported.exec(text) ?? undefined;
}
