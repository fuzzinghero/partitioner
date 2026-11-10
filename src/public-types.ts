import type {
  Analysis as InternalAnalysis,
  Body as InternalBody,
  Entry as InternalEntry,
} from './types.js';

/** Captured body data exposed to library clients. Grouping fingerprints stay internal. */
export type Body = Omit<InternalBody, 'hash' | 'shape'>;
/** Captured request and response data exposed to library clients. */
export type Entry = Omit<
  InternalEntry,
  | 'requestHeadersHash'
  | 'responseHeaderFingerprint'
  | 'responseMimeAmbiguous'
  | 'contextUrl'
  | 'requestBody'
  | 'body'
> & {
  requestBody: Body;
  body: Body;
};
/** Readable analysis snapshot. Core query functions require the original local handle. */
export type Analysis = Omit<InternalAnalysis, 'requestIndex' | 'entries'> & { entries: Entry[] };
