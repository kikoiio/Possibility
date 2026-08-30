import { Hono } from 'hono'
import { or, eq } from 'drizzle-orm'
import { createDb } from '../db/client'
import { timelines, worlds } from '../db/schema'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { runTick } from './tick'
import type { Env } from '../index'

export const engineRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

/** 引擎节拍：pinger 以共享密钥调用（非用户登录态）；单飞进行中时返回 409 */
engineRoutes.post('/tick', async (c) => {
  const secret = c.req.header('x-engine-secret')
  if (!c.env.ENGINE_TICK_SECRET || secret !== c.env.ENGINE_TICK_SECRET) {
    return c.json({ error: '引擎密钥无效' }, 403)
  }
  const db = createDb(c.env.DB)
  const summary = await runTick(c.env, db)
  if (summary === null) return c.json({ error: '上一拍仍在进行' }, 409)
  return c.json(summary)
})

/** 引擎运行状态（N7 可观测性）：本人世界 + 演示世界的时钟/节拍/用量/暂停原因 */
engineRoutes.get('/status', authMiddleware, async (c) => {
  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const myWorlds = await db
    .select()
    .from(worlds)
    .where(or(eq(worlds.userId, userId), eq(worlds.isDemo, true)))
    .all()
  const out = []
  for (const w of myWorlds) {
    const tls = await db.select().from(timelines).where(eq(timelines.worldId, w.id)).all()
    out.push({
      id: w.id,
      name: w.name,
      isDemo: w.isDemo,
      status: w.status,
      pauseReason: w.pauseReason,
      callsToday: w.callsToday,
      callsDay: w.callsDay,
      timelines: tls.map((t) => ({
        id: t.id,
        status: t.status,
        simNow: t.simNow,
        lastRealTickAt: t.lastRealTickAt,
      })),
    })
  }
  return c.json({ worlds: out })
})
