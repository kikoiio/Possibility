import { eq } from 'drizzle-orm'
import type { Db } from './client'
import { worlds } from './schema'
import { DEFAULT_WORLD_LOCATIONS } from '../worlds/defaults'

export interface MigrateP2Result {
  worldsUpdated: number
  details: { locations: number; callsDay: number; status: number }
}

/**
 * 阶段二数据迁移（N4：幂等、不丢数据、可重跑）。
 * schema 迁移（0001/0002）已处理列级默认值，这里补齐行级内容：
 * - locationsJson 为空的旧世界 → 默认 3 地点
 * - status 异常 → paused（D14：旧世界不自动开跑，主人手动 resume）
 * - callsToday/callsDay 初始化（换天清零的水位）
 */
export async function migratePhase2Data(db: Db): Promise<MigrateP2Result> {
  const today = new Date().toISOString().slice(0, 10)
  const details = { locations: 0, callsDay: 0, status: 0 }
  let worldsUpdated = 0

  const all = await db.select().from(worlds).all()
  for (const w of all) {
    const patch: Partial<typeof worlds.$inferInsert> = {}

    let locationsEmpty = false
    try {
      locationsEmpty = (JSON.parse(w.locationsJson || '[]') as unknown[]).length === 0
    } catch {
      locationsEmpty = true
    }
    if (locationsEmpty) {
      patch.locationsJson = JSON.stringify(DEFAULT_WORLD_LOCATIONS)
      details.locations++
    }
    if (w.status !== 'running' && w.status !== 'paused' && w.status !== 'capped') {
      patch.status = 'paused'
      details.status++
    }
    if (!w.callsDay) {
      patch.callsDay = today
      details.callsDay++
    }

    if (Object.keys(patch).length) {
      await db.update(worlds).set(patch).where(eq(worlds.id, w.id))
      worldsUpdated++
    }
  }

  return { worldsUpdated, details }
}
