import { and, count, eq, gte, isNotNull, lt, ne } from 'drizzle-orm'
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
  preworldDailyCap: number // PREWORLD_DAILY_CAP 缺省 40（每用户每日"世界创建前"调用上限：蒸馏/骨架草稿等）
  idleArchiveDays: number // IDLE_ARCHIVE_DAYS 缺省 7（无用户交互 N 天后世界自动归档冻结）
  directorLlm: boolean // DIRECTOR_LLM 缺省 on（注入事件多候选时由 LLM 仲裁反应者）
}

export function budgetFromEnv(env: {
  WORLD_SPEED?: string
  TICK_CALL_CAP?: string
  DAILY_CALL_CAP?: string
  MEMORY_SUMMARY_THRESHOLD?: string
  PREWORLD_DAILY_CAP?: string
  IDLE_ARCHIVE_DAYS?: string
  DIRECTOR_LLM?: string
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
    preworldDailyCap: num(env.PREWORLD_DAILY_CAP, 40),
    idleArchiveDays: num(env.IDLE_ARCHIVE_DAYS, 7),
    directorLlm: (env.DIRECTOR_LLM ?? '1') !== '0',
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** 换天滚动（纯函数）：callsDay 不是今天则清零（时钟单点化的同类规则，供测试与记账共用） */
export function rolloverCalls(
  callsDay: string | null,
  callsToday: number,
  day: string = today(),
): { callsDay: string; callsToday: number } {
  return callsDay === day ? { callsDay, callsToday } : { callsDay: day, callsToday: 0 }
}

/** 记账后的新计数（纯函数）：先换天滚动，再累加 n */
export function bumpCalls(
  callsDay: string | null,
  callsToday: number,
  n: number,
  day: string = today(),
): { callsDay: string; callsToday: number } {
  const rolled = rolloverCalls(callsDay, callsToday, day)
  return { callsDay: rolled.callsDay, callsToday: rolled.callsToday + n }
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
  const { callsDay, callsToday } = bumpCalls(world.callsDay, world.callsToday, n)

  for (let i = 0; i < n; i++) {
    await db.insert(llmCallLog).values({
      id: crypto.randomUUID(),
      worldId: world.id,
      userId: world.userId,
      timelineId: meta.timelineId,
      personId: meta.personId,
      purpose: meta.purpose,
      createdAt: now,
    })
  }
  await db.update(worlds).set({ callsToday, callsDay }).where(eq(worlds.id, world.id))
  return { ...world, callsToday, callsDay }
}

/** 预世界调用记账（蒸馏/骨架草稿：此时还没有世界可归账，记入用户桶） */
export async function recordUserCall(db: Db, userId: string, purpose: CallPurpose, n: number = 1): Promise<void> {
  const now = new Date().toISOString()
  for (let i = 0; i < n; i++) {
    await db.insert(llmCallLog).values({
      id: crypto.randomUUID(),
      worldId: null,
      userId,
      timelineId: null,
      personId: null,
      purpose,
      createdAt: now,
    })
  }
}

/** 该用户今日已发生的全部 LLM 调用（含预世界调用，用于 PREWORLD_DAILY_CAP） */
export async function userCallsToday(db: Db, userId: string, day: string = today()): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(llmCallLog)
    .where(and(eq(llmCallLog.userId, userId), gte(llmCallLog.createdAt, `${day}T00:00:00`)))
    .get()
  return row?.n ?? 0
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

/**
 * capped 世界换天自动恢复（tick 每拍开头调用）。
 * 换天清零原本只发生在 recordCall 内，而 capped 世界被 tick 排除、永远走不到记账——形成死锁；这里显式恢复。
 */
export async function recoverCappedWorlds(db: Db, day: string = today()): Promise<void> {
  await db
    .update(worlds)
    .set({ status: 'running', pauseReason: null, callsToday: 0, callsDay: day })
    .where(and(eq(worlds.status, 'capped'), ne(worlds.callsDay, day)))
}

/** 闲置判定（纯函数）：最后活动时间距 now 超过 days 天；null/无法解析视为"不可判定"→ 不归档 */
export function isIdleActivity(lastActivityIso: string | null, nowMs: number, days: number): boolean {
  if (!lastActivityIso) return false
  const t = Date.parse(lastActivityIso)
  if (!Number.isFinite(t)) return false
  return nowMs - t > days * 24 * 3600 * 1000
}

/**
 * 闲置自动归档（AI Town 的 archive 思路，tick 每拍开头调用）：
 * 长时间没有任何用户交互的 running 世界冻结为 archived（pauseReason='idle'），
 * 引擎天然排除 archived 世界——零 LLM 费用、数据完整保留，resume 解冻。
 * 只有 lastUserActivityAt 非空的世界会被归档（存量世界未回填，行为不变）。
 */
export async function archiveIdleWorlds(db: Db, cfg: BudgetConfig, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - cfg.idleArchiveDays * 24 * 3600 * 1000).toISOString()
  await db
    .update(worlds)
    .set({ status: 'archived', pauseReason: 'idle' })
    .where(and(eq(worlds.status, 'running'), isNotNull(worlds.lastUserActivityAt), lt(worlds.lastUserActivityAt, cutoff)))
}

/** 用户活动痕迹：聊天/注入/章节/创建/恢复等交互点刷新，闲置归档以此为据 */
export async function touchWorldActivity(db: Db, worldId: string, now: Date = new Date()): Promise<void> {
  await db.update(worlds).set({ lastUserActivityAt: now.toISOString() }).where(eq(worlds.id, worldId))
}
