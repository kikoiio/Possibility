import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { createDb } from '../db/client'
import { timelines, worlds } from '../db/schema'
import type { Env } from '../index'
import { createD1Native2dRepository } from './repository'
import { isNative2dScope, type Native2dLayout, type Native2dScope } from './schema'

export const native2dRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
native2dRoutes.use('/worlds/:worldId/native2d/layout', authMiddleware)

async function ownedScope(db: ReturnType<typeof createDb>, worldId: string, timelineId: string, userId: string) {
  const world = await db.select().from(worlds).where(and(eq(worlds.id, worldId), eq(worlds.userId, userId))).get()
  if (!world) return { kind: 'missing' as const }
  const timeline = await db.select().from(timelines).where(and(
    eq(timelines.id, timelineId), eq(timelines.worldId, worldId),
  )).get()
  if (!timeline) return { kind: 'missing' as const }
  return { kind: 'ok' as const, world, timeline }
}

function toResponse(revision: Awaited<ReturnType<ReturnType<typeof createD1Native2dRepository>['read']>>) {
  if (!revision) return { layout: null }
  return { layout: {
    sceneId: revision.sceneId,
    formatVersion: revision.layout.metadata.sceneVersion,
    placements: revision.layout.placements,
    version: revision.version,
    contentHash: revision.contentHash,
  } }
}

native2dRoutes.get('/worlds/:worldId/native2d/layout', async c => {
  const worldId = c.req.param('worldId')
  const timelineId = c.req.query('timelineId') ?? ''
  const sceneId = c.req.query('sceneId') ?? ''
  if (!timelineId || !sceneId) return c.json({ error: 'timelineId 和 sceneId 必填', errorCode: 'invalid_scope' }, 400)
  const db = createDb(c.env.DB)
  const scopeResult = await ownedScope(db, worldId, timelineId, c.get('user').id)
  if (scopeResult.kind !== 'ok') return c.json({ error: '世界或时间线不存在', errorCode: 'not_found' }, 404)
  const scope: Native2dScope = { worldId, timelineId, sceneId }
  const revision = await createD1Native2dRepository(db).read(scope)
  return c.json(toResponse(revision))
})

native2dRoutes.put('/worlds/:worldId/native2d/layout', async c => {
  const worldId = c.req.param('worldId')
  const timelineId = c.req.query('timelineId') ?? ''
  const sceneId = c.req.query('sceneId') ?? ''
  if (!timelineId || !sceneId) return c.json({ error: 'timelineId 和 sceneId 必填', errorCode: 'invalid_scope' }, 400)
  const db = createDb(c.env.DB)
  const scopeResult = await ownedScope(db, worldId, timelineId, c.get('user').id)
  if (scopeResult.kind !== 'ok') return c.json({ error: '世界或时间线不存在', errorCode: 'not_found' }, 404)
  if (scopeResult.world.isDemo) return c.json({ error: '公开演示世界不能保存 2D 布局', errorCode: 'read_only' }, 403)
  if (scopeResult.timeline.status !== 'active') return c.json({ error: '归档时间线只读', errorCode: 'archived_read_only' }, 409)
  const body = await c.req.json<{ expectedVersion?: unknown; requestId?: unknown; layout?: unknown }>().catch(() => null)
  if (!body || !Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 0
    || typeof body.requestId !== 'string' || !body.requestId.trim() || body.requestId.length > 128
    || !body.layout || typeof body.layout !== 'object') {
    return c.json({ error: '布局保存请求无效', errorCode: 'invalid_request' }, 400)
  }
  const layout = body.layout as Native2dLayout
  if (!isNative2dScope(layout.metadata)
    || layout.metadata.worldId !== worldId || layout.metadata.timelineId !== timelineId || layout.metadata.sceneId !== sceneId) {
    return c.json({ error: '布局 scope 与目标世界/时间线不一致', errorCode: 'invalid_scope' }, 400)
  }
  const result = await createD1Native2dRepository(db).save({
    worldId, timelineId, sceneId,
    expectedVersion: body.expectedVersion as number,
    requestId: body.requestId,
    layout,
  })
  if (!result.ok) {
    if (result.kind === 'conflict') return c.json({ error: result.message, errorCode: result.code, head: result.head }, 409)
    return c.json({ error: result.message, errorCode: 'invalid_layout', validation: result.validation }, 400)
  }
  return c.json({ ...toResponse(result.revision), replayed: result.kind === 'replayed' })
})
