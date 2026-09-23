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
import { budgetFromEnv, recoverCappedWorlds, archiveIdleWorlds, type BudgetConfig } from './budget'
import { worldReservation, type TickBudget } from './guard'
import { planTickSteps } from './director'
import { arbitrateInjections } from './director-llm'
import { beatExecutor } from './steps/beat'
import { dialogueExecutor } from './steps/dialogue'
import { injectionExecutor } from './steps/injection'
import { scheduleExecutor } from './steps/schedule'
import { summaryExecutor } from './steps/summary'
import { advanceCommitments } from '../life/service'
import type { AgentStep, StepExecutor } from './steps/types'
import { advanceWorldClock, recoverDialogueLock, recordResidentState, recordSimulationCheckpoint } from '../world-state/system'
import { WorldStateError } from '../world-state/types'
import { acquireEngineTickLease, ENGINE_TICK_HEARTBEAT_MS, renewEngineTickLease, releaseEngineTickLease } from './tick-lease'

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

export class TickLeaseLostError extends Error {
  readonly status = 409
  constructor() { super('世界引擎租约已失效；本拍已停止提交') }
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
  const ownerToken = crypto.randomUUID()
  let acquired = false
  let leaseLost = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  try {
    acquired = await acquireEngineTickLease(db, ownerToken)
    if (!acquired) return null
    heartbeat = setInterval(() => {
      void renewEngineTickLease(db, ownerToken).then(renewed => { if (!renewed) leaseLost = true })
        .catch(() => { leaseLost = true })
    }, ENGINE_TICK_HEARTBEAT_MS)
    const assertLease = async () => {
      if (leaseLost || !await renewEngineTickLease(db, ownerToken)) {
        leaseLost = true
        throw new TickLeaseLostError()
      }
    }
    return await runTickInner({ ...env, ENGINE_TICK_LEASE_TOKEN: ownerToken }, db, assertLease)
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    try {
      if (acquired) await releaseEngineTickLease(db, ownerToken)
    } finally {
      tickInFlight = false
    }
  }
}

async function runTickInner(env: Env, db: Db, assertLease: () => Promise<void>): Promise<TickSummary> {
  const cfg: BudgetConfig = budgetFromEnv(env)
  const summary: TickSummary = { at: new Date().toISOString(), worlds: [] }

  // 0. 换天恢复：昨日触顶的 capped 世界自动复位（否则被下方 running 查询永久排除）
  await assertLease()
  await recoverCappedWorlds(db, new Date().toISOString().slice(0, 10))
  // 0b. 闲置归档：长时间无用户交互的世界冻结（AI Town archive 思路；resume 解冻）
  await assertLease()
  await archiveIdleWorlds(db, cfg)

  const runningWorlds = await db.select().from(worlds).where(eq(worlds.status, 'running')).all()

  for (const world of runningWorlds) {
    await assertLease()
    let currentWorld: World = world
    let tickCalls = 0
    const tickBudget: TickBudget = { used: 0, limit: cfg.tickCallCap }
    const worldReport: TickSummary['worlds'][number] = { id: world.id, capped: false, tickCalls: 0, timelines: [] }

    const activeTimelines = await db
      .select()
      .from(timelines)
      .where(and(eq(timelines.worldId, world.id), eq(timelines.status, 'active')))
      .all()

    for (const tl of activeTimelines) {
      await assertLease()
      // 1. 时钟推进：真实经过 × 倍速，单拍钳制；模拟时间变化作为版本化事实提交。
      const nowReal = new Date()
      const simNow = await advanceWorldClock(db, { worldId: world.id, timelineId: tl.id, observedAt: nowReal,
        worldSpeed: cfg.worldSpeed, maxElapsedSeconds: MAX_REAL_ELAPSED_SEC,
        engineTickLeaseToken: env.ENGINE_TICK_LEASE_TOKEN })

      const snapshot = await buildWorldSnapshot(db, world.id, tl.id)
      if (!snapshot) {
        worldReport.timelines.push({ id: tl.id, simNow, steps: [] })
        continue
      }

      // 约定到期是机械事实，不烧 LLM：接受的邀约变成失约，未接受的邀请自然过期。
      await advanceCommitments(db, tl.id, simNow, env.ENGINE_TICK_LEASE_TOKEN)

      // 2a. 清理悬空对话占用（进程重启打断 act 可能留下指向不存在/已结束对话的占用标记）
      for (const p of snapshot.persons) {
        const st = snapshot.states.get(p.id)
        if (!st?.currentDialogueId) continue
        const dialogueId = st.currentDialogueId
        const dlg = await db.select().from(dialogues).where(eq(dialogues.id, dialogueId)).get()
        if (!dlg || dlg.status !== 'ongoing') {
          const recovered = await recoverDialogueLock(db, { worldId: world.id, timelineId: tl.id,
            sourceKey: `dialogue-recovery:${tl.id}:${p.id}:${dialogueId}`, personId: p.id, dialogueId,
            engineTickLeaseToken: env.ENGINE_TICK_LEASE_TOKEN })
          const currentState = await db.select().from(personStates).where(and(
            eq(personStates.personId, p.id), eq(personStates.timelineId, tl.id),
          )).get()
          if (recovered) st.currentDialogueId = null
          else if (currentState) st.currentDialogueId = currentState.currentDialogueId
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
        if (itemNow && itemNow !== itemThen
          && (state.location !== itemNow.location || state.activity !== itemNow.activity)) {
          try {
            await recordResidentState(db, {
              worldId: world.id, timelineId: tl.id,
              sourceKey: `schedule:${tl.id}:${p.id}:${simNow}`,
              engineTickLeaseToken: env.ENGINE_TICK_LEASE_TOKEN,
              action: { type: 'resident_state', personId: p.id, cause: 'schedule', windowStart: anchor,
                patch: { ...(state.location !== itemNow.location ? { location: itemNow.location } : {}), activity: itemNow.activity },
                events: [], memories: [] },
            })
          } catch (error) {
            // Legacy schedules may contain locations no longer in this world's pinned model.
            // Reject the entire movement/activity transition rather than recording half of it.
            if (error instanceof WorldStateError) continue
            throw error
          }
          state.location = itemNow.location
          state.activity = itemNow.activity
          state.simTime = simNow
        }
      }

      // 3. 收集决策点（P1 对话轮转 → P2 注入反应 → P3 生活节拍 → P4 日程生成 → P5 记忆压缩）
      let steps: AgentStep[] = []

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
          if (p.isUser) continue // 用户在场身份由用户亲自扮演，引擎不替 TA 反应
          const st = snapshot.states.get(p.id)
          if (!st || st.currentDialogueId) continue
          if (st.lastBeatSimTime && ev.simTime <= st.lastBeatSimTime) continue
          if (!isAwake(parseScheduleItems(snapshot.schedules.get(p.id)), simNow)) continue
          steps.push({ kind: 'injection', worldId: world.id, timelineId: tl.id, personId: p.id, priority: 2, eventId: ev.id })
        }
      }

      for (const p of snapshot.persons) {
        if (p.isUser) continue
        const st = snapshot.states.get(p.id)
        if (!st || st.currentDialogueId) continue
        const items = parseScheduleItems(snapshot.schedules.get(p.id))
        if (!isAwake(items, simNow)) continue
        if (!st.lastBeatSimTime) {
          // 首次见到：初始化水位线（本拍不产生节拍）
          try {
            await recordSimulationCheckpoint(db, { worldId: world.id, timelineId: tl.id,
              sourceKey: `beat-watermark:${tl.id}:${p.id}:${simNow}`, personId: p.id, lastBeatSimTime: simNow,
              engineTickLeaseToken: env.ENGINE_TICK_LEASE_TOKEN })
          } catch (error) {
            if (error instanceof WorldStateError) continue
            throw error
          }
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
        if (p.isUser) continue
        if (!snapshot.schedules.has(p.id)) {
          steps.push({ kind: 'schedule', worldId: world.id, timelineId: tl.id, personId: p.id, priority: 4 })
        }
      }

      for (const p of snapshot.persons) {
        if (p.isUser) continue
        if (await needsSummary(db, p.id, snapshot.timeline, cfg.summaryThreshold)) {
          steps.push({ kind: 'summary', worldId: world.id, timelineId: tl.id, personId: p.id, priority: 5 })
        }
      }

      // 3b. 导演层 v2：注入事件反应者拥挤时，问一次 LLM"谁最有戏"（每拍至多 1 次调用，
      // 失败回退 v1 机械排序）；调用计入本拍预算与日限额，无旁路。
      if (cfg.directorLlm && tickCalls < cfg.tickCallCap) {
        const directorReserve = worldReservation(db, world.id, cfg, { timelineId: tl.id, personId: null, purpose: 'director' }, tickBudget)
        const arb = await arbitrateInjections(env, db, snapshot, steps, { maxCalls: 1, reserve: directorReserve })
        if (arb.llmCalls > 0) {
          steps = arb.steps
          tickCalls = tickBudget.used
        }
      }

      // 4. 导演层仲裁（注入扇入 + 人物轮转），再按序在预算内执行；花不完的活留到下拍
      const plan = planTickSteps(steps, cfg)
      for (const step of plan.steps) step.engineTickLeaseToken = env.ENGINE_TICK_LEASE_TOKEN
      const tlReport: TickSummary['worlds'][number]['timelines'][number] = { id: tl.id, simNow, steps: [] }

      for (const step of plan.steps) {
        await assertLease()
        if (currentWorld.status !== 'running') break
        const remaining = cfg.tickCallCap - tickCalls
        if (remaining <= 0) break
        const executor = EXECUTORS[step.kind]
        try {
          const input = await executor.perceive(db, step, snapshot)
          if (!input) continue
          console.log(`[tick] ${world.name}/${tl.id.slice(0, 6)} ${step.kind} ${step.personId?.slice(0, 6) ?? '-'} decide…`)
          const t0 = Date.now()
          const callPersonId = step.personId ?? (input?.ctx?.person?.id as string | undefined) ?? null
          const reserve = worldReservation(db, world.id, cfg, { timelineId: tl.id, personId: callPersonId, purpose: step.kind }, tickBudget)
          const { value, llmCalls } = await executor.decide(env, input, { maxCalls: remaining, reserve })
          console.log(`[tick] ${step.kind} decide 完成 llmCalls=${llmCalls} 耗时=${Math.round((Date.now() - t0) / 1000)}s value=${value ? 'ok' : 'null'}`)
          await assertLease()
          if (llmCalls > 0) {
            tickCalls = tickBudget.used
          }
          if (value === null) {
            tlReport.steps.push({ kind: step.kind, personId: step.personId, ok: false, note: 'decide 失败跳过' })
            continue
          }
          const note = (await executor.act(db, env, input, value)) as string
          await refreshStates(db, snapshot)
          tlReport.steps.push({ kind: step.kind, personId: step.personId, ok: true, note })
        } catch (e) {
          if (e instanceof TickLeaseLostError) throw e
          await assertLease()
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
