import { isJson } from './body.js';
import { guardJson } from './parse.js';
import { formatJson, isNumberToken, numberSource, parseLosslessJson } from './lossless-json.js';
import { DIFF_LIMITS } from './types.js';
import type { Change, Comparison, Entry, Header } from './types.js';

const clipExcerpt = (text: string | undefined) => {
  if (text === undefined) return '(unavailable)';
  if (text.length > 1024) return `${text.slice(0, 1024)} … [excerpt]`;
  return text;
};
const excerpt = (value: unknown) =>
  clipExcerpt(typeof value === 'string' ? value : formatJson(value));
const jsonExcerpt = (value: unknown) => clipExcerpt(formatJson(value));
const pointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

/** Position-preserving comparison: duplicate header names and order remain observable. */
export function diffHeaders(referenceHeaders: Header[], comparisonHeaders: Header[]): Change[] {
  const changes: Change[] = [];
  for (let i = 0; i < Math.max(referenceHeaders.length, comparisonHeaders.length); i++) {
    if (JSON.stringify(referenceHeaders[i]) === JSON.stringify(comparisonHeaders[i])) continue;
    changes.push({
      path: `/headers/${i}`,
      kind: !referenceHeaders[i] ? 'added' : !comparisonHeaders[i] ? 'removed' : 'changed',
      reference: referenceHeaders[i]
        ? excerpt(`${referenceHeaders[i].name}: ${referenceHeaders[i].value}`)
        : undefined,
      comparison: comparisonHeaders[i]
        ? excerpt(`${comparisonHeaders[i].name}: ${comparisonHeaders[i].value}`)
        : undefined,
    });
  }
  return changes;
}

export function diffJson(
  reference: unknown,
  comparison: unknown,
): { changes: Change[]; limited: boolean } {
  const changes: Change[] = [];
  let nodes = 0;
  let limited = false;
  const add = (
    path: string,
    kind: Change['kind'],
    referenceValue?: unknown,
    comparisonValue?: unknown,
  ) => {
    if (changes.length >= DIFF_LIMITS.changes) {
      limited = true;
      return;
    }
    changes.push({
      path: path || '/',
      kind,
      reference: referenceValue === undefined ? undefined : jsonExcerpt(referenceValue),
      comparison: comparisonValue === undefined ? undefined : jsonExcerpt(comparisonValue),
    });
  };
  const walk = (referenceValue: unknown, comparisonValue: unknown, path: string, depth: number) => {
    if (
      ++nodes > DIFF_LIMITS.nodes ||
      depth > DIFF_LIMITS.depth ||
      changes.length >= DIFF_LIMITS.changes
    ) {
      limited = true;
      return;
    }
    if (Object.is(referenceValue, comparisonValue)) return;
    if (isNumberToken(referenceValue) || isNumberToken(comparisonValue)) {
      if (
        !isNumberToken(referenceValue) ||
        !isNumberToken(comparisonValue) ||
        numberSource(referenceValue) !== numberSource(comparisonValue)
      )
        add(path, 'changed', referenceValue, comparisonValue);
      return;
    }
    const referenceIsObject = referenceValue !== null && typeof referenceValue === 'object';
    const comparisonIsObject = comparisonValue !== null && typeof comparisonValue === 'object';
    if (
      !referenceIsObject ||
      !comparisonIsObject ||
      Array.isArray(referenceValue) !== Array.isArray(comparisonValue)
    ) {
      add(path, 'changed', referenceValue, comparisonValue);
      return;
    }
    const referenceObject = referenceValue as Record<string, unknown>;
    const comparisonObject = comparisonValue as Record<string, unknown>;
    const keys = new Set([...Object.keys(referenceObject), ...Object.keys(comparisonObject)]);
    for (const key of keys) {
      if (limited) break;
      const next = `${path}/${pointer(key)}`;
      if (!Object.hasOwn(referenceObject, key))
        add(next, 'added', undefined, comparisonObject[key]);
      else if (!Object.hasOwn(comparisonObject, key)) add(next, 'removed', referenceObject[key]);
      else walk(referenceObject[key], comparisonObject[key], next, depth + 1);
    }
  };
  walk(reference, comparison, '', 0);
  return { changes, limited };
}

/** Bounded line LCS, only for an explicit pair. No all-pairs similarity. */
export function diffText(
  referenceText: string,
  comparisonText: string,
): { changes: Change[]; limited: boolean } {
  const referenceLines = referenceText.split('\n');
  const comparisonLines = comparisonText.split('\n');
  if (
    referenceLines.length > DIFF_LIMITS.lines ||
    comparisonLines.length > DIFF_LIMITS.lines ||
    (referenceLines.length + 1) * (comparisonLines.length + 1) > DIFF_LIMITS.cells
  ) {
    return { changes: [], limited: true };
  }
  const width = comparisonLines.length + 1;
  const matrix = new Uint16Array((referenceLines.length + 1) * width);
  for (let i = referenceLines.length - 1; i >= 0; i--) {
    for (let j = comparisonLines.length - 1; j >= 0; j--)
      matrix[i * width + j] =
        referenceLines[i] === comparisonLines[j]
          ? matrix[(i + 1) * width + j + 1] + 1
          : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
  }
  let i = 0;
  let j = 0;
  const changes: Change[] = [];
  while (i < referenceLines.length || j < comparisonLines.length) {
    if (changes.length >= DIFF_LIMITS.changes) return { changes, limited: true };
    if (
      i < referenceLines.length &&
      j < comparisonLines.length &&
      referenceLines[i] === comparisonLines[j]
    ) {
      i++;
      j++;
    } else if (
      i < referenceLines.length &&
      (j === comparisonLines.length || matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])
    ) {
      changes.push({
        path: `reference line ${i + 1}`,
        kind: 'removed',
        reference: excerpt(referenceLines[i++]),
      });
    } else
      changes.push({
        path: `comparison line ${j + 1}`,
        kind: 'added',
        comparison: excerpt(comparisonLines[j++]),
      });
  }
  return { changes, limited: false };
}

function bodyDiff(referenceEntry: Entry, comparisonEntry: Entry): Comparison['body'] {
  if (!referenceEntry.body.hash || !comparisonEntry.body.hash)
    return {
      kind: 'unavailable',
      message:
        'The complete response bodies could not be compared. A body was not captured, could not be decoded, or exceeded the analysis limit.',
      changes: [],
      limited: false,
    };
  if (referenceEntry.body.hash === comparisonEntry.body.hash)
    return {
      kind: 'exact',
      message: 'The response bodies are identical. Headers and other details may differ.',
      changes: [],
      limited: false,
    };
  if (referenceEntry.body.state !== 'text' || comparisonEntry.body.state !== 'text')
    return {
      kind: 'binary',
      message: 'The response bodies differ. A text comparison is unavailable for binary data.',
      changes: [],
      limited: false,
    };
  if (
    (referenceEntry.body.bytes ?? Infinity) > DIFF_LIMITS.bytes ||
    (comparisonEntry.body.bytes ?? Infinity) > DIFF_LIMITS.bytes
  )
    return {
      kind: 'limited',
      message: 'The response bodies differ. Detailed comparison is limited to bodies up to 64 KiB.',
      changes: [],
      limited: true,
    };
  if (referenceEntry.body.text === undefined || comparisonEntry.body.text === undefined)
    return {
      kind: 'unavailable',
      message:
        'The response bodies differ. Reopen the entries to load their captured text for comparison.',
      changes: [],
      limited: false,
    };
  const referenceText = referenceEntry.body.text;
  const comparisonText = comparisonEntry.body.text;
  if (
    !referenceEntry.responseMimeAmbiguous &&
    !comparisonEntry.responseMimeAmbiguous &&
    isJson(referenceEntry.mime) &&
    isJson(comparisonEntry.mime)
  ) {
    try {
      guardJson(referenceText, DIFF_LIMITS.depth, DIFF_LIMITS.nodes * 4);
      guardJson(comparisonText, DIFF_LIMITS.depth, DIFF_LIMITS.nodes * 4);
      const result = diffJson(parseLosslessJson(referenceText), parseLosslessJson(comparisonText));
      if (result.changes.length || result.limited)
        return {
          kind: 'json',
          message:
            'JSON changes include field names, value types, array order, and numbers. Long values are shown as excerpts.',
          ...result,
        };
      // Formatting and key order remain observable in the raw text fallback.
    } catch {
      /* Fall back to raw text without logging capture content. */
    }
  }
  return {
    kind: 'text',
    message:
      'Decoded text differs. Line comparison preserves formatting and raw JSON differences. Long values are excerpts.',
    ...diffText(referenceText, comparisonText),
  };
}

export function compare(referenceEntry: Entry, comparisonEntry: Entry): Comparison {
  const metadata: Change[] = [];
  const keys = [
    'method',
    'requestHttpVersion',
    'responseHttpVersion',
    'url',
    'status',
    'statusText',
    'mime',
    'time',
    'reportedSize',
    'transportError',
    'responseHeadersAvailable',
  ] as const;
  const value = (entry: Entry, key: (typeof keys)[number]): unknown => {
    // Unavailable evidence has a per-source identity, just as it does in partitioning.
    if (
      (key === 'status' && entry.status === null) ||
      (key === 'mime' && entry.responseMimeAvailable === false) ||
      (key === 'transportError' && entry.transportErrorUnavailable) ||
      (key === 'responseHeadersAvailable' &&
        entry.diagnostics?.some((message) => message.startsWith('Response headers')))
    )
      return { state: 'unavailable', entry: entry.id };
    if (key === 'responseHeadersAvailable') return entry.responseHeadersAvailable !== false;
    return entry[key];
  };
  for (const key of keys) {
    const before = value(referenceEntry, key);
    const after = value(comparisonEntry, key);
    if (JSON.stringify(before) !== JSON.stringify(after))
      metadata.push({
        path: key,
        kind: 'changed',
        reference: excerpt(before),
        comparison: excerpt(after),
      });
  }
  return {
    reference: referenceEntry.id,
    comparison: comparisonEntry.id,
    metadata,
    headers: diffHeaders(referenceEntry.responseHeaders, comparisonEntry.responseHeaders),
    body: bodyDiff(referenceEntry, comparisonEntry),
  };
}
