import { DatabaseSync } from 'node:sqlite';
import type { Draft, LlmCall, LogEntry, Memory, Revision, WorldLine } from '@wispiva/contract';
import type { MemoryRow, ReflectionRow, StoreApi } from './api.js';

type SqlRow = Record<string, unknown>;
type LinePatch = Partial<Pick<WorldLine,
  'name' | 'speed' | 'paused' | 'plan' | 'status' | 'error' | 'retryAt'
  | 'headRevisionId' | 'worldTimeMinutes'>>;
type CallPatch = Partial<Pick<LlmCall, 'status' | 'attempts' | 'usage' | 'error' | 'finishedAt'>>;

const schema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS lines (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_line_id TEXT, fork_revision_id TEXT,
    fork_time_minutes REAL, head_revision_id TEXT NOT NULL, world_time_minutes REAL NOT NULL,
    speed REAL NOT NULL, paused INTEGER NOT NULL, plan_json TEXT, status TEXT NOT NULL,
    error TEXT, retry_at REAL NOT NULL, created_at REAL NOT NULL DEFAULT (unixepoch('subsec') * 1000)
  );
  CREATE TABLE IF NOT EXISTS revisions (
    id TEXT PRIMARY KEY, parent_id TEXT, line_id TEXT NOT NULL, world_time_minutes REAL NOT NULL,
    event_json TEXT NOT NULL, world_json TEXT NOT NULL, created_at REAL NOT NULL DEFAULT (unixepoch('subsec') * 1000)
  );
  CREATE INDEX IF NOT EXISTS revisions_line_parent ON revisions(line_id, parent_id);
  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY, line_id TEXT, base_revision_id TEXT, world_time_minutes REAL NOT NULL,
    speed REAL NOT NULL, paused INTEGER NOT NULL, world_json TEXT NOT NULL, created_at REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS llm_calls (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, line_id TEXT NOT NULL, base_revision_id TEXT NOT NULL,
    start_minutes REAL NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL,
    started_at REAL NOT NULL, finished_at REAL
  );
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, line_id TEXT NOT NULL, owner TEXT NOT NULL, text TEXT NOT NULL,
    valence REAL NOT NULL, intensity REAL NOT NULL, importance REAL NOT NULL, about_json TEXT NOT NULL,
    emotion TEXT, source_event_id TEXT NOT NULL, at_minutes REAL NOT NULL, last_accessed_minutes REAL
  );
  CREATE INDEX IF NOT EXISTS memories_line_owner ON memories(line_id, owner, at_minutes DESC);
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_text_fts USING fts5(
    memory_id UNINDEXED, line_id UNINDEXED, owner UNINDEXED, text, tokenize='trigram'
  );
  CREATE TABLE IF NOT EXISTS memory_reflections (
    line_id TEXT NOT NULL, owner TEXT NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL,
    from_minutes REAL NOT NULL, to_minutes REAL NOT NULL, generated_at REAL NOT NULL,
    PRIMARY KEY(line_id, owner, version)
  );
  CREATE INDEX IF NOT EXISTS reflections_latest ON memory_reflections(line_id, owner, version DESC);
`;

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function lineFromRow(row: SqlRow): WorldLine {
  return {
    id: String(row.id), name: String(row.name), parentLineId: row.parent_line_id as string | null,
    forkRevisionId: row.fork_revision_id as string | null,
    forkTimeMinutes: row.fork_time_minutes as number | null,
    headRevisionId: String(row.head_revision_id), worldTimeMinutes: Number(row.world_time_minutes),
    speed: Number(row.speed), paused: Boolean(row.paused),
    plan: row.plan_json === null ? null : parseJson(row.plan_json),
    status: row.status as WorldLine['status'], error: row.error as string | null,
    retryAt: Number(row.retry_at),
  };
}

function memoryFromRow(row: SqlRow): MemoryRow {
  return {
    id: String(row.id), lineId: String(row.line_id), owner: String(row.owner), text: String(row.text),
    valence: Number(row.valence), intensity: Number(row.intensity), importance: Number(row.importance),
    about: parseJson<string[]>(row.about_json),
    ...(row.emotion === null ? {} : { emotion: row.emotion as Memory['emotion'] }),
    sourceEventId: String(row.source_event_id), atMinutes: Number(row.at_minutes),
    ...(row.last_accessed_minutes === null ? {} : { lastAccessedMinutes: Number(row.last_accessed_minutes) }),
  };
}

function reflectionFromRow(row: SqlRow): ReflectionRow {
  return {
    lineId: String(row.line_id), owner: String(row.owner), version: Number(row.version), text: String(row.text),
    fromMinutes: Number(row.from_minutes), toMinutes: Number(row.to_minutes), generatedAt: Number(row.generated_at),
  };
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

function sqlRow(value: unknown): SqlRow | undefined {
  return value as SqlRow | undefined;
}

export class Store implements StoreApi {
  private inTransaction = false;
  private closed = false;

  constructor(private readonly db: DatabaseSync) {}

  private ensureOpen(): void {
    if (this.closed) throw new Error('Store is closed.');
  }

  private async atomic<T>(fn: () => T): Promise<T> {
    this.ensureOpen();
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  async getLine(id: string): Promise<WorldLine | null> {
    this.ensureOpen();
    const row = sqlRow(this.db.prepare('SELECT * FROM lines WHERE id = ?').get(id));
    return row ? lineFromRow(row) : null;
  }

  async listLines(): Promise<WorldLine[]> {
    this.ensureOpen();
    return this.db.prepare('SELECT * FROM lines ORDER BY created_at, id').all().map((row) => lineFromRow(row as SqlRow));
  }

  async createLine(line: WorldLine): Promise<void> {
    this.ensureOpen();
    this.db.prepare(`INSERT INTO lines
      (id,name,parent_line_id,fork_revision_id,fork_time_minutes,head_revision_id,world_time_minutes,speed,paused,plan_json,status,error,retry_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      line.id, line.name, line.parentLineId, line.forkRevisionId, line.forkTimeMinutes, line.headRevisionId,
      line.worldTimeMinutes, line.speed, Number(line.paused), line.plan === null ? null : encodeJson(line.plan),
      line.status, line.error, line.retryAt,
    );
  }

  async updateLine(id: string, patch: LinePatch): Promise<void> {
    this.ensureOpen();
    const columns: Record<keyof LinePatch, string> = {
      name: 'name', speed: 'speed', paused: 'paused', plan: 'plan_json', status: 'status', error: 'error',
      retryAt: 'retry_at', headRevisionId: 'head_revision_id', worldTimeMinutes: 'world_time_minutes',
    };
    const entries = (Object.entries(patch) as [keyof LinePatch, LinePatch[keyof LinePatch]][])
      .filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const assignments = entries.map(([key]) => `${columns[key]} = ?`).join(', ');
    const values = entries.map(([key, value]) => {
      if (key === 'paused') return Number(value);
      if (key === 'plan') return value === null ? null : encodeJson(value);
      return value as string | number | null;
    });
    const result = this.db.prepare(`UPDATE lines SET ${assignments} WHERE id = ?`).run(...values, id);
    if (result.changes === 0) throw new Error(`Line not found: ${id}`);
  }

  async getRevision(id: string): Promise<Revision | null> {
    this.ensureOpen();
    const row = sqlRow(this.db.prepare('SELECT * FROM revisions WHERE id = ?').get(id));
    return row ? {
      id: String(row.id), parentId: row.parent_id as string | null, worldTimeMinutes: Number(row.world_time_minutes),
      event: parseJson<Revision['event']>(row.event_json), world: parseJson<Revision['world']>(row.world_json),
    } : null;
  }

  async appendRevisions(lineId: string, revisions: Revision[]): Promise<void> {
    await this.atomic(() => {
      if (revisions.length === 0) return;
      let parentId: string | null = String(sqlRow(this.db.prepare('SELECT head_revision_id FROM lines WHERE id = ?').get(lineId))?.head_revision_id ?? '');
      if (!parentId) throw new Error(`Line not found: ${lineId}`);
      const rootAlreadyStored = sqlRow(this.db.prepare('SELECT id FROM revisions WHERE id = ?').get(parentId)) !== undefined;
      const insert = this.db.prepare(`INSERT INTO revisions(id,parent_id,line_id,world_time_minutes,event_json,world_json)
        VALUES (?,?,?,?,?,?)`);
      for (const revision of revisions) {
        const isInitialOrigin = !rootAlreadyStored && revision.id === parentId && revision.parentId === null;
        if (!isInitialOrigin && revision.parentId !== parentId) throw new Error(`Revision ${revision.id} does not extend the current chain.`);
        insert.run(revision.id, revision.parentId, lineId, revision.worldTimeMinutes, encodeJson(revision.event), encodeJson(revision.world));
        parentId = revision.id;
      }
      const last = revisions.at(-1)!;
      const changed = this.db.prepare('UPDATE lines SET head_revision_id = ?, world_time_minutes = ? WHERE id = ?')
        .run(last.id, last.worldTimeMinutes, lineId).changes;
      if (changed === 0) throw new Error(`Line not found: ${lineId}`);
    });
  }

  async pageLog(lineId: string, q: { beforeRevisionId?: string; limit: number }): Promise<{ lineId: string; entries: LogEntry[]; nextBeforeRevisionId: string | null }> {
    this.ensureOpen();
    if (!Number.isInteger(q.limit) || q.limit < 1) throw new Error('Log page limit must be a positive integer.');
    let current = q.beforeRevisionId
      ? sqlRow(this.db.prepare('SELECT parent_id FROM revisions WHERE id = ? AND line_id = ?').get(q.beforeRevisionId, lineId))?.parent_id
      : sqlRow(this.db.prepare('SELECT head_revision_id FROM lines WHERE id = ?').get(lineId))?.head_revision_id;
    const entries: LogEntry[] = [];
    while (current !== null && current !== undefined && entries.length < q.limit) {
      const row = sqlRow(this.db.prepare('SELECT * FROM revisions WHERE id = ?').get(current));
      if (!row) break;
      entries.push({
        id: String(row.id), parentId: row.parent_id as string | null, worldTimeMinutes: Number(row.world_time_minutes),
        event: parseJson<Revision['event']>(row.event_json),
      });
      current = row.parent_id;
    }
    const nextBeforeRevisionId = current === null || current === undefined ? null : String(entries.at(-1)?.id ?? current);
    return { lineId, entries, nextBeforeRevisionId };
  }

  async createDraft(draft: Draft): Promise<void> {
    this.ensureOpen();
    this.db.prepare(`INSERT INTO drafts(id,line_id,base_revision_id,world_time_minutes,speed,paused,world_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(draft.id, draft.lineId, draft.baseRevisionId, draft.worldTimeMinutes, draft.speed,
      Number(draft.paused), encodeJson(draft.world), draft.createdAt);
  }

  async getDraft(id: string): Promise<Draft | null> {
    this.ensureOpen();
    const row = sqlRow(this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id));
    return row ? {
      id: String(row.id), lineId: row.line_id as string | null, baseRevisionId: row.base_revision_id as string | null,
      worldTimeMinutes: Number(row.world_time_minutes), speed: Number(row.speed), paused: Boolean(row.paused),
      world: parseJson<Revision['world']>(row.world_json), createdAt: Number(row.created_at),
    } : null;
  }

  async deleteDraft(id: string): Promise<void> {
    this.ensureOpen();
    this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id);
  }

  async createCall(call: LlmCall): Promise<void> {
    this.ensureOpen();
    this.db.prepare(`INSERT INTO llm_calls(id,kind,line_id,base_revision_id,start_minutes,status,payload_json,started_at,finished_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(call.id, call.kind, call.lineId, call.baseRevisionId, call.startMinutes, call.status,
      encodeJson({ messages: call.messages, attempts: call.attempts, ...(call.usage === undefined ? {} : { usage: call.usage }), ...(call.error === undefined ? {} : { error: call.error }) }),
      call.startedAt, call.finishedAt ?? null);
  }

  async updateCall(id: string, patch: CallPatch): Promise<void> {
    this.ensureOpen();
    const current = await this.getCall(id);
    if (!current) throw new Error(`Call not found: ${id}`);
    const next = { ...current, ...patch };
    this.db.prepare(`UPDATE llm_calls SET status=?, payload_json=?, finished_at=? WHERE id=?`).run(
      next.status, encodeJson({ messages: next.messages, attempts: next.attempts,
        ...(next.usage === undefined ? {} : { usage: next.usage }), ...(next.error === undefined ? {} : { error: next.error }) }),
      next.finishedAt ?? null, id,
    );
  }

  async getCall(id: string): Promise<LlmCall | null> {
    this.ensureOpen();
    const row = sqlRow(this.db.prepare('SELECT * FROM llm_calls WHERE id = ?').get(id));
    if (!row) return null;
    const payload = parseJson<Pick<LlmCall, 'messages' | 'attempts' | 'usage' | 'error'>>(row.payload_json);
    return {
      id: String(row.id), kind: row.kind as LlmCall['kind'], lineId: String(row.line_id),
      baseRevisionId: String(row.base_revision_id), startMinutes: Number(row.start_minutes),
      status: row.status as LlmCall['status'], ...payload, startedAt: Number(row.started_at),
      ...(row.finished_at === null ? {} : { finishedAt: Number(row.finished_at) }),
    };
  }

  async appendMemories(lineId: string, memories: Memory[], sourceEventId: string): Promise<void> {
    await this.atomic(() => {
      const eventTime = sqlRow(this.db.prepare(`SELECT world_time_minutes FROM revisions
        WHERE line_id=? AND json_extract(event_json, '$.id')=? LIMIT 1`).get(lineId, sourceEventId));
      const lineTime = sqlRow(this.db.prepare('SELECT world_time_minutes FROM lines WHERE id = ?').get(lineId));
      if (!lineTime) throw new Error(`Line not found: ${lineId}`);
      const atMinutes = Number(eventTime?.world_time_minutes ?? lineTime.world_time_minutes);
      const insert = this.db.prepare(`INSERT INTO memories
        (id,line_id,owner,text,valence,intensity,importance,about_json,emotion,source_event_id,at_minutes,last_accessed_minutes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`);
      const fts = this.db.prepare('INSERT INTO memory_text_fts(memory_id,line_id,owner,text) VALUES (?,?,?,?)');
      for (const memory of memories) {
        insert.run(memory.id, lineId, memory.owner, memory.text, memory.valence, memory.intensity,
          memory.importance, encodeJson(memory.about), memory.emotion ?? null, sourceEventId, atMinutes);
        fts.run(memory.id, lineId, memory.owner, memory.text);
      }
    });
  }

  async getMemories(lineId: string, owners: string[], limit: number): Promise<MemoryRow[]> {
    this.ensureOpen();
    if (owners.length === 0 || limit <= 0) return [];
    const placeholders = owners.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM memories WHERE line_id=? AND owner IN (${placeholders})
      ORDER BY at_minutes DESC, id LIMIT ?`).all(lineId, ...owners, limit).map((row) => memoryFromRow(row as SqlRow));
  }

  async searchMemoryText(lineId: string, owners: string[], query: string, limit: number): Promise<MemoryRow[]> {
    this.ensureOpen();
    if (!query || owners.length === 0 || limit <= 0) return [];
    const placeholders = owners.map(() => '?').join(',');
    if ([...query].length < 3) {
      return this.db.prepare(`SELECT * FROM memories WHERE line_id=? AND owner IN (${placeholders}) AND instr(text,?) > 0
        ORDER BY at_minutes DESC, id LIMIT ?`).all(lineId, ...owners, query, limit).map((row) => memoryFromRow(row as SqlRow));
    }
    const match = `"${query.replaceAll('"', '""')}"`;
    return this.db.prepare(`SELECT m.* FROM memory_text_fts f JOIN memories m ON m.id=f.memory_id
      WHERE memory_text_fts MATCH ? AND f.line_id=? AND f.owner IN (${placeholders})
      ORDER BY m.at_minutes DESC, m.id LIMIT ?`).all(match, lineId, ...owners, limit).map((row) => memoryFromRow(row as SqlRow));
  }

  async touchMemories(ids: string[], atMinutes: number): Promise<void> {
    this.ensureOpen();
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`UPDATE memories SET last_accessed_minutes=? WHERE id IN (${placeholders})`).run(atMinutes, ...ids);
  }

  async getReflection(lineId: string, owner: string): Promise<ReflectionRow | null> {
    this.ensureOpen();
    const row = sqlRow(this.db.prepare(`SELECT * FROM memory_reflections
      WHERE line_id=? AND owner=? ORDER BY version DESC LIMIT 1`).get(lineId, owner));
    return row ? reflectionFromRow(row) : null;
  }

  async saveReflection(row: ReflectionRow): Promise<void> {
    await this.atomic(() => {
      const latest = sqlRow(this.db.prepare(`SELECT MAX(version) AS version FROM memory_reflections WHERE line_id=? AND owner=?`)
        .get(row.lineId, row.owner));
      const version = Number(latest?.version ?? 0) + 1;
      this.db.prepare(`INSERT INTO memory_reflections(line_id,owner,version,text,from_minutes,to_minutes,generated_at)
        VALUES (?,?,?,?,?,?,?)`).run(row.lineId, row.owner, version, row.text, row.fromMinutes, row.toMinutes, row.generatedAt);
    });
  }

  async transaction<T>(fn: (tx: StoreApi) => Promise<T>): Promise<T> {
    this.ensureOpen();
    if (this.inTransaction) throw new Error('Nested transactions are not supported.');
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  async recoverInFlight(): Promise<void> {
    await this.atomic(() => {
      const pending = this.db.prepare("SELECT id,payload_json FROM llm_calls WHERE status='pending'").all() as SqlRow[];
      const updateCall = this.db.prepare("UPDATE llm_calls SET status='failed', payload_json=?, finished_at=? WHERE id=?");
      const now = Date.now();
      for (const row of pending) {
        const payload = parseJson<Record<string, unknown>>(row.payload_json);
        payload.error = 'Process restarted while call was in flight.';
        updateCall.run(encodeJson(payload), now, row.id);
      }
      this.db.prepare("UPDATE lines SET status='ready' WHERE status='generating'").run();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.inTransaction) throw new Error('Cannot close Store during a transaction.');
    this.db.close();
    this.closed = true;
  }
}

export async function openStore(path: string): Promise<Store> {
  const db = new DatabaseSync(path);
  try {
    db.exec(schema);
    const store = new Store(db);
    await store.recoverInFlight();
    return store;
  } catch (error) {
    db.close();
    throw error;
  }
}

export type { MemoryRow, ReflectionRow, StoreApi } from './api.js';
