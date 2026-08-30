import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { dialogues, events, personStates, timelines, worlds } from '../db/schema'
import type { Env } from '../index'
import {
  buildWorldSnapshot,
  currentScheduleItem,
  isAwake,
  parseScheduleItems,
  type WorldSnapshot,
} from '../agent/engine-context'
import { needsSummary } from '../agent/memory'
import { budgetFromEnv, capWorld, dailyCapHit, recordCall, type BudgetConfig } from './budget'
import { beatExecutor } from './steps/beat'
import { dialogueExecutor } from './steps/dialogue'
import { injectionExecutor } from './steps/injection'
import { scheduleExecutor } from './steps/schedule'
import { summaryExecutor } from './steps/summary'
import type { AgentStep, StepExecutor } from './steps/types'

type World = typeof worlds.$inferSelect

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyExecutor = StepExecutor<any, any>

const EXECUTORS: Record<AgentStep['kind'], AnyExecutor> = {
  schedule: scheduleExecutor,
  beat: beatExecutor,
  dialogue_turn: dialogueExecutor,
  injection: injectionExecutor,
  summary: summaryExecutor,
}

export interface StepReport {
  kind: string
  personId: string | null
  ok: boolean
  note?: string
}

export interface TickSummary {
  at: string
  worlds: {
    id: string
    capped: boolean
    tickCalls: number
    timelines: { id: string; simNow: string; steps: StepReport[] }[]
  }[]
}

/** 单拍时钟推进的真实时间钳制（秒）：15s 节拍 ≈ 90 虚拟秒；停机恢复后最多补 15 虚拟分钟（D2） */
const MAX_REAL_ELAPSED_SEC = 150

/** act 可能改了 personStates（对话占用、水位推进），重查刷新内存快照 */
async function refreshStates(db: Db, snapshot: WorldSnapshot): Promise<void> {
  const rows = await db.select().from(personStates).where(eq(personStates.timelineId, snapshot.timeline.id)).all()
  snapshot.states.clear()
  for (const s of rows) snapshot.states.set(s.personId, s)
}

/**
 * 引擎一拍（M1）：对所有 running 世界 × active 时间线做一轮推进。
 * 时钟快进 → 机械日程（零 LLM）→ 决策点按优先级在预算内执行 → 记账与触顶。
 * 单飞：上一拍未结束时直接返回（pinger 串行之外的并发调用防护）。
 */
let tickInFlight = false

export async function runTick(env: Env, db: Db): Promise<TickSummary | null> {
  if (tickInFlight) return null
  tickInFlight = true
  try {
    return await runTickInner(env, db)
  } finally {
    tickInFlight = false
  }
}

async function runTickInner(env: Env, db: Db): Promise<TickSummary> {
  const cfg: BudgetConfig = budgetFromEnv(env)
  const summary: TickSummary = { at: new Date().toISOString(), worlds: [] }

  const runningWorlds = await db.select().from(worlds).where(eq(worlds.status, 'running')).all()

  for (const world of runningWorlds) {
    let currentWorld: World = world
    let tickCalls = 0
    const worldReport: TickSummary['worlds'][number] = { id: world.id, capped: false, tickCalls: 0, timelines: [] }

    const activeTimelines = await db
      .select()
      .from(timelines)
      .where(and(eq(timelines.worldId, world.id), eq(timelines.status, 'active')))
      .all()

    for (const tl of activeTimelines) {
      // 1. 时钟推进：真实经过 × 倍速，单拍钳制；首拍仅建立基准（停机不追赶）
      const nowReal = new Date()
      const lastTickMs = tl.lastRealTickAt ? Date.parse(tl.lastRealTickAt) : null
      let simNow = tl.simNow
      if (lastTickMs === null) {
        await db.update(timelines).set({ lastRealTickAt: nowReal.toISOString() }).where(eq(timelines.id, tl.id))
      } else {
        const elapsedSec = Math.min(Math.max((nowReal.getTime() - lastTickMs) / 1000, 0), MAX_REAL_ELAPSED_SEC)
        if (elapsedSec > 0) {
          simNow = new Date(Date.parse(tl.simNow) + elapsedSec * 1000 * cfg.worldSpeed).toISOString()
          await db
            .update(timelines)
            .set({ simNow, lastRealTickAt: nowReal.toISOString() })
            .where(eq(timelines.id, tl.id))
        } else {
          await db.update(timelines).set({ lastRealTickAt: nowReal.toISOString() }).where(eq(timelines.id, tl.id))
        }
      }

      const snapshot = await buildWorldSnapshot(db, world.id, tl.id)
      if (!snapshot) {
        worldReport.timelines.push({ id: tl.id, simNow, steps: [] })
        continue
      }

      // 2a. 清理悬空对话占用（进程重启打断 act 可能留下指向不存在/已结束对话的占用标记）
      for (const p of snapshot.persons) {
        const st = snapshot.states.get(p.id)
        if (!st?.currentDialogueId) continue
        const dlg = await db.select().from(dialogues).where(eq(dialogues.id, st.currentDialogueId)).get()
        if (!dlg || dlg.status !== 'ongoing') {
          await db
            .update(personStates)
            .set({ currentDialogueId: null })
            .where(and(eq(personStates.personId, p.id), eq(personStates.timelineId, tl.id)))
          st.currentDialogueId = null
        }
      }

      // 2b. 机械日程：越过日程项边界就切到当前项（零 LLM 零记账）
      for (const p of snapshot.persons) {
        const state = snapshot.states.get(p.id)
        if (!state || state.currentDialogueId) continue
        const items = parseScheduleItems(snapshot.schedules.get(p.id))
        if (!items) continue
        const anchor = state.lastBeatSimTime ?? simNow
        const itemThen = currentScheduleItem(items, anchor)
        const itemNow = currentScheduleItem(items, simNow)
        if (itemNow && itemNow !== itemThen) {
          await db
            .update(personStates)
            .set({ location: itemNow.location, activity: itemNow.activity, simTime: simNow, updatedRealAt: nowReal.toISOString() })
            .where(and(eq(personStates.personId, p.id), eq(personStates.timelineId, tl.id)))
          state.location = itemNow.location
          state.activity = itemNow.activity
          state.simTime = simNow
        }
      }

      // 3. 收集决策点（P1 对话轮转 → P2 注入反应 → P3 生活节拍 → P4 日程生成 → P5 记忆压缩）
      const steps: AgentStep[] = []

      const ongoingDialogues = await db
        .select()
        .from(dialogues)
        .where(and(eq(dialogues.timelineId, tl.id), eq(dialogues.status, 'ongoing')))
        .all()
      for (const d of ongoingDialogues) {
        steps.push({ kind: 'dialogue_turn', worldId: world.id, timelineId: tl.id, personId: null, priority: 1, dialogueId: d.id })
      }

      const injectedEvents = await db
        .select()
        .from(events)
        .where(and(eq(events.timelineId, tl.id), eq(events.kind, 'injected')))
        .all()
      for (const ev of injectedEvents) {
        for (const p of snapshot.persons) {
          const st = snapshot.states.get(p.id)
          if (!st || st.currentDialogueId) continue
          if (st.lastBeatSimTime && ev.simTime <= st.lastBeatSimTime) continue
          if (!isAwake(parseScheduleItems(snapshot.schedules.get(p.id)), simNow)) continue
          steps.push({ kind: 'injection', worldId: world.id, timelineId: tl.id, personId: p.id, priority: 2, eventId: ev.id })
        }
      }

      for (const p of snapshot.persons) {
        const st = snapshot.states.get(p.id)
        if (!st || st.currentDialogueId) continue
        const items = parseScheduleItems(snapshot.schedules.get(p.id))
        if (!isAwake(items, simNow)) continue
        if (!st.lastBeatSimTime) {
          // 首次见到：初始化水位线（本拍不产生节拍）
          await db
            .update(personStates)
            .set({ lastBeatSimTime: simNow })
            .where(and(eq(personStates.personId, p.id), eq(personStates.timelineId, tl.id)))
          st.lastBeatSimTime = simNow
          continue
        }
        const itemThen = currentScheduleItem(items, st.lastBeatSimTime)
        const itemNow = currentScheduleItem(items, simNow)
        if (items && itemNow !== itemThen) {
          steps.push({ kind: 'beat', worldId: world.id, timelineId: tl.id, personId: p.id, priority: 3 })
        }
      }

      for (const p of snapshot.persons) {
        if (!snapshot.schedules.has(p.id)) {
          steps.push({ kind: 'schedule', worldId: world.id, timelineId: tl.id, personId: p.id, priority: 4 })
        }
      }

      for (const p of snapshot.persons) {
        if (await needsSummary(db, p.id, snapshot.timeline, cfg.summaryThreshold)) {
          steps.push({ kind: 'summary', worldId: world.id, timelineId: tl.id, personId: p.id, priority: 5 })
        }
      }

      // 4. 预算内按优先级执行；花不完的活留到下拍
      steps.sort((a, b) => a.priority - b.priority)
      const tlReport: TickSummary['worlds'][number]['timelines'][number] = { id: tl.id, simNow, steps: [] }

      for (const step of steps) {
        if (currentWorld.status !== 'running') break
        const remaining = cfg.tickCallCap - tickCalls
        if (remaining <= 0) break
        const executor = EXECUTORS[step.kind]
        try {
          const input = await executor.perceive(db, step, snapshot)
          if (!input) continue
          console.log(`[tick] ${world.name}/${tl.id.slice(0, 6)} ${step.kind} ${step.personId?.slice(0, 6) ?? '-'} decide…`)
          const t0 = Date.now()
          const { value, llmCalls } = await executor.decide(env, input, { maxCalls: remaining })
          console.log(`[tick] ${step.kind} decide 完成 llmCalls=${llmCalls} 耗时=${Math.round((Date.now() - t0) / 1000)}s value=${value ? 'ok' : 'null'}`)
          if (llmCalls > 0) {
            tickCalls += llmCalls
            // 记账归属到实际执行的人物（dialogue_turn 的 step.personId 为空，取 perceive 出的发言者）
            const callPersonId = step.personId ?? (input?.ctx?.person?.id as string | undefined) ?? null
            currentWorld = await recordCall(db, currentWorld, { timelineId: tl.id, personId: callPersonId, purpose: step.kind }, llmCalls)
            if (dailyCapHit(currentWorld, cfg)) {
              await capWorld(db, currentWorld.id)
              currentWorld = { ...currentWorld, status: 'capped', pauseReason: 'daily_cap' }
              worldReport.capped = true
              tlReport.steps.push({ kind: step.kind, personId: step.personId, ok: false, note: 'daily_cap 触顶' })
              break
            }
          }
          if (value === null) {
            tlReport.steps.push({ kind: step.kind, personId: step.personId, ok: false, note: 'decide 失败跳过' })
            continue
          }
          const note = (await executor.act(db, env, input, value)) as string
          await refreshStates(db, snapshot)
          tlReport.steps.push({ kind: step.kind, personId: step.personId, ok: true, note })
        } catch (e) {
          // D17/N3：单步失败不阻塞同线其他人物与整拍
          tlReport.steps.push({
            kind: step.kind,
            personId: step.personId,
            ok: false,
            note: e instanceof Error ? e.message.slice(0, 120) : '未知错误',
          })
        }
      }

      worldReport.timelines.push(tlReport)
      worldReport.tickCalls = tickCalls
    }

    summary.worlds.push(worldReport)
  }

  return summary
}
