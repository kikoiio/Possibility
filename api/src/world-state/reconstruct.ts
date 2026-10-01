/** 历史可重建性判定与时刻重建(S4/F6)。
 * 路径选择:有 ≤V 锚点走「锚点核心 + 迷你回放 + 活表水位 + 逆放」;无锚点退化为
 * 全量 reduceProjection 回放。分叉线的继承历史由其不可变分叉快照冻结,免疫 legacy
 * NULL 桶直删;主线存在 NULL 桶则历史分叉整体不可用(旧直删不可追溯,诚实拒绝)。
 */
import { and, asc, desc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  commitments, dialogueTurns, dialogues, events, memories, personaMessages, personStates, schedules,
  timelines, universeEvidence, universeRevisions, voxelEventProjections, worldCommands, worldFacts, worldModelVersions, worldPersons,
} from '../db/schema'
import { hydrateTimelines } from '../life/snapshot-store'
import { readForkSnapshot } from '../agent/visibility'
import { hashAnchorCore, latestAnchorAtOrBefore, parseAnchorCore } from './anchors'
import { applyCoreCommands } from './core-replay'
import { resolveProjectionBaseline, collectReplayInput } from './evidence'
import { reduceProjection } from './projector'
import { PROJECTION_DOMAINS, type ProjectionBaseline, type ProjectionDomain } from './model'

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
  // 锚点只封顶回放成本,不构成完整性证据——无完整基线的线不做历史分叉
  const earliest = !ctx.rootHasNullBucket && baselineComplete(ctx.baseline) ? ctx.baseline.simTime : null
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
  if (ctx.rootHasNullBucket || !baselineComplete(ctx.baseline)) return reject('baseline_incomplete')
  const earliest = ctx.baseline.simTime
  if (Date.parse(at) < Date.parse(earliest)) return reject('before_history_start')
  const located = await versionAtTime(db, timelineId, at)
  if (!located) {
    // 基线时刻本身(分叉线的分叉时刻/主线的创建时刻)
    return Date.parse(at) >= Date.parse(earliest) ? { ok: true, effectiveMoment: earliest } : reject('before_history_start')
  }
  return { ok: true, effectiveMoment: located.simTime }
}

/* ---------- T6: 时刻重建 ---------- */

export interface ReconstructionEvidence {
  source: 'anchor_replay' | 'full_replay'
  throughVersion: number
  anchorVersion: number | null
  completeDomains: ProjectionDomain[]
  coreHash: string
  invertedMaintenance: number
}

export interface ReconstructionRows {
  states: (typeof personStates.$inferSelect)[]
  schedules: (typeof schedules.$inferSelect)[]
  commitments: (typeof commitments.$inferSelect)[]
  memories: (typeof memories.$inferSelect)[]
  events: (typeof events.$inferSelect)[]
  dialogues: (typeof dialogues.$inferSelect)[]
  dialogueTurns: (typeof dialogueTurns.$inferSelect)[]
  personaMessages: (typeof personaMessages.$inferSelect)[]
  worldFacts: (typeof worldFacts.$inferSelect)[]
  /** S4 世界模拟:体素事件投影(派生数据,版本水位过滤同六表;分叉时物化给子线) */
  voxelEvents: (typeof voxelEventProjections.$inferSelect)[]
}

export interface Reconstruction {
  ok: true
  simTime: string
  rows: ReconstructionRows
  evidence: ReconstructionEvidence
}
export type ReconstructResult = Reconstruction | HistoryReject

type MemoryRow = typeof memories.$inferSelect

/** 逆放 V 之后的记忆维护命令:correct 恢复 before、forget 重新插入 before、summary 复位 summarized。
 * 按版本倒序(先撤销最新)。负载形状与 rules.ts 校验一致:before 只含
 * {type, content, importance, simTime, createdAt, summarized},行标识在 action.memoryId/personId。
 * 任何结构性不符即 integrity_mismatch——不猜、不冒充。 */
function invertMaintenance(
  assembled: MemoryRow[], commands: (typeof worldCommands.$inferSelect)[], timelineId: string, simTime: string,
): { inverted: number } | HistoryReject {
  let inverted = 0
  for (const command of [...commands].reverse()) {
    let action: Record<string, unknown> | null = null
    try {
      const parsed = JSON.parse(command.payloadJson) as unknown
      action = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
    } catch { /* fallthrough: action null → mismatch */ }
    if (!action) return reject('integrity_mismatch')
    if (action.type === 'memory_summary') {
      const sourceIds = Array.isArray(action.sourceMemoryIds)
        ? action.sourceMemoryIds.filter((id): id is string => typeof id === 'string') : null
      if (!sourceIds) return reject('integrity_mismatch')
      for (const id of sourceIds) {
        const row = assembled.find((memory) => memory.id === id)
        if (row) row.summarized = false
      }
      inverted += 1
      continue
    }
    const memoryId = typeof action.memoryId === 'string' ? action.memoryId : null
    const personId = typeof action.personId === 'string' ? action.personId : null
    const before = action.before && typeof action.before === 'object' && !Array.isArray(action.before)
      ? action.before as Record<string, unknown> : null
    if (!memoryId || !personId || !before
      || typeof before.type !== 'string' || typeof before.content !== 'string'
      || typeof before.importance !== 'number' || typeof before.createdAt !== 'string'
      || (before.simTime !== null && typeof before.simTime !== 'string')) return reject('integrity_mismatch')
    // 只关心在 T 时刻已存在(或本应存在)的行
    if (typeof before.simTime === 'string' && Date.parse(before.simTime) > Date.parse(simTime)) continue
    const index = assembled.findIndex((memory) => memory.id === memoryId)
    if (action.type === 'memory_correct') {
      const after = action.after && typeof action.after === 'object' && !Array.isArray(action.after)
        ? action.after as Record<string, unknown> : null
      if (!after || typeof after.content !== 'string' || typeof after.importance !== 'number') {
        return reject('integrity_mismatch')
      }
      if (index < 0) {
        // 活表水位下该行应可见却缺席 → 历史被非命令路径动过
        return reject('integrity_mismatch')
      }
      const current = assembled[index]
      // 监管链:现行行必须与命令记载的 after 完全一致(correct 只改 content/importance)
      if (current.content !== after.content || current.importance !== after.importance
        || current.type !== before.type || current.simTime !== before.simTime
        || current.createdAt !== before.createdAt || current.summarized !== before.summarized) {
        return reject('integrity_mismatch')
      }
      assembled[index] = { ...current, content: before.content, importance: before.importance }
      inverted += 1
      continue
    }
    if (action.type === 'memory_forget') {
      if (index >= 0) return reject('integrity_mismatch')
      assembled.push({
        id: memoryId, personId, timelineId,
        type: before.type, content: before.content,
        simTime: before.simTime as string | null,
        createdAt: before.createdAt, importance: before.importance,
        summarized: before.summarized === true,
        mentionedPersonIdsJson: null, locationName: null, topicsJson: null, level: null,
        createdVersion: null,
      })
      inverted += 1
      continue
    }
    return reject('integrity_mismatch')
  }
  return { inverted }
}

/** 重建时间线在时刻 at 的完整状态视图 + 证据;证据不足即拒绝,绝不产出残缺状态。 */
export async function reconstructAt(db: Db, worldId: string, timelineId: string, at: string): Promise<ReconstructResult> {
  const ctx = await loadContext(db, worldId, timelineId)
  if (!ctx || ctx.timeline.status !== 'active') return reject('timeline_not_active')
  if (!Number.isFinite(Date.parse(at))) return reject('before_history_start')
  if (Date.parse(at) > Date.parse(ctx.timeline.simNow)) return reject('future_time')
  if (ctx.rootHasNullBucket || !baselineComplete(ctx.baseline)) return reject('baseline_incomplete')
  const baseline = ctx.baseline
  if (Date.parse(at) < Date.parse(baseline.simTime)) return reject('before_history_start')
  const located = await versionAtTime(db, timelineId, at)
  const throughVersion = located?.version ?? 0
  const effectiveSimTime = located?.simTime ?? baseline.simTime

  const anchor = await latestAnchorAtOrBefore(db, timelineId, throughVersion)
  if (anchor) {
    const payload = parseAnchorCore(anchor.payloadJson)
    if (!payload) return reject('integrity_mismatch')
    const commands = await db.select().from(worldCommands).where(and(
      eq(worldCommands.timelineId, timelineId),
      gt(worldCommands.resultVersion, anchor.version), lte(worldCommands.resultVersion, throughVersion),
    )).orderBy(asc(worldCommands.resultVersion))
    const core = applyCoreCommands(payload, commands, anchor.simTime)
    // 历史域:分叉线的继承部分冻结在快照;本线部分 = 活表版本水位 ≤V + 逆放。
    // 用 created_version 而非 simTime:存在倒日期行(居民故事事件/摘要回填源时刻),
    // simTime 水位会把 V 之后创建的行漏进历史。NULL(部署前旧行)必早于首个锚点,安全纳入。
    const frozen = ctx.timeline.parentTimelineId ? readForkSnapshot(ctx.timeline) : null
    const [ownEvents, ownDialogues, ownMessages, ownMemories, ownFacts, ownVoxelEvents] = await db.batch([
      db.select().from(events).where(and(eq(events.timelineId, timelineId),
        or(isNull(events.createdVersion), lte(events.createdVersion, throughVersion)))),
      db.select().from(dialogues).where(and(eq(dialogues.timelineId, timelineId),
        or(isNull(dialogues.createdVersion), lte(dialogues.createdVersion, throughVersion)))),
      db.select().from(personaMessages).where(and(eq(personaMessages.timelineId, timelineId),
        or(isNull(personaMessages.createdVersion), lte(personaMessages.createdVersion, throughVersion)))),
      db.select().from(memories).where(and(eq(memories.timelineId, timelineId),
        or(isNull(memories.createdVersion), lte(memories.createdVersion, throughVersion)))),
      db.select().from(worldFacts).where(and(eq(worldFacts.timelineId, timelineId), lte(worldFacts.version, throughVersion))),
      // S4:投影表同六表水位纪律(派生数据,回放时随快照重建)
      db.select().from(voxelEventProjections).where(and(eq(voxelEventProjections.timelineId, timelineId),
        or(isNull(voxelEventProjections.createdVersion), lte(voxelEventProjections.createdVersion, throughVersion)))),
    ])
    const dialogueIds = new Set(ownDialogues.map((dialogue) => dialogue.id))
    const ownTurns = dialogueIds.size
      ? await db.select().from(dialogueTurns).where(and(
          inArray(dialogueTurns.dialogueId, [...dialogueIds]),
          or(isNull(dialogueTurns.createdVersion), lte(dialogueTurns.createdVersion, throughVersion))))
      : []
    const assembledMemories: MemoryRow[] = [...(frozen?.memories ?? []), ...ownMemories]
    const maintenance = await db.select().from(worldCommands).where(and(
      eq(worldCommands.timelineId, timelineId), gt(worldCommands.resultVersion, throughVersion),
      inArray(worldCommands.type, ['memory_correct', 'memory_forget', 'memory_summary']),
    )).orderBy(asc(worldCommands.resultVersion))
    const inverted = invertMaintenance(assembledMemories, maintenance, timelineId, effectiveSimTime)
    if ('ok' in inverted) return inverted
    assembledMemories.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    const sortedEvents = [...(frozen?.events ?? []), ...ownEvents]
      .sort((a, b) => a.simTime.localeCompare(b.simTime) || a.id.localeCompare(b.id))
    const coreHash = await hashAnchorCore({ version: 1, states: core.states, schedules: core.schedules, commitments: core.commitments })
    return {
      ok: true,
      simTime: effectiveSimTime,
      rows: {
        states: core.states, schedules: core.schedules, commitments: core.commitments,
        memories: assembledMemories, events: sortedEvents,
        dialogues: [...(frozen?.dialogues ?? []), ...ownDialogues],
        dialogueTurns: [...(frozen?.dialogueTurns ?? []), ...ownTurns],
        personaMessages: [...(frozen?.personaMessages ?? []), ...ownMessages],
        worldFacts: [...(frozen?.worldFacts ?? []), ...ownFacts],
        voxelEvents: ownVoxelEvents,
      },
      evidence: {
        source: 'anchor_replay', throughVersion, anchorVersion: anchor.version,
        completeDomains: [...baseline.completeDomains], coreHash, invertedMaintenance: inverted.inverted,
      },
    }
  }
  // 无锚点 → 全量回放兜底:从基线确定性回放至 V,按构造精确;任何诊断即拒绝
  const replayInput = await collectReplayInput(db, worldId, timelineId)
  if (!replayInput.baseline || !baselineComplete(replayInput.baseline)) return reject('baseline_incomplete')
  const replay = reduceProjection({
    worldId, timelineId, baseline: replayInput.baseline,
    commands: replayInput.commands.filter((command) => command.resultVersion <= throughVersion),
    facts: replayInput.facts.filter((fact) => fact.version <= throughVersion),
    throughVersion,
    personNames: replayInput.personNames,
    sourceFacts: replayInput.sourceFacts,
    visibleTimelineIds: replayInput.visibleTimelineIds,
  })
  if (!replay.ok || !replay.projection) return reject('replay_diagnostics')
  const projection = replay.projection
  const frozen = ctx.timeline.parentTimelineId ? readForkSnapshot(ctx.timeline) : null
  const memoriesSorted = [...projection.memories]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const eventsSorted = [...projection.events]
    .sort((a, b) => a.simTime.localeCompare(b.simTime) || a.id.localeCompare(b.id))
  const coreHash = await hashAnchorCore({ version: 1, states: projection.states, schedules: projection.schedules,
    commitments: projection.commitments })
  // S4:投影表非命令回放域,直接按活表版本水位取(与锚点路径同纪律)
  const ownVoxelEvents = await db.select().from(voxelEventProjections).where(and(
    eq(voxelEventProjections.timelineId, timelineId),
    or(isNull(voxelEventProjections.createdVersion), lte(voxelEventProjections.createdVersion, throughVersion)),
  )).all()
  return {
    ok: true,
    simTime: effectiveSimTime,
    rows: {
      states: projection.states, schedules: projection.schedules, commitments: projection.commitments,
      memories: memoriesSorted, events: eventsSorted,
      dialogues: projection.dialogues, dialogueTurns: projection.dialogueTurns,
      personaMessages: projection.personaMessages,
      worldFacts: [...(frozen?.worldFacts ?? []),
        ...replayInput.facts.filter((fact) => fact.version <= throughVersion)],
      voxelEvents: ownVoxelEvents,
    },
    evidence: {
      source: 'full_replay', throughVersion, anchorVersion: null,
      completeDomains: [...baseline.completeDomains], coreHash, invertedMaintenance: 0,
    },
  }
}
