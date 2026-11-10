import {
  analyze,
  analyzeReport,
  buildReport,
  type Analysis,
  type AnalysisReport,
  type AnalyzerOptions,
} from '@fuzzinghero/partitioner/core';

// A headless consumer needs Node types, not the DOM library or a browser worker.
export const options: AnalyzerOptions = { limits: { fileBytes: null } };
export async function inspect(file: Blob): Promise<Analysis> {
  return analyze(file, { signal: new AbortController().signal });
}

export async function inspectReport(file: Blob): Promise<AnalysisReport> {
  const direct: AnalysisReport = await analyzeReport(file, { reportLimits: { bodyChars: 1024 } });
  const analysis = await analyze(file);
  const projected: AnalysisReport = await buildReport(analysis);
  return direct.summary.responsePartitions ? direct : projected;
}
