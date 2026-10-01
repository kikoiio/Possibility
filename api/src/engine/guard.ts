import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { demoBaselines, timelines, universeEvidence, worlds } from '../db/schema'
import { capGlobalWorlds, globalBudgetExceeded, reserveWorldCall, reserveUserCall, settleCallReceipt, userCallsToday,
  type BudgetConfig, type CallMeta, type ReceiptDetails, type ReceiptStatus } from './budget'
import type { CallPurpose } from './steps/types'
import { WorldStateError } from '../world-state/types'

type World = typeof worlds.$inferSelect

export interface GateRefusal {
  ok: false
  status: 400 | 404 | 409 | 429 | 502 // 建议 HTTP 状态码（Hono c.json 要求字面量联合类型）
  error: string // 用户可读的中文原因
}

const STATUS_LABEL: Record<string, string> = {
  paused: '已暂停',
  capped: '已达今日调用上限（次日自动恢复）',
  archived: '已归档（冻结可读）',
}

/**
 * 统一 LLM 出口闸门（护栏闭环）：
 * gateWorld/gateUser 只用于提早返回友好错误；真正的原子闸门在每次 fetch 前的 reservation。
 */

/** 世界级出口：世界必须 running 且未触日顶；触顶当场封板并拒绝 */
export async function gateWorld(
  db: Db,
  worldId: string,
  cfg: BudgetConfig,
): Promise<{ ok: true; world: World } | GateRefusal> {
  const world = await db.select().from(worlds).where(eq(worlds.id, worldId)).get()
  if (!world) return { ok: false, status: 404, error: '世界不存在' }
  const baseline = await db.select({ id: demoBaselines.id }).from(demoBaselines)
    .where(and(eq(demoBaselines.worldId, worldId), eq(demoBaselines.status, 'active'))).get()
  if (baseline) return { ok: false, status: 409, error: '公共演示基线只读，请先进入访客体验副本' }
  if (world.status !== 'running') {
    return { ok: false, status: 409, error: `世界${STATUS_LABEL[world.status] ?? world.status}，恢复后才能继续` }
  }
  if (await globalBudgetExceeded(db, world.userId)) {
    await capGlobalWorlds(db, world.userId)
    return { ok: false, status: 429, error: '已达今日全局调用预算，可在设置页提高预算' }
  }
  return { ok: true, world }
}

/** Fail-closed gate shared by user routes, engine paths, and final commits. */
export async function gateUniverseWrite(
  db: Db,
  worldId: string,
  timelineId: string,
): Promise<{ ok: true; world: World; timeline: typeof timelines.$inferSelect } | GateRefusal> {
  const [world, timeline, evidence] = await Promise.all([
    db.select().from(worlds).where(eq(worlds.id, worldId)).get(),
    db.select().from(timelines).where(and(eq(timelines.id, timelineId), eq(timelines.worldId, worldId))).get(),
    db.select().from(universeEvidence).where(eq(universeEvidence.timelineId, timelineId)).get(),
  ])
  if (!world) return { ok: false, status: 404, error: '世界不存在' }
  if (!timeline) return { ok: false, status: 404, error: '时间线不存在' }
  const baseline = await db.select({ id: demoBaselines.id }).from(demoBaselines)
    .where(and(eq(demoBaselines.worldId, worldId), eq(demoBaselines.status, 'active'))).get()
  if (baseline) return { ok: false, status: 409, error: '公共演示基线只读，请先进入访客体验副本' }
  if (evidence?.level !== 'complete') {
    return { ok: false, status: 409, error: '该宇宙的历史证据尚不完整，目前仅可读取' }
  }
  if (world.status !== 'running') {
    return { ok: false, status: 409, error: `世界${STATUS_LABEL[world.status] ?? world.status}，恢复后才能继续` }
  }
  if (timeline.status !== 'active') {
    return { ok: false, status: 404, error: '时间线不存在或已归档' }
  }
  return { ok: true, world, timeline }
}

export async function requireWritableUniverse(db: Db, worldId: string, timelineId: string) {
  const gate = await gateUniverseWrite(db, worldId, timelineId)
  if (!gate.ok) throw new WorldStateError(gate.error, gate.status === 404 ? 404 : 409)
  return gate
}

/** 预世界出口（蒸馏/骨架草稿：尚无世界可归账）：按用户当日总额限制 */
export async function gateUser(db: Db, userId: string, cfg: BudgetConfig): Promise<{ ok: true } | GateRefusal> {
  const used = await userCallsToday(db, userId)
  if (used >= cfg.preworldDailyCap) {
    return { ok: false, status: 429, error: `创建类调用已达今日上限（${cfg.preworldDailyCap} 次），次日自动恢复` }
  }
  return { ok: true }
}

export class BudgetRefusal extends Error {
  constructor(message: string, readonly status: GateRefusal['status'] = 429) {
    super(message)
    this.name = 'BudgetRefusal'
  }
}

/** Shared across all timelines, director calls, steps and retries of one world's tick.
 * Increment before awaiting SQL so concurrent callers cannot overbook this tick.
 */
export interface TickBudget { used: number; limit: number }
export type Reservation = ((details?: ReceiptDetails) => Promise<string>) & {
  readonly calls: number
  settle(receiptId: string, status: ReceiptStatus, errorCode?: string | null): Promise<void>
}

/** Auditable inventory of every autonomous model entry owned by the engine. */
export const INTERNAL_ENGINE_CALL_PURPOSES = [
  'director', 'schedule', 'beat', 'dialogue_turn', 'injection', 'summary', 'voxel_distill',
] as const satisfies readonly CallPurpose[]

function reservation(db: Db, admit: (details?: ReceiptDetails) => Promise<string>, tick?: TickBudget): Reservation {
  let calls = 0
  const reserve = async (details?: ReceiptDetails) => {
    if (tick && tick.used >= tick.limit) throw new BudgetRefusal('本拍调用预算已用完')
    if (tick) tick.used++
    try {
      const receiptId = await admit(details)
      calls++
      return receiptId
    } catch (error) {
      if (tick) tick.used--
      throw error
    }
  }
  Object.defineProperty(reserve, 'calls', { get: () => calls })
  Object.defineProperty(reserve, 'settle', { value: async (
    receiptId: string,
    status: ReceiptStatus,
    errorCode: string | null = null,
  ) => {
    if (!await settleCallReceipt(db, receiptId, status, errorCode)) {
      throw new Error(`LLM receipt ${receiptId} is already terminal or missing`)
    }
  } })
  return reserve as Reservation
}

export function worldReservation(db: Db, worldId: string, cfg: BudgetConfig, meta: CallMeta, tick?: TickBudget): Reservation {
  return reservation(db, async (details) => {
    if (!meta.timelineId) throw new BudgetRefusal('模型调用缺少时间线归属', 409)
    const universe = await gateUniverseWrite(db, worldId, meta.timelineId)
    if (!universe.ok) throw new BudgetRefusal(universe.error, universe.status)
    const receiptId = await reserveWorldCall(db, worldId, cfg, meta, details)
    if (receiptId) return receiptId
    const gate = await gateWorld(db, worldId, cfg)
    if (!gate.ok) throw new BudgetRefusal(gate.error, gate.status)
    throw new BudgetRefusal('世界调用预算不足，请稍后再试')
  }, tick)
}

export function userReservation(db: Db, userId: string, cfg: BudgetConfig, purpose: CallPurpose): Reservation {
  return reservation(db, async (details) => {
    const receiptId = await reserveUserCall(db, userId, cfg, purpose, details)
    if (!receiptId) {
      throw new BudgetRefusal(`创建类调用已达今日上限（${cfg.preworldDailyCap} 次），次日自动恢复`)
    }
    return receiptId
  })
}
