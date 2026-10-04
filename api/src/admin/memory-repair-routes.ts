import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { createDb } from '../db/client'
import { residentMemoryRepairRuns, timelines, worldPersons, worlds } from '../db/schema'
import { repairResidentTimelineMemories } from '../agent/memory-repair'
import type { Env } from '../index'

export const memoryRepairRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
memoryRepairRoutes.use('*', authMiddleware)

memoryRepairRoutes.post('/memory-repair', async c => {
  if (c.get('user').role !== 'admin') return c.json({ error: '仅管理员可操作记忆重建' }, 403)
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: '请求参数无效' }, 400)
  const input = body as Record<string, unknown>
  if (typeof input.worldId !== 'string' || !input.worldId.trim()
    || typeof input.timelineId !== 'string' || !input.timelineId.trim()
    || typeof input.personId !== 'string' || !input.personId.trim()
    || typeof input.batchSize !== 'number' || !Number.isInteger(input.batchSize)
    || input.batchSize < 1 || input.batchSize > 50) {
    return c.json({ error: 'worldId、timelineId、personId 必须有效，batchSize 范围为 1–50' }, 400)
  }
  const db = createDb(c.env.DB)
  const scope = await db.select({ timelineId: timelines.id })
    .from(timelines)
    .innerJoin(worlds, eq(timelines.worldId, worlds.id))
    .innerJoin(worldPersons, eq(worldPersons.worldId, worlds.id))
    .where(and(eq(worlds.id, input.worldId), eq(timelines.id, input.timelineId), eq(worldPersons.personId, input.personId)))
    .get()
  if (!scope) return c.json({ error: '世界、时间线或居民范围无效' }, 404)
  try {
    const run = await repairResidentTimelineMemories(db, {
      worldId: input.worldId, timelineId: input.timelineId, personId: input.personId, batchSize: input.batchSize,
    })
    return c.json(run)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '记忆重建失败' }, 500)
  }
})

memoryRepairRoutes.get('/memory-repair/:runId', async c => {
  if (c.get('user').role !== 'admin') return c.json({ error: '仅管理员可读取记忆重建状态' }, 403)
  const db = createDb(c.env.DB)
  const run = await db.select().from(residentMemoryRepairRuns)
    .where(eq(residentMemoryRepairRuns.id, c.req.param('runId'))).get()
  return run ? c.json(run) : c.json({ error: '重建任务不存在' }, 404)
})
