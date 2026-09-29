import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { memories, memoryAccess, timelines, worldPersons } from '../db/schema'
import { readForkSnapshot, selectVisibleMemories, visibilityBuckets, type MemoryBucket } from './visibility'
import { DEFAULT_RETRIEVAL_CONFIG, type RetrievalConfig } from './retrieval-config'

type Timeline = typeof timelines.$inferSelect
export type Memory = typeof memories.$inferSelect

/** 压缩参数（S2 依赖,保持不变） */
export const SUMMARY_THRESHOLD = 40
export const SUMMARY_BATCH = 30

export function parseAncestorIds(timeline: Timeline): string[] {
  try {
    const v = JSON.parse(timeline.ancestorIdsJson || '[]') as unknown
    return Array.isArray(v) ? v.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

async function mainTimelineOf(db: Db, worldId: string): Promise<Timeline | null> {
  const row = await db
    .select()
    .from(timelines)
    .where(and(eq(timelines.worldId, worldId), isNull(timelines.parentTimelineId)))
    .get()
  return row ?? null
}

/**
 * 记忆可见性（D7）：
 * 可见 = 本线自身全部条目 ∪（祖先链各线 ∪ 主线桶 NULL）中 createdAt ≤ 本线创建时刻的条目。
 * 阶段一遗留约定：主线记忆写 NULL 桶，因此 NULL 桶视为「主线」的别名——
 * 主线自身查询时 NULL 全部可见；分叉仅当主线在其祖先链中时可见 NULL 桶（同样限分叉点之前）。
 */
export async function visibleMemories(db: Db, personId: string, timeline: Timeline): Promise<Memory[]> {
  const memberships = await db.select({ worldId: worldPersons.worldId }).from(worldPersons)
    .where(eq(worldPersons.personId, personId)).all()
  const sharedAcrossWorlds = new Set(memberships.map(m => m.worldId)).size > 1
  const snapshot = readForkSnapshot(timeline)
  const worldTimelines = snapshot ? [timeline]
    : await db.select().from(timelines).where(eq(timelines.worldId, timeline.worldId)).all()
  const rows = await db.select().from(memories).where(and(
    eq(memories.personId, personId),
    snapshot ? eq(memories.timelineId, timeline.id)
      : or(isNull(memories.timelineId), inArray(memories.timelineId, worldTimelines.map((t) => t.id))),
  )).all()
  const visible = selectVisibleMemories(rows, personId, timeline, worldTimelines)
  // A legacy NULL bucket cannot be attributed to a particular world once an asset is reused.
  // Keep it readable in the old data, but do not feed it into another universe's decisions.
  return sharedAcrossWorlds ? visible.filter(m => m.timelineId !== null) : visible
}

/**
 * 决策点上下文检索（S1，取代 D8 的"近 12 ∪ 重要 8"）：
 * 选中集 = 最近 recentFloor 条(保底) ∪ 打分 top-K ∪ 最新 summaryK 条摘要,
 * 去重后按虚拟时间升序。打分 = w1·新近度衰减 + w2·重要性 + w3·情境匹配;
 * 候选四路 SQL 限量(新近/重要性/人物提及/带标注),snapshot 分叉走
 * 「冻结证据 + 本线 SQL」双源;选中集顺带写排练簿记(memory_access)。
 */
export interface Situation {
  presentPersonIds: string[]
  presentPersonNames: string[]
  locationName: string | null
  situationText: string
}

export const EMPTY_SITUATION: Situation = { presentPersonIds: [], presentPersonNames: [], locationName: null, situationText: '' }

/** 与 engine-context 的关系记忆匹配同一约定：去空白全名 + 前两字 */
export function nameKeys(name: string): string[] {
  const norm = name.replace(/\s+/g, '')
  return norm.length > 2 ? [norm, norm.slice(0, 2)] : [norm]
}

function parseStringArray(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
  } catch {
    return []
  }
}

/** 情境匹配分：在场人物 1.0 + 地点 0.6 + 主题词 0.4;无标注旧记忆走姓名/地点子串回退(F2) */
export function situationalScore(m: Memory, situation: Situation): number {
  let score = 0
  const personHit = m.mentionedPersonIdsJson != null
    ? parseStringArray(m.mentionedPersonIdsJson).some((id) => situation.presentPersonIds.includes(id))
    : situation.presentPersonNames.some((n) => nameKeys(n).some((k) => k && m.content.includes(k)))
  if (personHit) score += 1
  const locationHit = m.locationName != null
    ? situation.locationName !== null && m.locationName === situation.locationName
    : situation.locationName !== null && situation.locationName.length > 1 && m.content.includes(situation.locationName)
  if (locationHit) score += 0.6
  if (parseStringArray(m.topicsJson).some((t) => situation.situationText.includes(t))) score += 0.4
  return score
}

function bucketSetCondition(buckets: MemoryBucket[]) {
  return or(...buckets.map((b) => {
    const idCond = b.timelineId === null ? isNull(memories.timelineId) : eq(memories.timelineId, b.timelineId)
    return b.createdAtLte ? and(idCond, lte(memories.createdAt, b.createdAtLte))! : idCond
  }))
}

/** 四路限量候选:新近 / 重要性 / 人物提及 / 带标注(地点或主题) */
async function candidateMemories(db: Db, personId: string, buckets: MemoryBucket[], situation: Situation, config: RetrievalConfig): Promise<Memory[]> {
  const base = and(eq(memories.personId, personId), bucketSetCondition(buckets), eq(memories.summarized, false))
  const routes: Promise<Memory[]>[] = [
    db.select().from(memories).where(base).orderBy(desc(memories.createdAt)).limit(config.candidateRecent).all(),
    db.select().from(memories).where(base).orderBy(desc(memories.importance), desc(memories.createdAt)).limit(config.candidateImportant).all(),
  ]
  if (situation.presentPersonIds.length) {
    const ids = sql.join(situation.presentPersonIds.map((id) => sql`${id}`), sql`, `)
    routes.push(db.select().from(memories).where(and(base,
      sql`EXISTS (SELECT 1 FROM json_each(${memories.mentionedPersonIdsJson}) WHERE value IN (${ids}))`))
      .orderBy(desc(memories.createdAt)).limit(config.candidateMentions).all())
  }
  const annotatedCond = situation.locationName
    ? or(eq(memories.locationName, situation.locationName), isNotNull(memories.topicsJson))
    : isNotNull(memories.topicsJson)
  routes.push(db.select().from(memories).where(and(base, annotatedCond))
    .orderBy(desc(memories.createdAt)).limit(config.candidateAnnotated).all())

  const pool = new Map<string, Memory>()
  for (const rows of await Promise.all(routes)) for (const m of rows) pool.set(m.id, m)
  return [...pool.values()]
}

function scoreMemory(m: Memory, simNow: string, access: Map<string, string>, situation: Situation, config: RetrievalConfig): number {
  const basis = [m.simTime, access.get(m.id)].filter((x): x is string => typeof x === 'string' && x.length > 0)
    .sort().pop() ?? m.createdAt
  const ageMs = Date.parse(simNow) - Date.parse(basis)
  const ageHours = Number.isFinite(ageMs) ? Math.max(0, ageMs) / 3.6e6 : 0
  return config.w1 * Math.exp(-ageHours / config.halfLifeHours)
    + config.w2 * (m.importance / 10)
    + config.w3 * situationalScore(m, situation)
}

/** 排练簿记(F4):刷新新近度时钟并累加被检索次数;非世界状态,引擎簿记 */
export async function recordAccess(db: Db, memoryIds: string[], simNow: string): Promise<void> {
  if (!memoryIds.length) return
  await db.insert(memoryAccess)
    .values(memoryIds.map((id) => ({ memoryId: id, lastAccessedSimAt: simNow, accessCount: 1 })))
    .onConflictDoUpdate({ target: memoryAccess.memoryId,
      set: { lastAccessedSimAt: simNow, accessCount: sql`${memoryAccess.accessCount} + 1` } })
}

export async function retrieveForPrompt(db: Db, personId: string, timeline: Timeline,
  situation: Situation = EMPTY_SITUATION, config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG): Promise<Memory[]> {
  const memberships = await db.select({ worldId: worldPersons.worldId }).from(worldPersons)
    .where(eq(worldPersons.personId, personId)).all()
  const sharedAcrossWorlds = new Set(memberships.map((m) => m.worldId)).size > 1

  const snapshot = readForkSnapshot(timeline)
  let pool: Memory[]
  if (snapshot) {
    // 双源(D6):冻结证据(应用侧)+ 本线 SQL 候选
    const own = await candidateMemories(db, personId, [{ timelineId: timeline.id }], situation, config)
    const frozen = snapshot.memories
      .filter((m) => m.personId === personId && !m.summarized && (!sharedAcrossWorlds || m.timelineId !== null))
      .map((m) => ({ ...m, mentionedPersonIdsJson: m.mentionedPersonIdsJson ?? null,
        locationName: m.locationName ?? null, topicsJson: m.topicsJson ?? null }))
    const merged = new Map<string, Memory>()
    for (const m of [...frozen, ...own]) merged.set(m.id, m)
    pool = [...merged.values()]
  } else {
    const worldTimelines = await db.select().from(timelines).where(eq(timelines.worldId, timeline.worldId)).all()
    const buckets = visibilityBuckets(timeline, worldTimelines, sharedAcrossWorlds)
    pool = buckets ? await candidateMemories(db, personId, buckets, situation, config) : []
  }

  const byCreatedDesc = [...pool].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const picked = new Map<string, Memory>()
  for (const m of byCreatedDesc.slice(0, config.recentFloor)) picked.set(m.id, m)

  const accessRows = pool.length
    ? await db.select().from(memoryAccess).where(inArray(memoryAccess.memoryId, pool.map((m) => m.id))).all() : []
  const access = new Map(accessRows.map((r) => [r.memoryId, r.lastAccessedSimAt]))
  const scored = pool.map((m) => ({ m, score: scoreMemory(m, timeline.simNow, access, situation, config) }))
    .sort((a, b) => b.score - a.score || b.m.createdAt.localeCompare(a.m.createdAt))
  for (const { m } of scored.slice(0, config.topK)) picked.set(m.id, m)
  for (const m of byCreatedDesc.filter((x) => x.type === 'summary').slice(0, config.summaryK)) picked.set(m.id, m)

  const simKey = (m: Memory) => m.simTime ?? m.createdAt
  const selected = [...picked.values()].sort((a, b) => simKey(a).localeCompare(simKey(b)))
  await recordAccess(db, selected.map((m) => m.id), timeline.simNow)
  return selected
}

/** 桶条件：主线桶 = NULL ∪ 主线 id；分叉桶 = 自身 id（压缩按桶隔离，不跨线污染） */
function bucketCondition(timeline: Timeline, main: Timeline | null) {
  const isMainLine = main !== null && main.id === timeline.id
  if (isMainLine) {
    return or(isNull(memories.timelineId), eq(memories.timelineId, timeline.id))
  }
  return eq(memories.timelineId, timeline.id)
}

/** 未压缩记忆是否超过阈值（阈值可由调用方按 env 覆盖） */
export async function needsSummary(
  db: Db,
  personId: string,
  timeline: Timeline,
  threshold: number = SUMMARY_THRESHOLD,
): Promise<boolean> {
  const main = await mainTimelineOf(db, timeline.worldId)
  const rows = await db
    .select({ id: memories.id })
    .from(memories)
    .where(
      and(
        eq(memories.personId, personId),
        bucketCondition(timeline, main),
        eq(memories.summarized, false),
        ne(memories.type, 'summary'),
      ),
    )
    .limit(threshold + 1)
    .all()
  return rows.length > threshold
}

/** 最老的 n 条待压缩记忆（同桶、未压缩、非摘要），按写入时间升序 */
export async function oldestUnsummarized(
  db: Db,
  personId: string,
  timeline: Timeline,
  n: number = SUMMARY_BATCH,
): Promise<Memory[]> {
  const main = await mainTimelineOf(db, timeline.worldId)
  return db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.personId, personId),
        bucketCondition(timeline, main),
        eq(memories.summarized, false),
        ne(memories.type, 'summary'),
      ),
    )
    .orderBy(asc(memories.createdAt))
    .limit(n)
    .all()
}

/** 重要性评分钳制到 1-10（缺省 5） */
export function clampImportance(v: unknown): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return 5
  return Math.min(Math.max(n, 1), 10)
}
