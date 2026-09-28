import { Hono } from 'hono'
import { accessMiddleware } from '../access/middleware'
import type { AccessVariables } from '../access/types'
import { createDb } from '../db/client'
import type { Env } from '../index'
import { loadMapBootstrapForAccess } from './bootstrap'
import { readGuestMapResume, readMostRecentMapWorld, saveGuestMapResume, saveMapResume, type MapMode } from './resume'

export const mapRoutes = new Hono<{ Bindings: Env; Variables: AccessVariables }>()
mapRoutes.use('*', accessMiddleware)
mapRoutes.get('/map/resume/recent', async c => {
  const access = c.get('access')
  if (access.kind === 'user') return c.json(await readMostRecentMapWorld(createDb(c.env.DB), access.userId))
  if (access.kind === 'guest') return c.json(await readGuestMapResume(createDb(c.env.DB), access.sessionId))
  return c.json(null)
})
mapRoutes.get('/worlds/:worldId/map/bootstrap', async c => {
  const timelineId = c.req.query('timelineId')
  try {
    const result = await loadMapBootstrapForAccess(createDb(c.env.DB), c.req.param('worldId'), c.get('access'), timelineId)
    return result ? c.json(result) : c.json({ error: '世界或时间线不存在' }, 404)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '地图启动数据读取失败' }, 500)
  }
})
mapRoutes.put('/worlds/:worldId/map/resume', async c => {
  const body = await c.req.json<{ timelineId?: string; spaceId?: string; mode?: MapMode }>().catch(() => null)
  if (!body?.timelineId || !body.spaceId || !['create', 'life', 'possibility'].includes(body.mode ?? '')) return c.json({ error: '恢复位置参数不完整' }, 400)
  const access = c.get('access')
  const saved = access.kind === 'user'
    ? await saveMapResume(createDb(c.env.DB), { userId: access.userId, worldId: c.req.param('worldId'), timelineId: body.timelineId, spaceId: body.spaceId, mode: body.mode! })
    : access.kind === 'guest'
      ? await saveGuestMapResume(createDb(c.env.DB), { sessionId: access.sessionId, worldId: c.req.param('worldId'), timelineId: body.timelineId, spaceId: body.spaceId, mode: body.mode! })
      : false
  return saved ? c.json({ ok: true }) : c.json({ error: '世界、时间线或空间不存在' }, 404)
})
