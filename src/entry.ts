import { readBody, sha256 } from './body.js';
import type { Budget } from './body.js';
import {
  finite,
  headers,
  headerName,
  HarError,
  record,
  requestMediaType,
  normalizedMediaType,
} from './parse.js';
import type { Entry, Limits } from './types.js';
import { contextTarget } from './context-target.js';

const encoder = new TextEncoder();

/** Read one HAR entry. Invalid components produce diagnostics without erasing independent evidence. */
export async function analyzeEntry(
  raw: unknown,
  id: number,
  limits: Limits,
  budget: Budget,
): Promise<Entry> {
  const captured = record(raw);
  const request = record(captured.request);
  const response = record(captured.response);
  const content = record(response.content);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HarError('Invalid HAR entry.');
  const diagnostics: string[] = [];
  const boundedText = (value: unknown, max: number): string | undefined =>
    typeof value === 'string' && value.length <= max ? value : undefined;
  const method = boundedText(request.method, limits.fieldChars) ?? '(unavailable)';
  const requestMethodAvailable =
    typeof request.method === 'string' &&
    request.method === method &&
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(method);
  const url = boundedText(request.url, limits.fieldChars) ?? '';
  const requestUrlAvailable = typeof request.url === 'string' && request.url === url && url !== '';
  if (!requestMethodAvailable)
    diagnostics.push('Request method is missing, malformed, or excessive.');
  if (!requestUrlAvailable) diagnostics.push('Request URL is missing or excessive.');
  const status =
    typeof response.status === 'number' &&
    Number.isInteger(response.status) &&
    response.status >= 0 &&
    response.status <= 999
      ? response.status
      : null;
  if (status === null) diagnostics.push('Response status is missing or invalid.');
  const reportedMime = normalizedMediaType(content.mimeType);
  if (content.mimeType !== undefined && reportedMime === undefined)
    diagnostics.push('Response media type is invalid or excessive.');
  const safeHeaders = (value: unknown, name: string) => {
    try {
      return headers(value, limits);
    } catch {
      diagnostics.push(`${name} are invalid or excessive; unavailable.`);
      return [];
    }
  };
  const requestHeaders = safeHeaders(request.headers, 'Request headers'),
    responseHeaders = safeHeaders(response.headers, 'Response headers'),
    query = safeHeaders(request.queryString, 'Query fields');
  for (const [kind, fields] of [
    ['request', requestHeaders],
    ['response', responseHeaders],
  ] as const) {
    if (
      fields.some(
        (h) =>
          !/^:?[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(h.name) ||
          /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\r\n]/.test(h.value),
      )
    )
      diagnostics.push(
        `Captured ${kind} header syntax is malformed. Original values were retained.`,
      );
  }
  const contentTypes = responseHeaders.filter((h) => headerName(h.name) === 'content-type');
  const fallbackMime =
    contentTypes.length === 1
      ? normalizedMediaType(contentTypes[0].value.replace(/^[ \t]+|[ \t]+$/g, ''))
      : undefined;
  if (reportedMime === undefined && contentTypes.length > 0 && fallbackMime === undefined)
    diagnostics.push('Response Content-Type fallback is invalid, ambiguous, or excessive.');
  const mime = reportedMime ?? fallbackMime ?? '';
  const mimeBase = (value: string) => value.split(';')[0].trim().toLowerCase();
  const ambiguousHeader = contentTypes.length > 0 && fallbackMime === undefined;
  const conflictingMime =
    reportedMime !== undefined &&
    fallbackMime !== undefined &&
    mimeBase(reportedMime) !== mimeBase(fallbackMime);
  const responseMimeAmbiguous = ambiguousHeader || conflictingMime;
  if (responseMimeAmbiguous)
    diagnostics.push(
      'Response Content-Type headers conflict with HAR media type or are ambiguous. Body comparison uses captured bytes.',
    );
  const responseMimeAvailable = mime !== '';
  const observed = (name: string) =>
    requestHeaders.filter((h) => headerName(h.name) === name).map((h) => h.value);
  const authorities = [...observed('host'), ...observed(':authority')];
  let parsedUrl: URL | undefined;
  try {
    parsedUrl = new URL(url);
  } catch {
    /* Origin-form or malformed target remains literal. */
  }
  const canonicalAuthority = (value: string) => {
    if (parsedUrl && /^[^/?#@\s]+$/.test(value)) {
      try {
        return new URL(`${parsedUrl.protocol}//${value}`).host;
      } catch {
        /* Preserve malformed values. */
      }
    }
    return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
  };
  const urlAuthority = parsedUrl?.host;
  if (
    authorities.some((v) => urlAuthority && canonicalAuthority(v) !== urlAuthority) ||
    new Set(authorities.map(canonicalAuthority)).size > 1
  )
    diagnostics.push(
      'Captured Host/:authority conflicts with another captured authority. Routing cannot be inferred.',
    );
  if (observed(':method').some((v) => v !== method))
    diagnostics.push('Captured :method conflicts with HAR method.');
  const absoluteTarget = /^[a-z][a-z\d+.-]*:\/\/[^/?#]+([^#]*)/i.exec(url);
  let target = absoluteTarget ? absoluteTarget[1] || '/' : url.split('#')[0];
  if (absoluteTarget && target.startsWith('?')) target = '/' + target;
  if (observed(':path').some((v) => v !== target))
    diagnostics.push('Captured :path conflicts with HAR URL.');
  const endpoint = JSON.stringify([method, url]);
  const post = record(request.postData);
  const requestMedia = requestMediaType(post, requestHeaders);
  if (requestMedia.incomplete) diagnostics.push('Request media type is invalid or excessive.');
  const requestBody = await readBody(post, requestMedia.mime, limits, budget, false);
  const missingMimeIsInvalid =
    mime === '' && content.mimeType !== undefined && content.mimeType !== '';
  const body = await readBody(
    content,
    mime,
    limits,
    budget,
    !responseMimeAmbiguous && !missingMimeIsInvalid,
  );
  const identity = body.shape
    ? ['structure', body.shape]
    : body.hash
      ? ['exact-bytes', body.hash]
      : ['unavailable', id, body.state];
  const capturedError = response._error !== undefined ? response._error : captured._error;
  const transportError = boundedText(capturedError, 1024);
  const transportErrorUnavailable = capturedError !== undefined && transportError === undefined;
  if (transportErrorUnavailable)
    diagnostics.push('Captured transport error is invalid or excessive. Unavailable.');
  return {
    id,
    method,
    requestMethodAvailable,
    url,
    contextUrl: contextTarget(url, requestHeaders, captured.comment, limits, diagnostics),
    requestUrlAvailable,
    status,
    mime,
    responseMimeAvailable,
    ...(responseMimeAmbiguous ? { responseMimeAmbiguous: true } : {}),
    diagnostics: diagnostics.length ? diagnostics : undefined,
    transportError,
    transportErrorUnavailable,
    time: finite(captured.time),
    reportedSize: finite(content.size),
    requestHttpVersion: boundedText(request.httpVersion, 64),
    responseHttpVersion: boundedText(response.httpVersion, 64),
    statusText: boundedText(response.statusText, 256),
    responseHeadersAvailable:
      Array.isArray(response.headers) && !diagnostics.some((d) => d.startsWith('Response headers')),
    requestHeadersHash: Array.isArray(request.headers)
      ? await sha256(encoder.encode(JSON.stringify(requestHeaders)))
      : undefined,
    requestHeaders,
    responseHeaders,
    query,
    ...(typeof request.bodySize === 'number' &&
    Number.isSafeInteger(request.bodySize) &&
    request.bodySize >= 0
      ? { requestBodySize: request.bodySize }
      : {}),
    requestBody,
    body,
    endpoint,
    outcome: JSON.stringify([endpoint, status, mime, identity]),
  };
}
