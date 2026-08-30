import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { llmCallLog, worlds } from '../db/schema'
import type { CallPurpose } from './steps/types'

type World = typeof worlds.$inferSelect

/** 成本护栏配置（D12：环境变量可调，缺省值如下） */
export interface BudgetConfig {
  worldSpeed: number // WORLD_SPEED 缺省 6（世界时钟倍速）
  tickCallCap: number // TICK_CALL_CAP 缺省 8（每世界每拍 LLM 调用上限）
  dailyCallCap: number // DAILY_CALL_CAP 缺省 400（每世界每日 LLM 调用上限）
  summaryThreshold: number // MEMORY_SUMMARY_THRESHOLD 缺省 40（触发记忆压缩的未压缩条数）
}

export function budgetFromEnv(env: {
  WORLD_SPEED?: string
  TICK_CALL_CAP?: string
  DAILY_CALL_CAP?: string
  MEMORY_SUMMARY_THRESHOLD?: string
}): BudgetConfig {
  const num = (v: string | undefined, dflt: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt
  }
  return {
    worldSpeed: num(env.WORLD_SPEED, 6),
    tickCallCap: num(env.TICK_CALL_CAP, 8),
    dailyCallCap: num(env.DAILY_CALL_CAP, 400),
    summaryThreshold: num(env.MEMORY_SUMMARY_THRESHOLD, 40),
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 记账：每次 LLM 调用写 llm_call_log 并把 worlds.callsToday +1（换天先清零）。
 * 返回最新的 world 行（调用方据此判断触顶）。
 */
export async function recordCall(
  db: Db,
  world: World,
  meta: { timelineId: string | null; personId: string | null; purpose: CallPurpose },
  n: number = 1,
): Promise<World> {
  if (n <= 0) return world
  const now = new Date().toISOString()
  const callsDay = world.callsDay === today() ? world.callsDay : today()
  const callsToday = (world.callsDay === today() ? world.callsToday : 0) + n

  for (let i = 0; i < n; i++) {
    await db.insert(llmCallLog).values({
      id: crypto.randomUUID(),
      worldId: world.id,
      timelineId: meta.timelineId,
      personId: meta.personId,
      purpose: meta.purpose,
      createdAt: now,
    })
  }
  await db.update(worlds).set({ callsToday, callsDay }).where(eq(worlds.id, world.id))
  return { ...world, callsToday, callsDay }
}

/** 本拍预算是否还够（每世界每拍上限） */
export function tickBudgetOk(tickCalls: number, cfg: BudgetConfig): boolean {
  return tickCalls < cfg.tickCallCap
}

/** 每日上限是否触顶（换天未记账时视为 0） */
export function dailyCapHit(world: World, cfg: BudgetConfig): boolean {
  if (world.callsDay !== today()) return false
  return world.callsToday >= cfg.dailyCallCap
}

/** 触顶动作：世界置 capped、记录原因 */
export async function capWorld(db: Db, worldId: string): Promise<void> {
  await db.update(worlds).set({ status: 'capped', pauseReason: 'daily_cap' }).where(eq(worlds.id, worldId))
}
