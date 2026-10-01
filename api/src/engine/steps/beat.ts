import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { dialogues, events } from '../../db/schema'
import { completeContract } from '../../llm/client'
import { contractViolation, LLM_CONTRACT_VERSIONS, parseContractObject, requireNumber,
  requireString } from '../../llm/contracts'
import type { Env } from '../../index'
import {
  buildEngineContext,
  currentScheduleItem,
  isAwake,
  parseScheduleItems,
  type EngineContext,
  type ScheduleItem,
  type WorldSnapshot,
} from '../../agent/engine-context'
import { buildBeatPrompt, type PromptPair } from '../../agent/engine-prompt'
import { clampImportance } from '../../agent/memory'
import { parseMemoryAnnotations, type MemoryAnnotations } from './annotations'
import type { AgentStep, DecideOpts, DecideResult, StepExecutor } from './types'
import { llmConfigFor } from './types'
import { recordResidentState, recordSimulationCheckpoint, startNpcDialogue } from '../../world-state/system'

export type BeatInput =
  | { kind: 'encounter'; step: AgentStep; snapshot: WorldSnapshot; ctx: EngineContext; partnerId: string }
  | {
      kind: 'solo'
      step: AgentStep
      snapshot: WorldSnapshot
      ctx: EngineContext
      finishedItem: ScheduleItem | null
      windowStart: string
      windowMinutes: number
      prompt: PromptPair
    }

export type BeatOutput = { kind: 'encounter' } | { kind: 'solo'; beat: BeatJson }

export interface BeatJson {
  events: { title: string; description: string; offsetMin: number }[]
  thought: string
  memory: ({ content: string; type: string; importance: number } & MemoryAnnotations) | null
  nextLocation: string | null
  nextActivity: string | null
  mood: string | null
  goal: string | null
}

/** 对话冷却：同一对人物距上次对话结束至少 2 虚拟小时（D5） */
const ENCOUNTER_COOLDOWN_MS = 2 * 60 * 60 * 1000

/** 双方最近一次已结束对话（同时间线） */
async function lastDialogueBetween(db: Db, timelineId: string, aId: string, bId: string) {
  const rows = await db
    .select()
    .from(dialogues)
    .where(and(eq(dialogues.timelineId, timelineId), eq(dialogues.status, 'ended')))
    .orderBy(desc(dialogues.simEnd))
    .limit(30)
    .all()
  for (const d of rows) {
    try {
      const ids = JSON.parse(d.participantIdsJson) as string[]
      if (ids.includes(aId) && ids.includes(bId)) return d
    } catch {
      // 跳过损坏行
    }
  }
  return null
}

/** 校验并规范化 beat JSON（宽松补缺；thought 与 events 必填，缺失视为失败触发重试）。
 *  offsetMin 钳制在 [0, windowMinutes]：模型不可把事件写到节拍窗口之外（曾因此出现
 *  "未来事件"——章节 toSim 越过 simNow，且堵住后续章节窗口）。 */
export function normalizeBeatJson(
  raw: unknown,
  locationNames: string[],
  windowMinutes: number,
  version: string = LLM_CONTRACT_VERSIONS.beat,
  people: { id: string; name: string }[] = [],
): BeatJson {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return contractViolation(version, '输出必须是对象')
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.events) || r.events.length < 1 || r.events.length > 3) {
    return contractViolation(version, 'events 必须包含 1-3 项')
  }
  const evs = r.events.map((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return contractViolation(version, `events[${index}] 必须是对象`)
    }
    const o = event as Record<string, unknown>
    return {
      title: requireString(o.title, `events[${index}].title`, version, 60),
      description: requireString(o.description, `events[${index}].description`, version, 2000),
      offsetMin: Math.round(requireNumber(o.offsetMin, `events[${index}].offsetMin`, version, 0, windowMinutes)),
    }
  })
  const thought = requireString(r.thought, 'thought', version, 2000)

  let memory: BeatJson['memory'] = null
  if (r.memory && typeof r.memory === 'object') {
    if (Array.isArray(r.memory)) return contractViolation(version, 'memory 必须是对象或 null')
    const m = r.memory as Record<string, unknown>
    const content = requireString(m.content, 'memory.content', version, 2000)
    if (m.type !== 'timeline' && m.type !== 'relationship' && m.type !== 'world') {
      return contractViolation(version, 'memory.type 非法')
    }
    memory = { content, type: m.type, importance: requireNumber(m.importance, 'memory.importance', version, 1, 10),
      ...parseMemoryAnnotations(m, people, locationNames) }
  } else if (r.memory !== undefined && r.memory !== null) {
    return contractViolation(version, 'memory 必须是对象或 null')
  }
  const optionalString = (value: unknown, field: string) => {
    if (value === null || value === undefined) return null
    return requireString(value, field, version, 200)
  }
  const nextLocation = optionalString(r.nextLocation, 'nextLocation')
  if (nextLocation && !locationNames.includes(nextLocation)) return contractViolation(version, 'nextLocation 不在世界中')
  return {
    events: evs,
    thought,
    memory,
    nextLocation,
    nextActivity: optionalString(r.nextActivity, 'nextActivity'),
    mood: optionalString(r.mood, 'mood'),
    goal: optionalString(r.goal, 'goal'),
  }
}

/** beat 与 injection 共用一个版本化边界提交居民状态、叙述事件及私有记忆。 */
export async function applyBeatOutput(
  db: Db,
  opts: {
    timelineId: string
    worldId: string
    personId: string
    simNow: string
    windowStart: string
    beat: BeatJson
    cause?: 'beat' | 'injection'
    sourceKey?: string
    engineTickLeaseToken?: string
  },
): Promise<void> {
  const { timelineId, personId, simNow, windowStart, beat } = opts
  const baseMs = Date.parse(windowStart)
  const cause = opts.cause ?? 'beat'
  const memoriesToWrite: Extract<import('../../world-state/types').WorldAction, { type: 'resident_state' }>['memories'] = [
    { type: 'thought', content: beat.thought, importance: 5 },
    ...(beat.memory ? [{ type: beat.memory.type as 'timeline' | 'relationship' | 'world', content: beat.memory.content,
      importance: clampImportance(beat.memory.importance),
      mentions: beat.memory.mentions, location: beat.memory.location, topics: beat.memory.topics }] : []),
  ]
  await recordResidentState(db, {
    worldId: opts.worldId, timelineId, sourceKey: opts.sourceKey ?? `${cause}:${timelineId}:${personId}:${simNow}`,
    engineTickLeaseToken: opts.engineTickLeaseToken,
    action: {
      type: 'resident_state', personId, cause, windowStart,
      patch: { ...(beat.nextLocation ? { location: beat.nextLocation } : {}), ...(beat.nextActivity ? { activity: beat.nextActivity } : {}),
        ...(beat.mood ? { mood: beat.mood } : {}), ...(beat.goal ? { goal: beat.goal } : {}), lastBeatSimTime: simNow },
      events: beat.events.map(ev => ({ simTime: new Date(baseMs + ev.offsetMin * 60_000).toISOString(), title: ev.title, description: ev.description })),
      memories: memoriesToWrite,
    },
  })
}

/** 生活节拍（P3）：日程项结束 → 总结经历；相遇检测优先（转为发起对话，不调 LLM） */
export const beatExecutor: StepExecutor<BeatInput, BeatOutput> = {
  async perceive(db: Db, step: AgentStep, snapshot: WorldSnapshot): Promise<BeatInput | null> {
    if (!step.personId) return null
    const state = snapshot.states.get(step.personId)
    if (!state || state.currentDialogueId) return null

    const items = parseScheduleItems(snapshot.schedules.get(step.personId))
    if (!isAwake(items, snapshot.timeline.simNow)) return null

    // 水位线：lastBeatSimTime 到 simNow 之间跨过了日程项边界才产生节拍
    const lastBeat = state.lastBeatSimTime
    if (!lastBeat) {
      // 首次见到该人物：初始化水位线，不产生节拍
      await recordSimulationCheckpoint(db, { worldId: step.worldId, timelineId: step.timelineId,
        sourceKey: `beat-watermark:${step.timelineId}:${step.personId}:${snapshot.timeline.simNow}`,
        personId: step.personId, lastBeatSimTime: snapshot.timeline.simNow,
        engineTickLeaseToken: step.engineTickLeaseToken })
      return null
    }
    const itemNow = currentScheduleItem(items, snapshot.timeline.simNow)
    const itemThen = currentScheduleItem(items, lastBeat)
    if (itemNow === itemThen) return null // 同一日程项内，无节拍

    const ctx = await buildEngineContext(db, step.personId, snapshot)
    if (!ctx) return null

    // 相遇检测（D5）：同地点清醒人物 + 双方空闲 + 冷却 2 虚拟小时
    for (const other of ctx.sameLocationAwake) {
      const last = await lastDialogueBetween(db, snapshot.timeline.id, step.personId, other.id)
      const cooledDown =
        !last || !last.simEnd || Date.parse(snapshot.timeline.simNow) - Date.parse(last.simEnd) >= ENCOUNTER_COOLDOWN_MS
      if (cooledDown) {
        return { kind: 'encounter', step, snapshot, ctx, partnerId: other.id }
      }
    }

    const windowMinutes = Math.max(1, Math.round((Date.parse(snapshot.timeline.simNow) - Date.parse(lastBeat)) / 60_000))
    return {
      kind: 'solo',
      step,
      snapshot,
      ctx,
      finishedItem: itemThen,
      windowStart: lastBeat,
      windowMinutes,
      prompt: buildBeatPrompt(ctx, itemThen, windowMinutes),
    }
  },

  async decide(env: Env, input: BeatInput, opts: DecideOpts): Promise<DecideResult<BeatOutput>> {
    if (input.kind === 'encounter') return { value: { kind: 'encounter' }, llmCalls: 0 }
    const config = llmConfigFor(env, opts.llm, opts.reserve)
    const locationNames = input.snapshot.locations.map((l) => l.name)
    let llmCalls = 0
    const maxAttempts = Math.max(0, Math.min(2, opts?.maxCalls ?? 2))
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      llmCalls++
      try {
        const beat = await completeContract(
          config,
          [
            { role: 'system', content: input.prompt.system },
            { role: 'user', content: input.prompt.user },
          ],
          { maxTokens: 8000, contractVersion: LLM_CONTRACT_VERSIONS.beat,
            parse: raw => normalizeBeatJson(
              parseContractObject(raw, LLM_CONTRACT_VERSIONS.beat), locationNames, input.windowMinutes,
              LLM_CONTRACT_VERSIONS.beat,
              input.ctx.others.map((o) => ({ id: o.person.id, name: o.person.name })),
            ) },
        )
        return { value: { kind: 'solo', beat }, llmCalls: opts?.reserve?.calls ?? llmCalls }
      } catch {
        // D17：重试一次后放弃
      }
    }
    return { value: null, llmCalls: opts?.reserve?.calls ?? llmCalls }
  },

  async act(db: Db, env: Env, input: BeatInput, output: BeatOutput): Promise<string> {
    const simNow = input.snapshot.timeline.simNow
    const me = input.ctx.person
    if (output.kind === 'encounter' && input.kind === 'encounter') {
      const partner = input.snapshot.persons.find((p) => p.id === input.partnerId)
      if (!partner) return `encounter 失败：对方不存在`
      await startNpcDialogue(db, { worldId: input.step.worldId, timelineId: input.step.timelineId,
        sourceKey: `encounter:${input.step.timelineId}:${simNow}:${me.id}:${partner.id}`,
        participantIds: [me.id, partner.id], location: input.ctx.state.location, turnLimit: 8,
        engineTickLeaseToken: env.ENGINE_TICK_LEASE_TOKEN })
      return `encounter: ${me.name} × ${partner.name}`
    }

    if (output.kind === 'solo') {
      if (input.kind !== 'solo') throw new Error('input/output 类型不匹配')
      await applyBeatOutput(db, {
        worldId: input.step.worldId,
        timelineId: input.step.timelineId,
        personId: me.id,
        simNow,
        windowStart: input.windowStart,
        beat: output.beat,
        engineTickLeaseToken: env.ENGINE_TICK_LEASE_TOKEN,
      })
      return `beat(${me.name}): ${output.beat.events.length} 事件`
    }
    return 'noop'
  },
}
