import { valueGrammar } from './value-grammar.js';
import { hasProtocolNoisePolicy, responseHeaderKey } from './response-policy.js';
import { decomposeCookie } from './cookie-slots.js';
import { type ResponseSlot } from './response-slots.js';
import { isProtocolBoundary } from './protocol-boundaries.js';
import type { Entry } from './types.js';

/** Shared protocol grammar and generic value slots; all raw headers remain on the entry. */
export function decomposeHeaders(entry: Entry, captureTimeValue: unknown) {
  const headerKey = responseHeaderKey(entry);
  if (
    entry.responseHeaders.some(
      (h) =>
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(h.name) ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\r\n]/.test(h.value),
    )
  )
    return {
      skeleton: headerKey,
      slots: [] as ResponseSlot[],
      diagnostics: [] as ResponseSlot[],
      headerKey,
    };

  let headers: [string, string[]][];
  try {
    headers = JSON.parse(headerKey);
  } catch {
    return;
  }
  if (!Array.isArray(headers)) return;
  const shape: unknown[] = [],
    slots: ResponseSlot[] = [],
    diagnostics: ResponseSlot[] = [];
  for (const [name, values] of headers) {
    if (isProtocolBoundary(name) || hasProtocolNoisePolicy(name)) {
      shape.push([name, values]);
      continue;
    }
    if (name === 'set-cookie') {
      const dates = entry.responseHeaders.filter((h) => h.name.toLowerCase() === 'date');
      const date = dates.length === 1 ? Date.parse(dates[0].value) : NaN;
      const captured = captureTimeValue;
      const captureTime = typeof captured === 'string' ? Date.parse(captured) : NaN;
      const validCapture =
        typeof captured === 'string' &&
        /^\d{4}-/.test(captured) &&
        valueGrammar(captured) === 'timestamp:iso';
      const serverClock = Number.isFinite(date) && new Date(date).toUTCString() === dates[0].value;
      const clock = serverClock ? date : validCapture ? captureTime : undefined;
      const cookies = values.map((value) => decomposeCookie(value, clock, serverClock));
      const names = cookies.map((c) => c?.skeleton[0]);
      if (cookies.some((c) => !c) || new Set(names).size !== names.length) {
        shape.push([name, values]);
        continue;
      }
      shape.push([name, cookies.map((c) => c!.skeleton)]);
      for (const [i, cookie] of cookies.entries())
        slots.push(
          ...cookie!.slots.map((s) => ({
            ...s,
            path: JSON.stringify(['cookie-occurrence', i, s.path]),
          })),
        );
    } else {
      for (const [occurrence, value] of values.entries())
        diagnostics.push({
          path: JSON.stringify(['header', name, occurrence]),
          type: 'string',
          value,
        });
    }
  }
  return { skeleton: JSON.stringify(shape), slots, diagnostics, headerKey };
}
