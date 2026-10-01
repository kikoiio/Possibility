/** 日界核心锚点(S4/F6):每线每世界日捕获一份可变核心(状态/当日及未来日程/承诺)
 * + 命令版本水位 + 规范哈希。锚点只存可变核心;历史正文不可变且可推导,不冻结。
 * 捕获 best-effort:缺锚点只让重建退化为更早锚点或全量回放,正确性不依赖锚点存在。
 */
import { and, desc, eq, gte, lte } from 'drizzle-orm'
import type { Db } from '../db/client'
import { commitments, personStates, schedules, timelineAnchors, universeRevisions, type timelines } from '../db/schema'
import { stableValue } from './projector'

type Timeline = typeof timelines.$inferSelect
type Anchor = typeof timelineAnchors.$inferSelect

export interface AnchorCorePayload {
  version: 1
  states: (typeof personStates.$inferSelect)[]
  /** 仅当日及未来的日程;过去日日程不可变,重建时由活表水位提供 */
  schedules: (typeof schedules.$inferSelect)[]
  /** 全状态行(含已终结);分叉时按既有规则筛选 proposed/accepted */
  commitments: (typeof commitments.$inferSelect)[]
}

export function parseAnchorCore(raw: string): AnchorCorePayload | null {
  try {
    const value = JSON.parse(raw) as AnchorCorePayload
    return value?.version === 1 && Array.isArray(value.states) && Array.isArray(value.schedules)
      && Array.isArray(value.commitments) ? value : null
  } catch {
    return null
  }
}

export function hashAnchorCore(payload: AnchorCorePayload): Promise<string> {
  const canonical = stableValue({ states: payload.states, schedules: payload.schedules, commitments: payload.commitments })
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
    .then((digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''))
}

/** 日界捕获:同一 (timelineId, simDay) 撞键即已成功,幂等。 */
export async function captureDailyAnchor(db: Db, timeline: Timeline, now = new Date().toISOString()): Promise<Anchor | null> {
  const revision = await db.select().from(universeRevisions)
    .where(eq(universeRevisions.timelineId, timeline.id)).get()
  if (!revision) return null
  const simDay = timeline.simNow.slice(0, 10)
  const [states, scheduleRows, commitmentRows] = await db.batch([
    db.select().from(personStates).where(eq(personStates.timelineId, timeline.id)),
    db.select().from(schedules).where(and(eq(schedules.timelineId, timeline.id), gte(schedules.worldDate, simDay))),
    db.select().from(commitments).where(eq(commitments.timelineId, timeline.id)),
  ])
  const payload: AnchorCorePayload = { version: 1, states, schedules: scheduleRows, commitments: commitmentRows }
  const coreHash = await hashAnchorCore(payload)
  await db.insert(timelineAnchors).values({
    timelineId: timeline.id, simDay, version: revision.version, simTime: timeline.simNow,
    worldModelVersion: revision.worldModelVersion, coreHash, payloadJson: JSON.stringify(payload), createdAt: now,
  }).onConflictDoNothing()
  const stored = await db.select().from(timelineAnchors).where(and(
    eq(timelineAnchors.timelineId, timeline.id), eq(timelineAnchors.simDay, simDay),
  )).get()
  return stored ?? null
}

/** 重建选锚:版本水位 ≤ 目标版本的最新锚点。 */
export async function latestAnchorAtOrBefore(db: Db, timelineId: string, version: number): Promise<Anchor | null> {
  const row = await db.select().from(timelineAnchors).where(and(
    eq(timelineAnchors.timelineId, timelineId), lte(timelineAnchors.version, version),
  )).orderBy(desc(timelineAnchors.version)).limit(1).get()
  return row ?? null
}
