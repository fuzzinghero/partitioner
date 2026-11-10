/** Conservative value extraction. XML/multipart response layout remains significant. */
type Put = (path: string, value: string) => void;
const pointer = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');

export function xmlFields(text: string, put: Put, step: () => void, maxDepth: number) {
  // XML 1.0 normalizes literal newlines before resolving character references.
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (const char of text) {
    const point = char.codePointAt(0)!;
    if (
      (point < 32 && ![9, 10, 13].includes(point)) ||
      (point >= 0xd800 && point <= 0xdfff) ||
      point === 0xfffe ||
      point === 0xffff
    )
      throw new Error('Invalid XML character');
  }
  const entities = (value: string) =>
    value.replace(/&([^&;]*);|&/g, (_, name?: string) => {
      const predefined: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        apos: "'",
        quot: '"',
      };
      if (name !== undefined && Object.hasOwn(predefined, name)) return predefined[name];
      const point =
        name !== undefined && /^#x[0-9a-fA-F]+$/.test(name)
          ? parseInt(name.slice(2), 16)
          : name !== undefined && /^#[0-9]+$/.test(name)
            ? Number(name.slice(1))
            : NaN;
      if (
        !Number.isInteger(point) ||
        point <= 0 ||
        point > 0x10ffff ||
        (point < 32 && ![9, 10, 13].includes(point)) ||
        (point >= 0xd800 && point <= 0xdfff) ||
        point === 0xfffe ||
        point === 0xffff
      )
        throw new Error('Unsupported XML entity');
      return String.fromCodePoint(point);
    });
  type Frame = { name: string; path: string; children: Map<string, number>; texts: number };
  const stack: Frame[] = [];
  let offset = 0,
    roots = 0;
  // Only the UTF-8 XML 1.0 declaration is supported; no other processing instructions or DTDs.
  if (text.startsWith('<?xml')) {
    const declaration =
      /^<\?xml[ \t\n]+version=(?:"1\.0"|'1\.0')(?:[ \t\n]+encoding=(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:[ \t\n]+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\n]*\?>/.exec(
        text,
      );
    if (!declaration) throw new Error('Unsupported XML declaration');
    offset = declaration[0].length;
  }
  const addText = (value: string, cdata = false) => {
    const parent = stack.at(-1);
    if (!parent) {
      if (!/^[ \t\n]*$/.test(value)) throw new Error('XML text outside root');
    } else if (value) {
      if (!cdata && value.includes(']]>')) throw new Error('Invalid XML text');
      put(`${parent.path}/#text/${parent.texts++}`, cdata ? value : entities(value));
    }
  };
  while (offset < text.length) {
    step();
    if (text[offset] !== '<') {
      const next = text.indexOf('<', offset),
        end = next < 0 ? text.length : next;
      addText(text.slice(offset, end));
      offset = end;
      continue;
    }
    if (text.startsWith('<!--', offset)) {
      const end = text.indexOf('-->', offset + 4);
      if (end < 0 || /--|-$/.test(text.slice(offset + 4, end)))
        throw new Error('Invalid XML comment');
      offset = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', offset)) {
      const end = text.indexOf(']]>', offset + 9);
      if (end < 0 || !stack.length) throw new Error('Invalid CDATA');
      addText(text.slice(offset + 9, end), true);
      offset = end + 3;
      continue;
    }
    const closing = /^<\/([A-Za-z_][\w.-]*)[ \t\n]*>/.exec(text.slice(offset));
    if (closing) {
      if (stack.pop()?.name !== closing[1]) throw new Error('Mismatched XML element');
      offset += closing[0].length;
      continue;
    }
    // Namespace names and declarations deliberately fall back rather than guessing bindings.
    const opening =
      /^<([A-Za-z_][\w.-]*)((?:[ \t\n]+[A-Za-z_][\w.-]*[ \t\n]*=[ \t\n]*(?:"[^"<]*"|'[^'<]*'))*)[ \t\n]*(\/?)>/.exec(
        text.slice(offset),
      );
    if (!opening) throw new Error('Unsupported XML syntax');
    if (stack.length >= maxDepth) throw new Error('XML depth limit');
    const parent = stack.at(-1),
      name = opening[1],
      occurrence = parent?.children.get(name) ?? 0;
    if (!parent && ++roots > 1) throw new Error('Multiple XML roots');
    parent?.children.set(name, occurrence + 1);
    const path = `${parent?.path ?? ''}/${pointer(name)}/${occurrence}`;
    const attributes = new Set<string>();
    for (const attribute of opening[2].matchAll(
      /([A-Za-z_][\w.-]*)[ \t\n]*=[ \t\n]*(?:"([^"<]*)"|'([^'<]*)')/g,
    )) {
      if (attribute[1] === 'xmlns' || attributes.has(attribute[1]))
        throw new Error('Unsupported XML attribute');
      attributes.add(attribute[1]);
      // Literal attribute whitespace becomes spaces; numeric references keep their values.
      put(
        `${path}/@${pointer(attribute[1])}`,
        entities((attribute[2] ?? attribute[3]).replace(/[\t\n]/g, ' ')),
      );
    }
    if (!opening[3]) stack.push({ name, path, children: new Map(), texts: 0 });
    offset += opening[0].length;
  }
  if (stack.length || roots !== 1) throw new Error('Incomplete XML');
}

/** A strict parameter subset shared by MIME and disposition; duplicate keys are ambiguous. */
function parameters(value: string, prefix: RegExp) {
  const head = prefix.exec(value);
  if (!head) throw new Error('Unsupported multipart media or disposition');
  let rest = value.slice(head[0].length);
  const result = new Map<string, string>();
  while (rest.trim()) {
    const parameter =
      /^[ \t]*;[ \t]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]*=[ \t]*(?:"((?:[^"\\\r\n\u0000-\u001f\u007f]|\\[\x20-\x7e])*)"|([!#$%&'*+.^_`|~0-9A-Za-z-]+))[ \t]*/.exec(
        rest,
      );
    if (!parameter || result.has(parameter[1].toLowerCase()))
      throw new Error('Ambiguous multipart parameter');
    const decoded = (parameter[2] ?? parameter[3]).replace(/\\([\x20-\x7e])/g, '$1');
    result.set(parameter[1].toLowerCase(), decoded);
    rest = rest.slice(parameter[0].length);
  }
  return result;
}

export function multipartFields(text: string, mime: string, put: Put, step: () => void) {
  const media = parameters(mime, /^multipart\/form-data(?=[ \t;]|$)/i),
    token = media.get('boundary');
  if (
    !token ||
    !/^[0-9A-Za-z'()+_,.\/:=?-]{1,70}$/.test(token) ||
    [...media.keys()].some((key) => key !== 'boundary')
  )
    throw new Error('Unsupported multipart boundary');
  const delimiter = `--${token}`,
    chunks = text.split(`\r\n${delimiter}`);
  if (!chunks[0].startsWith(`${delimiter}\r\n`) || !/^--(?:\r\n)?$/.test(chunks.at(-1) ?? ''))
    throw new Error('Unsupported multipart framing');
  chunks[0] = chunks[0].slice(delimiter.length);
  const counts = new Map<string, number>();
  for (const chunk of chunks.slice(0, -1)) {
    step();
    if (!chunk.startsWith('\r\n')) throw new Error('Invalid multipart delimiter');
    const end = chunk.indexOf('\r\n\r\n');
    if (end < 0) throw new Error('Multipart headers unavailable');
    const lines = chunk.slice(2, end).split('\r\n'),
      headers = new Map<string, string>();
    if (lines.length > 50) throw new Error('Multipart header limit');
    for (const line of lines) {
      step();
      const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\u0000-\u001f\u007f]*)$/.exec(line);
      if (!match || headers.has(match[1].toLowerCase()))
        throw new Error('Unsupported multipart header');
      const value = match[2].trim();
      headers.set(match[1].toLowerCase(), value);
    }
    const disposition = parameters(
        headers.get('content-disposition') ?? '',
        /^form-data(?=[ \t;]|$)/i,
      ),
      name = disposition.get('name');
    if (
      name === undefined ||
      [...disposition.keys()].some((key) => key !== 'name' && key !== 'filename')
    )
      throw new Error('Unsupported multipart disposition');
    const type = headers.get('content-type');
    if (type !== undefined) {
      parameters(type, /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?=[ \t;]|$)/);
      if (/^multipart\//i.test(type)) throw new Error('Nested multipart is unsupported');
    }
    if (headers.has('content-transfer-encoding') || headers.has('content-encoding'))
      throw new Error('Multipart encoding is unsupported');
    const occurrence = counts.get(name) ?? 0,
      path = `/${pointer(name)}/${occurrence}`;
    counts.set(name, occurrence + 1);
    if (disposition.has('filename')) put(`${path}/@filename`, disposition.get('filename')!);
    if (type !== undefined) put(`${path}/@content-type`, type);
    put(`${path}/value`, chunk.slice(end + 4));
  }
}
