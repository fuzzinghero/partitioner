/** Routing, security, representation/encoding and framing semantics stay literal. */
export const protocolFields = new Set([
  'location',
  'www-authenticate',
  'authorization',
  'proxy-authorization',
  'proxy-authenticate',
  'authentication-info',
  'proxy-authentication-info',
  'content-type',
  'content-disposition',
  'content-encoding',
  'content-range',
  'content-location',
  'content-security-policy',
  'content-security-policy-report-only',
  'referrer-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
  'permissions-policy',
  'x-frame-options',
  'x-content-type-options',
  'refresh',
  'allow',
  'retry-after',
  'transfer-encoding',
]);

export const isProtocolBoundary = (name: string) =>
  protocolFields.has(name) || name.startsWith('access-control-');
