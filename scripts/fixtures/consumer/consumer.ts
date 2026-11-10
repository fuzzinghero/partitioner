import {
  AnalyzerClient,
  HarAnalyzerClient,
  createAnalyzer,
  createHarAnalyzer,
} from '@fuzzinghero/partitioner/browser';
import { analyze, groupPage } from '@fuzzinghero/partitioner/core';
import { HarError } from '@fuzzinghero/partitioner';
import type {
  Command,
  NormalizationRule,
  Summary,
  Entry,
  Page,
  GroupRow,
  EntryRow,
  Comparison,
  RequestChanges,
} from '@fuzzinghero/partitioner';

export async function customer(file: Blob) {
  const analyzer = createAnalyzer();
  const controller = new AbortController();
  try {
    const summary: Summary = await analyzer.analyze(file, {
      signal: controller.signal,
      onProgress: (progress) => {
        const bytes: number = progress.done;
        void bytes;
      },
    });
    const partitions: Page<GroupRow> = await analyzer.getPartitions({ pageSize: 10 });
    const rules: NormalizationRule[] | undefined = partitions.rows[0].normalizations;
    void rules;
    const contexts: Page<GroupRow> = await analyzer.getContexts();
    const members: Page<EntryRow> = await analyzer.getMembers(partitions.rows[0].id);
    const entry: Entry = await analyzer.getEntry(0);
    const comparison: Comparison = await analyzer.compare(0, 1);
    const changes: RequestChanges = await analyzer.getRequestChanges(0);
    const raw = await analyzer.request({ type: 'entry', id: 0 });
    if (raw) {
      const retained: Entry = raw.data;
      void retained;
    }
    // A query cannot silently become an unrelated reply type.
    // @ts-expect-error getEntry returns an Entry, not a Comparison.
    const wrong: Comparison = await analyzer.getEntry(0);
    void wrong;
    const core = await analyze(file, { signal: controller.signal, limits: { fileBytes: null } });
    const legacy = await analyze(file, undefined, { entries: 1000 });
    groupPage(core, 'outcomes', 0, '', undefined, '', 10);
    return { summary, partitions, contexts, members, entry, comparison, changes, legacy };
  } catch (error) {
    if (error instanceof HarError && error.code === 'ABORTED') return;
    throw error;
  } finally {
    analyzer.dispose();
  }
}

// Both constructor and factory spellings remain usable by existing typed consumers.
export function compatibleClients(): AnalyzerClient[] {
  const legacy: HarAnalyzerClient = createHarAnalyzer();
  return [new AnalyzerClient(), new HarAnalyzerClient(), legacy];
}

// Generic command unions retain both ready and query reply types.
export async function unionRequest(client: ReturnType<typeof createAnalyzer>, command: Command) {
  const reply = await client.request(command);
  if (reply?.type === 'ready') {
    const summary: Summary = reply.summary;
    return summary;
  }
  return reply;
}
