import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { worlds } from '../db/schema'
import { capWorld, dailyCapHit, recordCall, userCallsToday, type BudgetConfig } from './budget'
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
 * 任何会烧 LLM 调用的地方分两步——调用前先 gateWorld/gateUser，调用后 settleWorld。
 * 杜绝"只记账不查顶 / 只查顶不记账"的旁路。
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
    await capWorld(db, world.id)
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

/** 事后结算：按实际调用数记账，触顶当场封板；返回最新 world 行（调用方后续判断用） */
export async function settleWorld(
  db: Db,
  world: World,
  meta: { timelineId: string | null; personId: string | null; purpose: CallPurpose },
  n: number,
  cfg: BudgetConfig,
): Promise<World> {
  const updated = await recordCall(db, world, meta, n)
  if (dailyCapHit(updated, cfg)) await capWorld(db, updated.id)
  return updated
}
