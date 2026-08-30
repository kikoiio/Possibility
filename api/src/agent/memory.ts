import { and, asc, eq, inArray, isNull, lte, ne, or } from 'drizzle-orm'
import type { Db } from '../db/client'
import { memories, timelines } from '../db/schema'

type Timeline = typeof timelines.$inferSelect
export type Memory = typeof memories.$inferSelect

/** 检索参数（D8：纯 SQL 新近度+重要性，不引入向量检索） */
export const RECENT_N = 12
export const TOP_IMPORTANT_K = 8
export const LATEST_SUMMARY_K = 2
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
  const main = await mainTimelineOf(db, timeline.worldId)
  const ancestors = parseAncestorIds(timeline)
  const isMainLine = main !== null && main.id === timeline.id

  if (isMainLine) {
    return db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.personId, personId),
          or(isNull(memories.timelineId), eq(memories.timelineId, timeline.id)),
        ),
      )
      .orderBy(asc(memories.createdAt))
      .all()
  }

  // 分叉：本线全部 + 祖先链（含 NULL 主线桶）限分叉点之前
  const ancestorConds = []
  if (ancestors.length) ancestorConds.push(inArray(memories.timelineId, ancestors))
  if (main && ancestors.includes(main.id)) ancestorConds.push(isNull(memories.timelineId))

  const branches = [eq(memories.timelineId, timeline.id)]
  if (ancestorConds.length) {
    branches.push(and(or(...ancestorConds), lte(memories.createdAt, timeline.createdAt))!)
  }
  return db
    .select()
    .from(memories)
    .where(and(eq(memories.personId, personId), or(...branches)))
    .orderBy(asc(memories.createdAt))
    .all()
}

/**
 * 决策点上下文检索（D8）：近期 RECENT_N 条 + 重要性 top TOP_IMPORTANT_K
 * + 最新 LATEST_SUMMARY_K 条摘要；排除 summarized，去重后按虚拟时间升序。
 */
export async function retrieveForPrompt(db: Db, personId: string, timeline: Timeline): Promise<Memory[]> {
  const visible = (await visibleMemories(db, personId, timeline)).filter((m) => !m.summarized)
  const byCreatedDesc = [...visible].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const picked = new Map<string, Memory>()
  for (const m of byCreatedDesc.slice(0, RECENT_N)) picked.set(m.id, m)
  const byImportance = [...visible].sort(
    (a, b) => b.importance - a.importance || b.createdAt.localeCompare(a.createdAt),
  )
  for (const m of byImportance.slice(0, TOP_IMPORTANT_K)) picked.set(m.id, m)
  for (const m of byCreatedDesc.filter((m) => m.type === 'summary').slice(0, LATEST_SUMMARY_K)) {
    picked.set(m.id, m)
  }

  const simKey = (m: Memory) => m.simTime ?? m.createdAt
  return [...picked.values()].sort((a, b) => simKey(a).localeCompare(simKey(b)))
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
