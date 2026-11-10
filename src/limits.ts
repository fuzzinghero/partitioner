import { HarError } from './parse.js';
import { LIMITS, MAX_PAGE_ROWS } from './types.js';
import type { Limits } from './types.js';

/** Snapshot and validate caller policy before reading capture data or creating a worker. */
export function resolveLimits(...overrides: (Partial<Limits> | undefined)[]): Limits {
  const limits = { ...LIMITS };
  for (const override of overrides) {
    if (override === undefined) continue;
    if (!override || typeof override !== 'object' || Array.isArray(override))
      throw new HarError('Invalid analysis limit configuration.', 'INVALID_OPTIONS');
    for (const [key, value] of Object.entries(override)) {
      if (!Object.hasOwn(LIMITS, key))
        throw new HarError('Unknown analysis limit.', 'INVALID_OPTIONS');
      if (value === undefined) continue;
      if (key === 'fileBytes' && value === null) {
        limits.fileBytes = null;
        continue;
      }
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new HarError(
          'Analysis limits must be nonnegative safe integers. Only fileBytes accepts null.',
          'INVALID_OPTIONS',
        );
      Object.defineProperty(limits, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return limits;
}

export const fileLimitMessage = (bytes: number) =>
  `File exceeds the configured byte limit (${bytes.toLocaleString('en-US')} bytes).`;

export function resolvePageSize(pageSize: number): number {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_ROWS) {
    throw new HarError(
      `Page size must be an integer from 1 to ${MAX_PAGE_ROWS}.`,
      'INVALID_ARGUMENT',
    );
  }
  return pageSize;
}
