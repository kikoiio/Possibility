import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { worlds } from '../db/schema'
import { capWorld, dailyCapHit, reserveWorldCall, reserveUserCall, userCallsToday, type BudgetConfig, type CallMeta } from './budget'
import type { CallPurpose } from './steps/types'

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
  if (world.status !== 'running') {
    return { ok: false, status: 409, error: `世界${STATUS_LABEL[world.status] ?? world.status}，恢复后才能继续` }
  }
  if (dailyCapHit(world, cfg)) {
    await capWorld(db, world.id, cfg)
    return { ok: false, status: 429, error: '世界已达今日调用上限，次日自动恢复' }
  }
  return { ok: true, world }
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
export type Reservation = (() => Promise<void>) & { readonly calls: number }

function reservation(admit: () => Promise<void>, tick?: TickBudget): Reservation {
  let calls = 0
  return Object.defineProperty(async () => {
    if (tick && tick.used >= tick.limit) throw new BudgetRefusal('本拍调用预算已用完')
    if (tick) tick.used++
    try {
      await admit()
      calls++
    } catch (error) {
      if (tick) tick.used--
      throw error
    }
  }, 'calls', { get: () => calls }) as Reservation
}

export function worldReservation(db: Db, worldId: string, cfg: BudgetConfig, meta: CallMeta, tick?: TickBudget): Reservation {
  return reservation(async () => {
    if (await reserveWorldCall(db, worldId, cfg, meta)) return
    const gate = await gateWorld(db, worldId, cfg)
    if (!gate.ok) throw new BudgetRefusal(gate.error, gate.status)
    throw new BudgetRefusal('世界调用预算不足，请稍后再试')
  }, tick)
}

export function userReservation(db: Db, userId: string, cfg: BudgetConfig, purpose: CallPurpose): Reservation {
  return reservation(async () => {
    if (!await reserveUserCall(db, userId, cfg, purpose)) {
      throw new BudgetRefusal(`创建类调用已达今日上限（${cfg.preworldDailyCap} 次），次日自动恢复`)
    }
  })
}
