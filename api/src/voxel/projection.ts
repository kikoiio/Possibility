import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { dialogues, events, personStates, timelines, universeRevisions, voxelEventProjections, worlds } from '../db/schema'
import type { Env } from '../index'
import { ancestorCutoffs, readForkSnapshot, selectVisibleEvents, type Timeline } from '../agent/visibility'
import { hydrateTimelines } from '../life/snapshot-store'
import { readCurrentScene } from '../scenes/repository'
import { BudgetRefusal, worldReservation, type TickBudget } from '../engine/guard'
import type { BudgetConfig } from '../engine/budget'
import { llmConfigFor, type ResolvedLlmFields } from '../engine/steps/types'
import { completeContract } from '../llm/client'
import { LLM_CONTRACT_VERSIONS, parseContractObject, requireString } from '../llm/contracts'
import type { VoxelCoord, WorldEvent } from '@possibility/voxel-contract'
import { distillVoxelEvents, type DistilledVoxelEvent } from './distill'

/**
 * S4 世界模拟 · 蒸馏投影管线(DB 编排层)。
 * 每拍每线一次:可见 life 事件(selectVisibleEvents 水位过滤,分叉隔离天然继承)
 * → 纯函数蒸馏 → voxel_event_projections upsert;medium+ 事件文案门控 LLM
 * (purpose=voxel_distill,每世界每拍 ≤1 次,失败/触顶退模板,事件不丢)。
 */

type World = typeof worlds.$inferSelect

export interface VoxelProjectionPayload {
  event: WorldEvent
  sourceEventIds: string[]
  copySource: 'template' | 'llm'
}

export interface VoxelProjectionRun {
  projected: number
  /** 地点无法锚定跳过的源事件数(诊断) */
  skipped: number
  copyLlm: boolean
}

/** 蒸馏窗口:近 36 个世界时(更早的事件已成留痕,不重复投影) */
const WINDOW_MS = 36 * 60 * 60 * 1000

interface VoxelDocLike {
  locations?: { name: string; objectId: string }[]
  objects?: { id: string; anchor: VoxelCoord }[]
  assetPlacements?: { id?: string; anchor: [number, number, number] }[]
}

function isVoxelDoc(doc: unknown): doc is VoxelDocLike {
  return typeof doc === 'object' && doc !== null && 'size' in doc && 'objects' in doc
}

function locationResolver(doc: VoxelDocLike): (name: string) => VoxelCoord | null {
  const anchors = new Map((doc.objects ?? []).map(object => [object.id, object.anchor]))
  // S1 起地点可绑定资产摆放(GLB 建筑):锚点取摆放 anchor
  for (const placement of doc.assetPlacements ?? []) {
    if (placement.id) anchors.set(placement.id, { x: placement.anchor[0], y: placement.anchor[1], z: placement.anchor[2] })
  }
  const bindings = new Map((doc.locations ?? []).map(binding => [binding.name, binding.objectId]))
  return (name) => {
    const objectId = bindings.get(name)
    const anchor = objectId ? anchors.get(objectId) : null
    return anchor ? { x: anchor.x, y: anchor.y + 1, z: anchor.z } : null
  }
}

function parsePayload(raw: string): VoxelProjectionPayload | null {
  try {
    const value = JSON.parse(raw) as VoxelProjectionPayload
    return value && typeof value === 'object' && value.event && Array.isArray(value.sourceEventIds)
      && (value.copySource === 'template' || value.copySource === 'llm') ? value : null
  } catch {
    return null
  }
}

/** 体素事件披露文案(LLM,单事件单调用;输出三段,长度硬约束) */
async function generateEventCopy(
  env: Env,
  llm: ResolvedLlmFields,
  reserve: ReturnType<typeof worldReservation>,
  distilled: DistilledVoxelEvent,
): Promise<Pick<WorldEvent, 'label' | 'teaser' | 'scene'>> {
  const version = LLM_CONTRACT_VERSIONS.voxelDistill
  const config = llmConfigFor(env, llm, reserve)
  const event = distilled.event
  const user = [
    `事件类型:${event.type};重要度:${event.importance}`,
    `时间窗:${event.timeWindow.start} ~ ${event.timeWindow.end}`,
    event.participants?.length ? `在场人物数:${event.participants.length}` : null,
    '源事件摘录(每行一条,标题——描述):',
    event.scene.slice(0, 600),
  ].filter(line => line !== null).join('\n')
  return completeContract(
    config,
    [
      { role: 'system', content: '你是小镇生活的叙事编辑。根据给定素材,为体素世界地图上的一则生活事件写三段披露文案:label(地图标记短标题,2-4 个汉字)、teaser(一句话预告,≤30 字,克制不剧透结局)、scene(完整场景描述,≤150 字,白描,不添加素材中没有的人物或因果)。只返回 JSON:{"label":string,"teaser":string,"scene":string}。' },
      { role: 'user', content: user },
    ],
    {
      maxTokens: 2000,
      contractVersion: version,
      parse: (raw) => {
        const obj = parseContractObject(raw, version)
        return {
          label: requireString(obj.label, 'label', version, 12),
          teaser: requireString(obj.teaser, 'teaser', version, 60),
          scene: requireString(obj.scene, 'scene', version, 400),
        }
      },
    },
  )
}

/**
 * 单时间线蒸馏投影。返回 null = 世界无体素文档(2D 场景世界,管线不适用)。
 * 任何单线失败由调用方(tick)捕获,不阻塞整拍。
 */
export async function projectVoxelEvents(
  db: Db,
  env: Env,
  opts: {
    world: World
    /** 未水合的时间线行也可传入(内部统一水合) */
    timeline: Timeline
    cfg: BudgetConfig
    tickBudget: TickBudget
    llm: ResolvedLlmFields
    /** 本世界本拍文案 LLM 额度是否还在(每世界每拍 ≤1 次) */
    allowCopyLlm: boolean
  },
): Promise<VoxelProjectionRun | null> {
  const world = opts.world
  const stored = await readCurrentScene(db, world.id, { worldId: world.id, timelineId: opts.timeline.id, representation: 'voxel' }).catch(() => null)
  const doc: unknown = stored?.document
  if (!isVoxelDoc(doc)) return null

  const worldTimelineRows = await db.select().from(timelines).where(eq(timelines.worldId, world.id)).all()
  const worldTimelines = await hydrateTimelines(db, worldTimelineRows)
  const timeline = worldTimelines.find(t => t.id === opts.timeline.id)
  if (!timeline) return null

  // 可见性水位与 worldSnapshot 同源:本线 + 祖先链(快照分叉走冻结证据)
  const eventTimelineIds = new Set([timeline.id])
  if (!readForkSnapshot(timeline)) {
    for (const cutoff of ancestorCutoffs(timeline, worldTimelines)) eventTimelineIds.add(cutoff.timelineId)
  }
  const candidates = await db.select().from(events)
    .where(inArray(events.timelineId, [...eventTimelineIds]))
    .orderBy(asc(events.simTime))
    .all()
  const since = new Date(Date.parse(timeline.simNow) - WINDOW_MS).toISOString()
  const visible = selectVisibleEvents(candidates, timeline, worldTimelines).events
    .filter(event => event.simTime >= since && event.simTime <= timeline.simNow)
  if (visible.length === 0) return { projected: 0, skipped: 0, copyLlm: false }

  const dialogueIds = [...new Set(visible.map(event => event.dialogueId).filter((id): id is string => id !== null))]
  const dialogueRows = dialogueIds.length
    ? await db.select().from(dialogues).where(inArray(dialogues.id, dialogueIds)).all()
    : []
  const distillDialogues = dialogueRows.map(row => ({
    id: row.id,
    location: row.location,
    participantIds: (() => { try { return (JSON.parse(row.participantIdsJson) as unknown[]).map(String) } catch { return [] } })(),
  }))
  const stateRows = await db.select().from(personStates).where(eq(personStates.timelineId, timeline.id)).all()
  const locationOf = new Map(stateRows.map(state => [state.personId, state.location]))

  const { distilled, skipped } = distillVoxelEvents({
    events: visible,
    dialogues: distillDialogues,
    actorLocation: (personId) => locationOf.get(personId) ?? null,
    resolveLocation: locationResolver(doc),
  })

  // LLM 文案保留:源事件集未变且已有 llm 文案 → 沿用,不重复烧调用
  const existingRows = await db.select().from(voxelEventProjections)
    .where(eq(voxelEventProjections.timelineId, timeline.id)).all()
  const existingByKey = new Map<string, VoxelProjectionPayload>()
  for (const row of existingRows) {
    const payload = parsePayload(row.payloadJson)
    if (payload) existingByKey.set(row.id.slice(`vep:${timeline.id}:`.length), payload)
  }
  const revision = await db.select().from(universeRevisions)
    .where(eq(universeRevisions.timelineId, timeline.id)).get()
  const createdVersion = revision?.version ?? 0

  const payloads = distilled.map(d => {
    const prior = existingByKey.get(d.event.id)
    if (prior && prior.copySource === 'llm' && JSON.stringify(prior.sourceEventIds) === JSON.stringify(d.sourceEventIds)) {
      return prior
    }
    const payload: VoxelProjectionPayload = { event: d.event, sourceEventIds: d.sourceEventIds, copySource: 'template' }
    return payload
  })

  const writes = payloads.map((payload, index) => ({
    id: `vep:${timeline.id}:${distilled[index].event.id}`,
    timelineId: timeline.id,
    payloadJson: JSON.stringify(payload),
    createdVersion,
  }))
  for (let i = 0; i < writes.length; i += 50) {
    const chunk = writes.slice(i, i + 50)
    if (!chunk.length) break
    await db.insert(voxelEventProjections).values(chunk)
      .onConflictDoUpdate({ target: voxelEventProjections.id, set: {
        payloadJson: sql`excluded.payload_json`,
        createdVersion: sql`excluded.created_version`,
      } })
  }

  // 文案门控:medium+ 且仍是模板文案 → 每世界每拍至多 1 次 LLM;失败/触顶退模板,事件不丢
  let copyLlm = false
  if (opts.allowCopyLlm) {
    const rank = { high: 2, medium: 1, low: 0 }
    const pending = payloads
      .map((payload, index) => ({ payload, distilled: distilled[index] }))
      .filter(item => item.payload.copySource === 'template' && item.payload.event.importance !== 'low')
      .sort((a, b) => rank[b.payload.event.importance] - rank[a.payload.event.importance]
        || a.payload.event.timeWindow.start.localeCompare(b.payload.event.timeWindow.start))
    const top = pending[0]
    if (top) {
      const reserve = worldReservation(db, world.id, opts.cfg,
        { timelineId: timeline.id, personId: null, purpose: 'voxel_distill' }, opts.tickBudget)
      try {
        const copy = await generateEventCopy(env, opts.llm, reserve, top.distilled)
        const updated: VoxelProjectionPayload = {
          event: { ...top.payload.event, ...copy },
          sourceEventIds: top.payload.sourceEventIds,
          copySource: 'llm',
        }
        top.payload.event = updated.event
        top.payload.copySource = 'llm'
        await db.update(voxelEventProjections)
          .set({ payloadJson: JSON.stringify(updated) })
          .where(and(eq(voxelEventProjections.id, `vep:${timeline.id}:${top.distilled.event.id}`), eq(voxelEventProjections.timelineId, timeline.id)))
        copyLlm = true
      } catch (error) {
        // fail-closed:预算触顶/LLM 失败 → 模板文案已在库,事件照常上线
        if (!(error instanceof BudgetRefusal)) {
          console.warn(`[voxel] 披露文案生成失败 ${timeline.id}:`, error instanceof Error ? error.message : error)
        }
      }
    }
  }

  return { projected: writes.length, skipped, copyLlm }
}
