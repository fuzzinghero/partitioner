const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
/** WHATWG-style byte percent decoding; malformed UTF-8 is evidence, not a parse error. */
export function decodePercent(value: string, form = false): string {
  const text = form ? value.replace(/\+/g, ' ') : value;
  if (!/%[\da-f]{2}/i.test(text) && !/[\uD800-\uDFFF]/.test(text)) return text;
  const encoded = encoder.encode(text);
  const bytes = new Uint8Array(encoded.length);
  let length = 0;
  const hex = (c: number) =>
    c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
  for (let i = 0; i < encoded.length; i++) {
    const high = hex(encoded[i + 1]),
      low = hex(encoded[i + 2]);
    if (encoded[i] === 37 && high >= 0 && low >= 0) {
      bytes[length++] = high * 16 + low;
      i += 2;
    } else bytes[length++] = encoded[i];
  }
  return decoder.decode(bytes.subarray(0, length));
}

/** Preserve captured value spelling alongside decoded names and ordered occurrences. */
export function* formPairs(text: string) {
  for (const pair of text ? text.split('&') : []) {
    const at = pair.indexOf('=');
    const raw = at < 0 ? '' : pair.slice(at + 1);
    yield {
      name: decodePercent(at < 0 ? pair : pair.slice(0, at), true),
      value: decodePercent(raw, true),
      raw,
    };
  }
}
