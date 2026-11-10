import type { Analysis, Limits } from './types.js';
// Handles are local and weakly owned, never serialized into result messages or persisted.
const sources = new WeakMap<Analysis, { file: Blob; limits: Limits }>();
export const retainSource = (analysis: Analysis, file: Blob, limits: Limits) => {
  sources.set(analysis, { file, limits: { ...limits } });
};
export const sourceFor = (analysis: Analysis) => sources.get(analysis);
