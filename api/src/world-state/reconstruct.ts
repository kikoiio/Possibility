/** 历史可重建性判定与时刻重建(S4/F6)。
 * 路径选择:有 ≤V 锚点走「锚点核心 + 迷你回放 + 活表水位 + 逆放」;无锚点退化为
 * 全量 reduceProjection 回放。分叉线的继承历史由其不可变分叉快照冻结,免疫 legacy
 * NULL 桶直删;主线存在 NULL 桶则历史分叉整体不可用(旧直删不可追溯,诚实拒绝)。
 */
import { and, desc, eq, inArray, isNull, lte } from 'drizzle-orm'
import type { Db } from '../db/client'
import { memories, timelines, universeEvidence, universeRevisions, worldFacts, worldModelVersions, worldPersons } from '../db/schema'
import { hydrateTimelines } from '../life/snapshot-store'
import { firstAnchor } from './anchors'
import { resolveProjectionBaseline } from './evidence'
import { PROJECTION_DOMAINS, type ProjectionBaseline } from './model'

export type HistoryRejectCode =
  | 'future_time' | 'before_history_start' | 'baseline_incomplete'
  | 'replay_diagnostics' | 'integrity_mismatch' | 'timeline_not_active'

export const HISTORY_REJECT_MESSAGES: Record<HistoryRejectCode, string> = {
  future_time: '该时刻尚未发生，请以当前或过去时刻分叉',
  before_history_start: '该时刻早于这条线可回溯的起点',
  baseline_incomplete: '该时刻的历史证据不完整，无法完整重建',
  replay_diagnostics: '历史命令回放校验失败，无法完整重建',
  integrity_mismatch: '历史完整性校验失败，无法完整重建',
  timeline_not_active: '只能分叉活跃时间线',
}

export interface HistoryReject { ok: false; reasonCode: HistoryRejectCode; message: string }
export interface MomentOk { ok: true; effectiveMoment: string }
export type MomentCheck = MomentOk | HistoryReject

const reject = (reasonCode: HistoryRejectCode): HistoryReject => ({ ok: false, reasonCode, message: HISTORY_REJECT_MESSAGES[reasonCode] })

interface TimelineContext {
  timeline: typeof timelines.$inferSelect
  baseline: ProjectionBaseline | null
  /** 主线可见 legacy NULL 记忆桶(分叉线的继承历史冻结在快照里,不受影响) */
  rootHasNullBucket: boolean
}

async function loadContext(db: Db, worldId: string, timelineId: string): Promise<TimelineContext | null> {
  const rows = await db.select().from(timelines).where(and(eq(timelines.id, timelineId), eq(timelines.worldId, worldId)))
  const timeline = (await hydrateTimelines(db, rows))[0]
  if (!timeline) return null
  const [revision, evidenceRecord, modelRows] = await db.batch([
    db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timelineId)),
    db.select().from(universeEvidence).where(eq(universeEvidence.timelineId, timelineId)),
    db.select().from(worldModelVersions).where(eq(worldModelVersions.worldId, worldId)),
  ])
  const baseline = resolveProjectionBaseline(timeline, revision[0] ?? null, evidenceRecord[0] ?? null, modelRows)
  let rootHasNullBucket = false
  if (!timeline.parentTimelineId) {
    const nullRows = await db.select({ id: memories.id }).from(memories).where(and(
      isNull(memories.timelineId),
      inArray(memories.personId, db.select({ id: worldPersons.personId }).from(worldPersons).where(eq(worldPersons.worldId, worldId))),
    )).limit(1)
    rootHasNullBucket = nullRows.length > 0
  }
  return { timeline, baseline, rootHasNullBucket }
}

function baselineComplete(baseline: ProjectionBaseline | null): baseline is ProjectionBaseline {
  return baseline !== null && PROJECTION_DOMAINS.every((domain) => baseline.completeDomains.includes(domain))
}

/** 版本定位:最后一条 simTime ≤ at 的事实版本;无时为 0(基线时刻)。 */
export async function versionAtTime(db: Db, timelineId: string, at: string): Promise<{ version: number; simTime: string } | null> {
  const row = await db.select({ version: worldFacts.version, simTime: worldFacts.simTime }).from(worldFacts)
    .where(and(eq(worldFacts.timelineId, timelineId), lte(worldFacts.simTime, at)))
    .orderBy(desc(worldFacts.version)).limit(1).get()
  return row ?? null
}

/** 最早可回溯时刻:基线全覆盖 → 日志起点;否则首个锚点;主线 NULL 桶 → null。 */
export async function historyRange(db: Db, worldId: string, timelineId: string): Promise<{ earliest: string | null; simNow: string } | null> {
  const ctx = await loadContext(db, worldId, timelineId)
  if (!ctx) return null
  let earliest: string | null = null
  if (ctx.rootHasNullBucket) {
    earliest = null
  } else if (baselineComplete(ctx.baseline)) {
    earliest = ctx.baseline.simTime
  } else {
    earliest = (await firstAnchor(db, timelineId))?.simTime ?? null
  }
  return { earliest, simNow: ctx.timeline.simNow }
}

/** 单点判定(轻量,不做全量重建):可 → 吸附后的有效时刻;不可 → 原因码+文案。 */
export async function checkMoment(db: Db, worldId: string, timelineId: string, at: string): Promise<MomentCheck> {
  const ctx = await loadContext(db, worldId, timelineId)
  if (!ctx || ctx.timeline.status !== 'active') return reject('timeline_not_active')
  if (!Number.isFinite(Date.parse(at))) return reject('before_history_start')
  const simNow = ctx.timeline.simNow
  if (Date.parse(at) > Date.parse(simNow)) return reject('future_time')
  if (Date.parse(at) === Date.parse(simNow)) return { ok: true, effectiveMoment: simNow }
  const range = await historyRange(db, worldId, timelineId)
  if (!range?.earliest || Date.parse(at) < Date.parse(range.earliest)) return reject('before_history_start')
  const located = await versionAtTime(db, timelineId, at)
  if (!located) {
    // 基线时刻本身(分叉线的分叉时刻/主线的创建时刻)
    return ctx.baseline && Date.parse(at) >= Date.parse(ctx.baseline.simTime)
      ? { ok: true, effectiveMoment: ctx.baseline.simTime }
      : reject('before_history_start')
  }
  return { ok: true, effectiveMoment: located.simTime }
}
