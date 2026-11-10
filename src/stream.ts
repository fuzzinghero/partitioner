import { throwIfAborted } from './errors.js';
import { fileLimitMessage } from './limits.js';
import { HarError } from './parse.js';
import type { Limits } from './types.js';
import { PREVIEW_CHARS } from './types.js';
import { STRUCTURE_LIMITS } from './structured.js';

type Token = {
  kind: string;
  value?: unknown;
  large?: boolean;
  preview?: string;
  start: number;
  end: number;
};
// Decode a bounded JSON string prefix, trimming only an unfinished escape/UTF-8 sequence.
// This is display-only data. It is never used for hashes, grouping or comparisons.
function stringPreview(raw: Uint8Array): string | undefined {
  const end = Math.min(raw.length, PREVIEW_CHARS * 6 + 1);
  for (let trim = 0; trim <= 12 && end - trim > 1; trim++) {
    try {
      const value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, end - trim)) + '"',
      ) as string;
      const prefix = value.slice(0, PREVIEW_CHARS);
      return /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
    } catch {
      /* Finish before a partial escape or code point. */
    }
  }
  return undefined;
}
/** Incremental JSON tokenizer. Raw token storage is capped. Long strings are validated and drained. */
class Tokenizer {
  limit = 8192;
  entryLimitReached = false;
  private state: '' | 'string' | 'literal' = '';
  private start = 0;
  private offset = 0;
  private raw = new Uint8Array(256);
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private length = 0;
  private large = false;
  private escape = false;
  private unicode = 0;
  private tokenLimit = 0;
  private preview?: string;
  private append(byte: number) {
    if (this.large) return;
    if (this.length >= this.tokenLimit) {
      this.preview =
        this.state === 'string' ? stringPreview(this.raw.subarray(0, this.length)) : undefined;
      this.large = true;
      this.length = 0;
      return;
    }
    if (this.length === this.raw.length) {
      const grown = new Uint8Array(Math.min(this.tokenLimit, this.raw.length * 2));
      grown.set(this.raw);
      this.raw = grown;
    }
    this.raw[this.length++] = byte;
  }
  skipBom() {
    this.offset = 3;
  }
  private finish(end: number): Token {
    const kind = this.state;
    let value: unknown;
    if (!this.large) {
      try {
        value = JSON.parse(this.decoder.decode(this.raw.subarray(0, this.length)));
      } catch {
        throw new HarError('Malformed HAR JSON. No capture content was logged.');
      }
    }
    const result = {
      kind,
      value,
      large: this.large,
      preview: this.preview,
      start: this.start,
      end,
    };
    this.state = '';
    this.length = 0;
    this.large = false;
    this.preview = undefined;
    return result;
  }
  *push(bytes: Uint8Array, final = false): Generator<Token> {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i],
        position = this.offset + i;
      if (this.state === 'string') {
        this.append(b);
        if (this.unicode) {
          if (!((b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102)))
            throw new HarError('Invalid JSON string escape.');
          this.unicode--;
          continue;
        }
        if (this.escape) {
          if (![34, 92, 47, 98, 102, 110, 114, 116, 117].includes(b))
            throw new HarError('Invalid JSON string escape.');
          if (b === 117) this.unicode = 4;
          this.escape = false;
        } else if (b === 92) this.escape = true;
        else if (b === 34) yield this.finish(position + 1);
        else if (b < 32) throw new HarError('Invalid JSON string control character.');
      } else if (this.state) {
        if ([32, 9, 10, 13, 123, 125, 91, 93, 44, 58, 34].includes(b)) {
          yield this.finish(position);
          i--;
        } else {
          this.append(b);
          if (this.large) throw new HarError('Invalid or excessive JSON literal.');
        }
      } else if ([32, 9, 10, 13].includes(b)) {
        /* whitespace */
      } else if (this.entryLimitReached && b !== 93) {
        throw new HarError(
          'Entry limit exceeded. No partial result accepted; split the capture.',
          'LIMIT_EXCEEDED',
        );
      } else if ([123, 125, 91, 93, 44, 58].includes(b))
        yield { kind: String.fromCharCode(b), start: position, end: position + 1 };
      else {
        this.start = position;
        this.tokenLimit = b === 34 ? this.limit : 128;
        this.append(b);
        this.state = b === 34 ? 'string' : 'literal';
      }
    }
    this.offset += bytes.length;
    if (final) {
      if (this.state === 'string') throw new HarError('Unterminated JSON string.');
      if (this.state) yield this.finish(this.offset);
    }
  }
}

type Frame = {
  type: 'object' | 'array';
  state: 'key' | 'key-required' | 'colon' | 'value' | 'value-required' | 'comma';
  path: string;
  key: string;
  index: number;
  value?: Record<string, unknown> | unknown[];
  start: number;
  seen?: Set<string>;
};
const allowed = new Set([
  '',
  '/log',
  '/log/entries',
  '/log/entries/*',
  '/log/entries/*/comment',
  '/log/entries/*/time',
  '/log/entries/*/startedDateTime',
  '/log/entries/*/request',
  '/log/entries/*/request/method',
  '/log/entries/*/request/url',
  '/log/entries/*/request/httpVersion',
  '/log/entries/*/request/bodySize',
  '/log/entries/*/request/headers',
  '/log/entries/*/request/queryString',
  '/log/entries/*/request/cookies',
  '/log/entries/*/request/postData',
  '/log/entries/*/request/postData/params',
  '/log/entries/*/request/postData/text',
  '/log/entries/*/request/postData/mimeType',
  '/log/entries/*/request/postData/encoding',
  '/log/entries/*/request/postData/_displayEncoding',
  '/log/entries/*/response',
  '/log/entries/*/response/status',
  '/log/entries/*/response/headers',
  '/log/entries/*/_error',
  '/log/entries/*/response/_error',
  '/log/entries/*/response/httpVersion',
  '/log/entries/*/response/statusText',
  '/log/entries/*/response/content',
  '/log/entries/*/response/content/text',
  '/log/entries/*/response/content/size',
  '/log/entries/*/response/content/mimeType',
  '/log/entries/*/response/content/encoding',
  '/log/entries/*/response/content/_displayEncoding',
]);
const selectedPath = (path: string) =>
  /\/postData\/params\/\*(?:\/(name|value|fileName|contentType))?$/.test(path) ||
  allowed.has(path) ||
  /\/(headers|queryString|cookies)\/\*(?:\/(name|value))?$/.test(path);
// Unselected subtrees have a constant sentinel. Never concatenate attacker-controlled paths.
const childPath = (frame?: Frame): string => {
  if (!frame) return '';
  if (frame.path === '#' || (frame.type === 'object' && /[~/*]/.test(frame.key))) return '#';
  const path = `${frame.path}/${frame.type === 'array' ? '*' : frame.key}`;
  return selectedPath(path) ? path : '#';
};
// Display previews have their own bounded allowance even when body analysis is disabled.
const fieldLimit = (path: string, limits: Limits) =>
  path.endsWith('/text')
    ? Math.max(PREVIEW_CHARS * 6 + 2, (Math.ceil(limits.bodyBytes / 3) * 4 + 4) * 6 + 2)
    : (/\/request\/cookies\/\*\/(?:name|value)$/.test(path)
        ? Math.min(limits.fieldChars, STRUCTURE_LIMITS.valueChars)
        : limits.fieldChars) *
        6 +
      2;
const arrayLimit = (path: string, limits: Limits) =>
  path === '/log/entries/*/request/cookies'
    ? Math.min(limits.headers, STRUCTURE_LIMITS.fields)
    : limits.headers;

export interface SourceEntry {
  raw: unknown;
  id: number;
  start: number;
  end: number;
}
/** Parses the whole grammar, but retains only selected fields of one entry at a time. */
export async function* streamEntries(
  file: Blob,
  limits: Limits,
  byteProgress: (bytes: number) => void = () => {},
  signal?: AbortSignal,
): AsyncGenerator<SourceEntry> {
  throwIfAborted(signal);
  if (limits.fileBytes !== null && file.size > limits.fileBytes)
    throw new HarError(fileLimitMessage(limits.fileBytes), 'LIMIT_EXCEEDED');
  const scanner = new Tokenizer(),
    stack: Frame[] = [],
    utf8 = new TextDecoder('utf-8', { fatal: true });
  let rootDone = false,
    foundEntries = false,
    count = 0,
    tokens = 0;
  const attach = (parent: Frame | undefined, value: unknown) => {
    if (!parent) {
      rootDone = true;
      return;
    }
    if (parent.value && parent.path !== '/log/entries') {
      if (parent.type === 'array') {
        if (parent.index < arrayLimit(parent.path, limits)) (parent.value as unknown[]).push(value);
        else if (parent.index === arrayLimit(parent.path, limits))
          (parent.value as unknown[]).push({ overflow: true });
      } else if (selectedPath(childPath(parent)))
        Object.defineProperty(parent.value, parent.key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
    }
    parent.state = 'comma';
    parent.index++;
  };
  const consume = (token: Token): SourceEntry | undefined => {
    if (++tokens > limits.jsonTokens)
      throw new HarError('Capture structure work limit exceeded.', 'LIMIT_EXCEEDED');
    const frame = stack.at(-1);
    if (frame?.state === 'key' || frame?.state === 'key-required') {
      if (token.kind === '}' && frame.state === 'key') {
        /* close empty object below */
      } else {
        if (
          token.kind !== 'string' ||
          token.large ||
          (token.value as string).length > limits.fieldChars
        )
          throw new HarError('Invalid or excessive JSON object key.');
        frame.key = token.value as string;
        if (childPath(frame) !== '#') {
          frame.seen ??= new Set();
          if (frame.seen.has(frame.key)) throw new HarError('Duplicate captured JSON field.');
          frame.seen.add(frame.key);
        }
        frame.state = 'colon';
        return;
      }
    }
    if (frame?.state === 'colon') {
      if (token.kind !== ':') throw new HarError('Malformed HAR JSON.');
      frame.state = 'value';
      return;
    }
    if (frame?.state === 'comma') {
      if (token.kind === ',') {
        frame.state = frame.type === 'object' ? 'key-required' : 'value-required';
        return;
      }
      if (token.kind !== (frame.type === 'object' ? '}' : ']'))
        throw new HarError('Malformed HAR JSON.');
    }
    if (token.kind === '}' || token.kind === ']') {
      if (
        !frame ||
        token.kind !== (frame.type === 'object' ? '}' : ']') ||
        !['key', 'value', 'comma'].includes(frame.state) ||
        (frame.type === 'object' && frame.state === 'value')
      )
        throw new HarError('Malformed HAR JSON.');
      stack.pop();
      const source =
        frame.path === '/log/entries/*'
          ? { raw: frame.value, id: count++, start: frame.start, end: token.end }
          : undefined;
      if (count > limits.entries)
        throw new HarError(
          'Entry limit exceeded. No partial result accepted. Split the capture.',
          'LIMIT_EXCEEDED',
        );
      attach(stack.at(-1), frame.value);
      return source;
    }
    if (frame && !['value', 'value-required'].includes(frame.state))
      throw new HarError('Malformed HAR JSON.');
    if (!frame && rootDone) throw new HarError('Extra JSON after HAR object.');
    const path = childPath(frame);
    if (token.kind === '{' || token.kind === '[') {
      if (!frame && token.kind !== '{') throw new HarError('Expected a HAR object.');
      if (path === '/log' && token.kind !== '{') throw new HarError('Expected a log object.');
      if (path === '/log/entries') {
        if (token.kind !== '[' || foundEntries)
          throw new HarError('Expected one log.entries array.');
        foundEntries = true;
      }
      if (stack.length >= limits.jsonDepth)
        throw new HarError('JSON nesting limit exceeded.', 'LIMIT_EXCEEDED');
      const keep =
        selectedPath(path) &&
        !(
          frame?.type === 'array' &&
          frame.path !== '/log/entries' &&
          frame.index >= arrayLimit(frame.path, limits)
        );
      stack.push({
        type: token.kind === '{' ? 'object' : 'array',
        state: token.kind === '{' ? 'key' : 'value',
        key: '',
        index: 0,
        path,
        value: keep ? (token.kind === '{' ? {} : []) : undefined,
        start: token.start,
      });
    } else {
      if (token.kind !== 'string' && token.kind !== 'literal')
        throw new HarError('Malformed HAR JSON.');
      if (path === '/log') throw new HarError('Expected a log object.');
      if (path === '/log/entries') throw new HarError('Expected a log.entries array.');
      if (path === '/log/entries/*') {
        const source = { raw: token.value, id: count++, start: token.start, end: token.end };
        if (count > limits.entries) throw new HarError('Entry limit exceeded.', 'LIMIT_EXCEEDED');
        attach(frame, undefined);
        return source;
      }
      const value = token.large ? { __harLimited: true, preview: token.preview } : token.value;
      attach(frame, selectedPath(path) ? value : undefined);
    }
  };
  const chunkBytes = 256 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    throwIfAborted(signal);
    let bytes = new Uint8Array(
      await file.slice(offset, Math.min(file.size, offset + chunkBytes)).arrayBuffer(),
    );
    try {
      utf8.decode(bytes, { stream: true });
    } catch {
      throw new HarError('HAR must be UTF-8 JSON.');
    }
    const readBytes = bytes.length;
    if (offset === 0 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) {
      bytes = bytes.subarray(3);
      scanner.skipBom();
    }
    for (const token of scanner.push(bytes)) {
      const source = consume(token);
      const next = stack.at(-1);
      const nextPath = childPath(next);
      // Reject before scanning a new value, including a large scalar entry token.
      scanner.entryLimitReached =
        next?.path === '/log/entries' &&
        (next.state === 'value' || next.state === 'value-required') &&
        count >= limits.entries;
      scanner.limit =
        next?.state === 'value' ? fieldLimit(nextPath, limits) : limits.fieldChars * 6 + 2;
      if (source) yield source;
    }
    byteProgress(Math.min(file.size, offset + readBytes));
    throwIfAborted(signal);
  }
  try {
    utf8.decode();
  } catch {
    throw new HarError('HAR must be UTF-8 JSON.');
  }
  for (const token of scanner.push(new Uint8Array(), true)) {
    const source = consume(token);
    if (source) yield source;
  }
  if (stack.length || !rootDone || !foundEntries)
    throw new HarError('Incomplete HAR or missing log.entries array.');
}
