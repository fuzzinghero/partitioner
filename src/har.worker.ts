import { requestChangesComplete } from './request-analysis.js';
import { analyze, analyzeEntry, groupPage, memberPage } from './analyze.js';
import { compare } from './diff.js';
import { HarError, textPrefix } from './parse.js';
import { sampleHar } from './sample.js';
import { sourceFor } from './source.js';
import { PREVIEW_CHARS } from './types.js';
import { streamEntries } from './stream.js';
import type { Analysis, Body, Entry } from './types.js';
import type { Reply, Request } from './protocol.js';
import type { GroupPageCache } from './analyze.js';

let analysis: Analysis | undefined;
let source: Blob | undefined;
let groupCache: GroupPageCache = {};
const reply = (value: Reply) => self.postMessage(value);
const preview = (body: Body): Body => {
  const { hash: _hash, shape: _shape, ...publicBody } = body;
  return {
    ...publicBody,
    text: body.text === undefined ? undefined : textPrefix(body.text, PREVIEW_CHARS),
    displayTruncated: (body.text?.length ?? 0) > PREVIEW_CHARS,
  };
};
async function hydrate(e: Entry): Promise<Entry> {
  if (
    !source ||
    (!e.body.evicted &&
      !e.requestBody.evicted &&
      !e.body.previewDeferred &&
      !e.requestBody.previewDeferred) ||
    e.sourceStart === undefined ||
    e.sourceEnd === undefined
  )
    return e;
  const wrapped = new Blob([
    '{"log":{"entries":[',
    source.slice(e.sourceStart, e.sourceEnd),
    ']}}',
  ]);
  const configured = analysis && sourceFor(analysis)?.limits;
  if (!configured) throw new HarError('Capture configuration unavailable. Reimport the HAR.');
  // Wrapper bytes are not a new input file. Selected reads need bounded transient space
  // for both complete bodies and display-only previews, independently of import retention.
  const limits = {
    ...configured,
    fileBytes: null,
    totalBodyBytes: Math.min(Number.MAX_SAFE_INTEGER, configured.bodyBytes * 2 + PREVIEW_CHARS * 6),
  };
  for await (const row of streamEntries(wrapped, limits)) {
    const full = await analyzeEntry(row.raw, e.id, limits, { bytes: 0, nodes: 0 });
    if (full.body.hash !== e.body.hash || full.requestBody.hash !== e.requestBody.hash)
      throw new HarError(
        'The local file changed or could not be reread consistently. Reimport the HAR.',
        'SOURCE_CHANGED',
      );
    return {
      ...e,
      body: {
        ...e.body,
        text: full.body.text,
        preview: full.body.preview,
        evicted: false,
        previewDeferred: false,
      },
      requestBody: {
        ...e.requestBody,
        text: full.requestBody.text,
        preview: full.requestBody.preview,
        evicted: false,
        previewDeferred: false,
      },
    };
  }
  return e;
}
async function handle(req: Request) {
  try {
    if (req.type === 'import' || req.type === 'sample') {
      analysis = undefined;
      groupCache = {};
      source = req.type === 'sample' ? new Blob([JSON.stringify(sampleHar())]) : req.file;
      analysis = await analyze(
        source,
        (done, total, entries) => reply({ type: 'progress', done, total, entries }),
        undefined,
        { limits: req.limits, ...(req.type === 'import' ? { contexts: req.contexts } : {}) },
      );
      reply({ type: 'ready', summary: analysis.summary, seq: req.seq });
    } else if (analysis) {
      if (
        (req.type === 'entry' || req.type === 'request-changes') &&
        (!Number.isSafeInteger(req.id) || req.id < 0 || !analysis.entries[req.id])
      ) {
        throw new HarError('Entry unavailable.', 'INVALID_ARGUMENT');
      }
      if (!['groups', 'request-changes', 'members', 'entry', 'compare'].includes(req.type))
        throw new HarError('Unknown worker operation.', 'INVALID_ARGUMENT');
      if (req.type === 'groups')
        reply({
          type: 'groups',
          data: groupPage(
            analysis,
            req.kind,
            req.page,
            req.search,
            req.endpoint,
            req.status,
            req.pageSize,
            groupCache,
          ),
          seq: req.seq,
        });
      if (req.type === 'request-changes')
        reply({
          type: 'request-changes',
          data: await requestChangesComplete(analysis, req.id),
          seq: req.seq,
        });
      if (req.type === 'members')
        reply({
          type: 'members',
          data: memberPage(
            analysis,
            req.group,
            req.kind,
            req.page,
            req.search,
            req.status,
            req.anchor,
            req.method,
            req.pageSize,
          ),
          seq: req.seq,
        });
      if (req.type === 'entry') {
        const retained = analysis.entries[req.id];
        const e = retained ? await hydrate(retained) : undefined;
        if (!e) throw new HarError('Entry unavailable.', 'INVALID_ARGUMENT');
        const {
          requestHeadersHash: _requestHeadersHash,
          responseHeaderFingerprint: _responseHeaderFingerprint,
          responseMimeAmbiguous: _responseMimeAmbiguous,
          contextUrl: _contextUrl,
          ...publicEntry
        } = e;
        reply({
          type: 'entry',
          data: { ...publicEntry, body: preview(e.body), requestBody: preview(e.requestBody) },
          seq: req.seq,
        });
      }
      if (req.type === 'compare') {
        const a = analysis.entries[req.reference],
          b = analysis.entries[req.comparison];
        if (!a || !b) throw new HarError('Select two available entries.', 'INVALID_ARGUMENT');
        reply({ type: 'compare', data: compare(await hydrate(a), await hydrate(b)), seq: req.seq });
      }
    } else throw new HarError('No capture is available. Import a HAR first.', 'NOT_READY');
  } catch (error) {
    if (req.type === 'import' || req.type === 'sample') {
      analysis = undefined;
      source = undefined;
    }
    // Never emit parser/browser exception messages that may contain capture text.
    reply({
      type: 'error',
      code: error instanceof HarError ? error.code : 'INTERNAL_ERROR',
      message:
        error instanceof HarError
          ? error.message
          : 'Analysis failed safely. Try a smaller capture.',
      seq: req.seq,
    });
  }
}
// Serial hydration/compare work bounds transient memory even under repeated clicks.
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<Request>) => {
  queue = queue.then(
    () => handle(event.data),
    () => handle(event.data),
  );
};
