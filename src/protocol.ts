import type { HarErrorCode } from './errors.js';
import type {
  CaptureOptions,
  Limits,
  Comparison,
  RequestChanges,
  EntryRow,
  GroupRow,
  Page,
  Summary,
} from './types.js';
import type { Entry } from './public-types.js';

export type Command =
  | ({ type: 'import'; file: Blob } & CaptureOptions)
  | { type: 'sample'; limits?: Partial<Limits> }
  | {
      type: 'groups';
      kind: 'endpoints' | 'outcomes';
      page: number;
      pageSize?: number;
      search: string;
      endpoint?: string;
      status?: string;
    }
  | {
      type: 'members';
      kind: 'endpoints' | 'outcomes';
      group: string;
      page: number;
      pageSize?: number;
      search: string;
      status: string;
      anchor?: number;
      method?: string;
    }
  | { type: 'entry'; id: number }
  | { type: 'request-changes'; id: number }
  | { type: 'compare'; reference: number; comparison: number };
export type Request = Command & { seq: number };
export type Reply =
  | { type: 'progress'; done: number; total: number; entries: number }
  | { type: 'ready'; summary: Summary; seq: number }
  | { type: 'groups'; data: Page<GroupRow>; seq: number }
  | { type: 'members'; data: Page<EntryRow>; seq: number }
  | { type: 'entry'; data: Entry; seq: number }
  | { type: 'request-changes'; data: RequestChanges; seq: number }
  | { type: 'compare'; data: Comparison; seq: number }
  | { type: 'error'; message: string; code?: HarErrorCode; seq: number };

export type DataReply = Exclude<Reply, { type: 'progress' } | { type: 'error' }>;
export type RequestFunction = (command: Command) => Promise<DataReply | null>;

/** Reply correlated with its command, including unions of import/query commands. */
export type ReplyFor<C extends Command> = C extends { type: 'import' | 'sample' }
  ? Extract<DataReply, { type: 'ready' }>
  : Extract<DataReply, { type: C['type'] }>;
