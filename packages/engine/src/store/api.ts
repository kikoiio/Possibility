import type { Draft, EpochMs, LlmCall, LogPage, Memory, Minutes, Revision, WorldLine } from '@wispiva/contract';

export type MemoryRow = Memory & {
  lineId: string;
  atMinutes: Minutes;
  lastAccessedMinutes?: number;
};

export type ReflectionRow = {
  lineId: string;
  owner: string;
  version: number;
  text: string;
  fromMinutes: Minutes;
  toMinutes: Minutes;
  generatedAt: EpochMs;
};

export interface StoreApi {
  getLine(id: string): Promise<WorldLine | null>;
  listLines(): Promise<WorldLine[]>;
  createLine(line: WorldLine): Promise<void>;
  updateLine(id: string, patch: Partial<Pick<WorldLine,
    'name' | 'speed' | 'paused' | 'plan' | 'status' | 'error' | 'retryAt'
    | 'headRevisionId' | 'worldTimeMinutes'>>): Promise<void>;
  getRevision(id: string): Promise<Revision | null>;
  appendRevisions(lineId: string, revisions: Revision[]): Promise<void>;
  pageLog(lineId: string, q: { beforeRevisionId?: string; limit: number }): Promise<LogPage>;
  createDraft(draft: Draft): Promise<void>;
  getDraft(id: string): Promise<Draft | null>;
  deleteDraft(id: string): Promise<void>;
  createCall(call: LlmCall): Promise<void>;
  updateCall(id: string, patch: Partial<Pick<LlmCall,
    'status' | 'attempts' | 'usage' | 'error' | 'finishedAt'>>): Promise<void>;
  getCall(id: string): Promise<LlmCall | null>;
  appendMemories(lineId: string, memories: Memory[], sourceEventId: string): Promise<void>;
  getMemories(lineId: string, owners: string[], limit: number): Promise<MemoryRow[]>;
  searchMemoryText(lineId: string, owners: string[], query: string, limit: number): Promise<MemoryRow[]>;
  touchMemories(ids: string[], atMinutes: number): Promise<void>;
  getReflection(lineId: string, owner: string): Promise<ReflectionRow | null>;
  saveReflection(row: ReflectionRow): Promise<void>;
  transaction<T>(fn: (tx: StoreApi) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
