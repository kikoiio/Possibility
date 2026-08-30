import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { dialogues, events, memories, personStates } from '../../db/schema'
import { configFromEnv, complete } from '../../llm/client'
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
import { buildBeatPrompt, extractJson, type PromptPair } from '../../agent/engine-prompt'
import { clampImportance } from '../../agent/memory'
import type { AgentStep, DecideOpts, DecideResult, StepExecutor } from './types'

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
  memory: { content: string; type: string; importance: number } | null
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

/** 校验并规范化 beat JSON（宽松补缺；thought 与 events 必填，缺失视为失败触发重试） */
export function normalizeBeatJson(raw: unknown, locationNames: string[]): BeatJson {
  const r = (raw ?? {}) as Record<string, unknown>
  const eventsRaw = Array.isArray(r.events) ? r.events : []
  const evs = eventsRaw
    .map((e) => {
      const o = (e ?? {}) as Record<string, unknown>
      const offset = Number(o.offsetMin)
      return {
        title: String(o.title ?? '').trim().slice(0, 60),
        description: String(o.description ?? '').trim(),
        offsetMin: Number.isFinite(offset) ? Math.max(0, Math.round(offset)) : 0,
      }
    })
    .filter((e) => e.title && e.description)
    .slice(0, 3)
  if (!evs.length) throw new Error('events 为空')
  const thought = String(r.thought ?? '').trim()
  if (!thought) throw new Error('thought 为空')

  let memory: BeatJson['memory'] = null
  if (r.memory && typeof r.memory === 'object') {
    const m = r.memory as Record<string, unknown>
    const content = String(m.content ?? '').trim()
    if (content) {
      const type = ['timeline', 'relationship', 'world'].includes(String(m.type)) ? String(m.type) : 'timeline'
      memory = { content, type, importance: clampImportance(m.importance) }
    }
  }
  const str = (v: unknown) => {
    const s = String(v ?? '').trim()
    return s || null
  }
  let nextLocation = str(r.nextLocation)
  if (nextLocation && !locationNames.includes(nextLocation)) nextLocation = null
  return {
    events: evs,
    thought,
    memory,
    nextLocation,
    nextActivity: str(r.nextActivity),
    mood: str(r.mood),
    goal: str(r.goal),
  }
}

/** beat act 的公共写库：事件 + 想法 + 可选记忆 + 状态（injection 复用） */
export async function applyBeatOutput(
  db: Db,
  opts: {
    timelineId: string
    personId: string
    simNow: string
    windowStart: string
    beat: BeatJson
  },
): Promise<void> {
  const { timelineId, personId, simNow, windowStart, beat } = opts
  const baseMs = Date.parse(windowStart)

  for (const ev of beat.events) {
    await db.insert(events).values({
      id: crypto.randomUUID(),
      timelineId,
      simTime: new Date(baseMs + ev.offsetMin * 60_000).toISOString(),
      title: ev.title,
      description: ev.description,
      kind: 'action',
      actorPersonId: personId,
    })
  }
  const now = new Date().toISOString()
  await db.insert(memories).values({
    id: crypto.randomUUID(),
    personId,
    timelineId,
    type: 'thought',
    content: beat.thought,
    simTime: simNow,
    createdAt: now,
    importance: 5,
  })
  if (beat.memory) {
    await db.insert(memories).values({
      id: crypto.randomUUID(),
      personId,
      timelineId,
      type: beat.memory.type,
      content: beat.memory.content,
      simTime: simNow,
      createdAt: now,
      importance: clampImportance(beat.memory.importance),
    })
  }

  const patch: Partial<typeof personStates.$inferInsert> = {
    simTime: simNow,
    lastBeatSimTime: simNow,
    updatedRealAt: now,
  }
  if (beat.nextLocation) patch.location = beat.nextLocation
  if (beat.nextActivity) patch.activity = beat.nextActivity
  if (beat.mood) patch.mood = beat.mood
  if (beat.goal) patch.goal = beat.goal
  await db
    .update(personStates)
    .set(patch)
    .where(and(eq(personStates.personId, personId), eq(personStates.timelineId, timelineId)))
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
      await db
        .update(personStates)
        .set({ lastBeatSimTime: snapshot.timeline.simNow })
        .where(and(eq(personStates.personId, step.personId), eq(personStates.timelineId, step.timelineId)))
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

  async decide(env: Env, input: BeatInput, opts?: DecideOpts): Promise<DecideResult<BeatOutput>> {
    if (input.kind === 'encounter') return { value: { kind: 'encounter' }, llmCalls: 0 }
    const config = configFromEnv(env)
    const locationNames = input.snapshot.locations.map((l) => l.name)
    let llmCalls = 0
    const maxAttempts = Math.max(1, Math.min(2, opts?.maxCalls ?? 2))
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      llmCalls++
      try {
        const raw = await complete(
          config,
          [
            { role: 'system', content: input.prompt.system },
            { role: 'user', content: input.prompt.user },
          ],
          { maxTokens: 8000 },
        )
        return { value: { kind: 'solo', beat: normalizeBeatJson(extractJson(raw), locationNames) }, llmCalls }
      } catch {
        // D17：重试一次后放弃
      }
    }
    return { value: null, llmCalls }
  },

  async act(db: Db, _env: Env, input: BeatInput, output: BeatOutput): Promise<string> {
    const simNow = input.snapshot.timeline.simNow
    const me = input.ctx.person
    if (output.kind === 'encounter' && input.kind === 'encounter') {
      const partner = input.snapshot.persons.find((p) => p.id === input.partnerId)
      if (!partner) return `encounter 失败：对方不存在`
      const dialogueId = crypto.randomUUID()
      const now = new Date().toISOString()
      await db.insert(dialogues).values({
        id: dialogueId,
        timelineId: input.step.timelineId,
        location: input.ctx.state.location,
        participantIdsJson: JSON.stringify([me.id, partner.id]),
        status: 'ongoing',
        turnLimit: 8,
        simStart: simNow,
      })
      await db.insert(events).values({
        id: crypto.randomUUID(),
        timelineId: input.step.timelineId,
        simTime: simNow,
        title: `${me.name} 与 ${partner.name} 在${input.ctx.state.location}开始了交谈`,
        description: '',
        kind: 'dialogue',
        dialogueId,
      })
      for (const pid of [me.id, partner.id]) {
        await db
          .update(personStates)
          .set({ currentDialogueId: dialogueId, updatedRealAt: now })
          .where(and(eq(personStates.personId, pid), eq(personStates.timelineId, input.step.timelineId)))
      }
      return `encounter: ${me.name} × ${partner.name}`
    }

    if (output.kind === 'solo') {
      if (input.kind !== 'solo') throw new Error('input/output 类型不匹配')
      await applyBeatOutput(db, {
        timelineId: input.step.timelineId,
        personId: me.id,
        simNow,
        windowStart: input.windowStart,
        beat: output.beat,
      })
      return `beat(${me.name}): ${output.beat.events.length} 事件`
    }
    return 'noop'
  },
}
