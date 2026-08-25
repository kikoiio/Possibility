// src/store/db.ts — D1 访问层（全项目唯一与平台耦合的模块）
// 所有函数以 D1Database 为首个参数，不感知 env，便于测试与迁移。

// ---------------------------------------------------------------------------
// 类型定义（与 migrations/0001_init.sql 对应）
// ---------------------------------------------------------------------------

export type EntryType = 'activity' | 'dialogue' | 'monologue' | 'mystery';
export type EntryStatus = 'published' | 'taken_down';

export interface Entry {
  id: string;
  ts: number;
  type: EntryType;
  residentIds: string[];
  location: string;
  title: string | null;
  content: string;
  status: EntryStatus;
}

export type MemoryKind = 'observation' | 'event' | 'dialogue' | 'reflection' | 'plan';

export interface MemoryEntry {
  id: number;
  residentId: string;
  ts: number;
  kind: MemoryKind;
  content: string;
  salience: number;
  tags: string; // 空格分隔关键词（FTS 索引的主要载体，规避中文分词问题）
  subject: string | null;
}

export type MysteryArc = 'daily' | 'seasonal';
export type MysteryState = 'spawned' | 'investigating' | 'resolved';

export interface MysteryClue {
  ts: number;
  text: string;
}

export interface Mystery {
  id: string;
  arc: MysteryArc;
  title: string;
  premise: string;
  state: MysteryState;
  clues: MysteryClue[];
  resolution: string;
  createdTs: number;
}

export type UsagePurpose =
  | 'plan' | 'action' | 'dialogue' | 'monologue' | 'reflection' | 'mystery' | 'guard';

export interface UsageRecordInput {
  ts: number;
  purpose: UsagePurpose;
  tier: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  estCost: number;
}

export interface UsageSummaryRow {
  purpose: string;
  tier: string;
  model: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  estCost: number;
}

export interface WorldSnapshot {
  ts: number;
  state: unknown;
}

// ---------------------------------------------------------------------------
// 行类型与映射
// ---------------------------------------------------------------------------

interface EntryRow {
  id: string;
  ts: number;
  type: EntryType;
  resident_ids: string;
  location: string;
  title: string | null;
  content: string;
  status: EntryStatus;
}

function rowToEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    ts: row.ts,
    type: row.type,
    residentIds: JSON.parse(row.resident_ids) as string[],
    location: row.location,
    title: row.title,
    content: row.content,
    status: row.status,
  };
}

interface MemoryRow {
  id: number;
  resident_id: string;
  ts: number;
  kind: MemoryKind;
  content: string;
  salience: number;
  tags: string;
  subject: string | null;
}

function rowToMemory(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    residentId: row.resident_id,
    ts: row.ts,
    kind: row.kind,
    content: row.content,
    salience: row.salience,
    tags: row.tags,
    subject: row.subject,
  };
}

interface MysteryRow {
  id: string;
  arc: MysteryArc;
  title: string;
  premise: string;
  state: MysteryState;
  clues: string;
  resolution: string;
  created_ts: number;
}

function rowToMystery(row: MysteryRow): Mystery {
  return {
    id: row.id,
    arc: row.arc,
    title: row.title,
    premise: row.premise,
    state: row.state,
    clues: JSON.parse(row.clues) as MysteryClue[],
    resolution: row.resolution,
    createdTs: row.created_ts,
  };
}

// ---------------------------------------------------------------------------
// entries
// ---------------------------------------------------------------------------

export async function insertEntry(db: D1Database, entry: Entry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO entries (id, ts, type, resident_ids, location, title, content, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      entry.id,
      entry.ts,
      entry.type,
      JSON.stringify(entry.residentIds),
      entry.location,
      entry.title,
      entry.content,
      entry.status,
    )
    .run();
}

export async function getEntry(db: D1Database, id: string): Promise<Entry | null> {
  const row = await db.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first<EntryRow>();
  return row ? rowToEntry(row) : null;
}

export interface ListEntriesOptions {
  limit?: number;
  /** keyset 分页游标：返回 (ts, id) 严格小于游标的下一页 */
  beforeTs?: number;
  beforeId?: string;
  residentId?: string;
  status?: EntryStatus | 'all';
}

export async function listEntries(db: D1Database, opts: ListEntriesOptions = {}): Promise<Entry[]> {
  const limit = Math.min(opts.limit ?? 20, 50);
  const status = opts.status ?? 'published';

  const where: string[] = [];
  const params: unknown[] = [];

  if (status !== 'all') {
    where.push('status = ?');
    params.push(status);
  }
  if (opts.residentId !== undefined) {
    // resident_ids 为 JSON 数组文本，规模小，LIKE 足够
    where.push("resident_ids LIKE ?");
    params.push(`%"${opts.residentId}"%`);
  }
  if (opts.beforeTs !== undefined && opts.beforeId !== undefined) {
    where.push('(ts < ? OR (ts = ? AND id < ?))');
    params.push(opts.beforeTs, opts.beforeTs, opts.beforeId);
  }

  const sql = `SELECT * FROM entries
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ts DESC, id DESC
    LIMIT ?`;
  params.push(limit + 1); // 多取一条用于调用方判断是否有下一页

  const { results } = await db.prepare(sql).bind(...params).all<EntryRow>();
  return results.map(rowToEntry).slice(0, limit);
}

export async function setEntryStatus(
  db: D1Database,
  id: string,
  status: EntryStatus,
): Promise<boolean> {
  const res = await db.prepare('UPDATE entries SET status = ? WHERE id = ?').bind(status, id).run();
  return (res.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// memories
// ---------------------------------------------------------------------------

export interface InsertMemoryInput {
  residentId: string;
  ts: number;
  kind: MemoryKind;
  content: string;
  salience: number;
  tags: string;
  subject?: string | null;
}

export async function insertMemory(db: D1Database, input: InsertMemoryInput): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO memories (resident_id, ts, kind, content, salience, tags, subject)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.residentId,
      input.ts,
      input.kind,
      input.content,
      input.salience,
      input.tags,
      input.subject ?? null,
    )
    .run();
  return Number(res.meta.last_row_id);
}

export async function recentMemories(
  db: D1Database,
  residentId: string,
  limit: number,
): Promise<MemoryEntry[]> {
  const { results } = await db
    .prepare('SELECT * FROM memories WHERE resident_id = ? ORDER BY ts DESC, id DESC LIMIT ?')
    .bind(residentId, limit)
    .all<MemoryRow>();
  return results.map(rowToMemory);
}

/** 未参与过反思的记忆（按时间倒序），供 maybeReflect 累计显著度 */
export async function unreflectedMemories(
  db: D1Database,
  residentId: string,
  limit: number,
): Promise<MemoryEntry[]> {
  const { results } = await db
    .prepare(
      'SELECT * FROM memories WHERE resident_id = ? AND reflected = 0 ORDER BY ts DESC, id DESC LIMIT ?',
    )
    .bind(residentId, limit)
    .all<MemoryRow>();
  return results.map(rowToMemory);
}

export async function markReflected(db: D1Database, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await db
    .prepare(`UPDATE memories SET reflected = 1 WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run();
}

/**
 * FTS5 关键词检索。query 为 FTS5 MATCH 语法（空格分隔关键词 = AND）。
 * 中文分词不可靠，关键词体系依赖 memories.tags（LLM 抽取、空格分隔）。
 */
export async function searchMemoriesFts(
  db: D1Database,
  residentId: string,
  query: string,
  limit: number,
): Promise<MemoryEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT m.* FROM memories_fts f
       JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ? AND m.resident_id = ?
       ORDER BY rank
       LIMIT ?`,
    )
    .bind(query, residentId, limit)
    .all<MemoryRow>();
  return results.map(rowToMemory);
}

// ---------------------------------------------------------------------------
// mysteries
// ---------------------------------------------------------------------------

export async function upsertMystery(db: D1Database, mystery: Mystery): Promise<void> {
  await db
    .prepare(
      `INSERT INTO mysteries (id, arc, title, premise, state, clues, resolution, created_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         state = excluded.state,
         clues = excluded.clues`,
    )
    .bind(
      mystery.id,
      mystery.arc,
      mystery.title,
      mystery.premise,
      mystery.state,
      JSON.stringify(mystery.clues),
      mystery.resolution,
      mystery.createdTs,
    )
    .run();
}

export async function getMystery(db: D1Database, id: string): Promise<Mystery | null> {
  const row = await db.prepare('SELECT * FROM mysteries WHERE id = ?').bind(id).first<MysteryRow>();
  return row ? rowToMystery(row) : null;
}

export async function listMysteries(db: D1Database, state?: MysteryState): Promise<Mystery[]> {
  if (state !== undefined) {
    const { results } = await db
      .prepare('SELECT * FROM mysteries WHERE state = ? ORDER BY created_ts')
      .bind(state)
      .all<MysteryRow>();
    return results.map(rowToMystery);
  }
  const { results } = await db
    .prepare('SELECT * FROM mysteries ORDER BY created_ts')
    .all<MysteryRow>();
  return results.map(rowToMystery);
}

// ---------------------------------------------------------------------------
// usage_records
// ---------------------------------------------------------------------------

export async function insertUsage(db: D1Database, input: UsageRecordInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage_records (ts, purpose, tier, model, tokens_in, tokens_out, est_cost)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(input.ts, input.purpose, input.tier, input.model, input.tokensIn, input.tokensOut, input.estCost)
    .run();
}

/** 按天聚合用量。[dayStartTs, dayEndTs) 左闭右开 */
export async function usageByDay(
  db: D1Database,
  dayStartTs: number,
  dayEndTs: number,
): Promise<UsageSummaryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT purpose, tier, model,
              COUNT(*) AS calls,
              SUM(tokens_in) AS tokens_in,
              SUM(tokens_out) AS tokens_out,
              SUM(est_cost) AS est_cost
       FROM usage_records
       WHERE ts >= ? AND ts < ?
       GROUP BY purpose, tier, model
       ORDER BY est_cost DESC`,
    )
    .bind(dayStartTs, dayEndTs)
    .all<{
      purpose: string;
      tier: string;
      model: string;
      calls: number;
      tokens_in: number;
      tokens_out: number;
      est_cost: number;
    }>();
  return results.map((r) => ({
    purpose: r.purpose,
    tier: r.tier,
    model: r.model,
    calls: r.calls,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    estCost: r.est_cost,
  }));
}

// ---------------------------------------------------------------------------
// moderation_log
// ---------------------------------------------------------------------------

export async function insertModerationLog(
  db: D1Database,
  input: { ts: number; targetType: string; targetId: string | null; action: string; reason: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO moderation_log (ts, target_type, target_id, action, reason)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(input.ts, input.targetType, input.targetId, input.action, input.reason)
    .run();
}

// ---------------------------------------------------------------------------
// tick_log
// ---------------------------------------------------------------------------

export interface TickLogInput {
  ts: number;
  slept: boolean;
  entriesPublished: number;
  durationMs: number;
  error?: string | null;
}

export async function insertTickLog(db: D1Database, input: TickLogInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tick_log (ts, slept, entries_published, duration_ms, error)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(input.ts, input.slept ? 1 : 0, input.entriesPublished, input.durationMs, input.error ?? null)
    .run();
}

export interface TickLogRow {
  id: number;
  ts: number;
  slept: boolean;
  entriesPublished: number;
  durationMs: number;
  error: string | null;
}

export async function recentTickLog(db: D1Database, limit: number): Promise<TickLogRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, ts, slept, entries_published AS entriesPublished,
              duration_ms AS durationMs, error
       FROM tick_log ORDER BY ts DESC LIMIT ?`,
    )
    .bind(limit)
    .all<{
      id: number;
      ts: number;
      slept: number;
      entriesPublished: number;
      durationMs: number;
      error: string | null;
    }>();
  return results.map((r) => ({ ...r, slept: r.slept === 1 }));
}

// ---------------------------------------------------------------------------
// world_snapshots
// ---------------------------------------------------------------------------

export async function saveSnapshot(db: D1Database, ts: number, state: unknown): Promise<void> {
  await db
    .prepare(
      `INSERT INTO world_snapshots (id, ts, state) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET ts = excluded.ts, state = excluded.state`,
    )
    .bind(ts, JSON.stringify(state))
    .run();
}

export async function loadSnapshot(db: D1Database): Promise<WorldSnapshot | null> {
  const row = await db
    .prepare('SELECT ts, state FROM world_snapshots WHERE id = 1')
    .first<{ ts: number; state: string }>();
  return row ? { ts: row.ts, state: JSON.parse(row.state) } : null;
}
