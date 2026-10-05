import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  inspectSceneCompatibility,
  preflightSceneEdit,
  createCompatibilityDraft,
  readCompatibilityDraft,
  cancelCompatibilityDraft,
  confirmCompatibility,
  readCompatibilityRequest,
  recoverCompatibilityRequest,
} from './service'
import { createDb, type Db } from '../../db/client'
import { authMiddleware, type AuthVariables } from '../../auth/middleware'
import { worlds } from '../../db/schema'
import type { Env } from '../../index'
import type { SceneCandidate, SceneTarget, StoredSceneDocument } from '@possibility/voxel-contract'
import { isSerializedVoxelDocument, isSerializedVoxelSpaces } from '@possibility/voxel-contract'
import { readSceneVersion } from '../repository'
import { loadWorldSceneBindings } from './context'
import {
  errorBody,
  inspectionError,
  isCandidate,
  isPurpose,
  parseQueryTarget,
  parseTarget,
  toDraftView,
  toRequestView,
} from './http'

export const compatibilityRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
// 只拦截兼容端点自身;挂到 /api 后 '*' 会把访客等其他请求一并 401(已发生过的回归)。
compatibilityRoutes.use('/worlds/:worldId/scene/compatibility/*', authMiddleware)

type RouteContext = Context<{ Bindings: Env; Variables: AuthVariables }>

async function ownedWorld(db: Db, worldId: string, userId: string) {
  return await db.select().from(worlds).where(and(eq(worlds.id, worldId), eq(worlds.userId, userId))).get() ?? null
}

function fail(c: RouteContext, error: unknown) {
  const rawStatus = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : 400
  const status = [400, 401, 404, 409, 422, 500, 503].includes(rawStatus) ? rawStatus : 400
  const message = error instanceof Error ? error.message : '兼容处理失败'
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'storage-failure'
  return c.json(errorBody(code, message), status as 400 | 401 | 404 | 409 | 422 | 500 | 503)
}

async function ownerOr404(c: RouteContext, db: Db) {
  const worldId = c.req.param('worldId')
  if (!worldId) return null
  return await ownedWorld(db, worldId, c.get('user').id)
}

function spaceDocument(document: StoredSceneDocument, spaceId: string): unknown | null {
  if (isSerializedVoxelSpaces(document)) {
    const space = document.spaces.find(item => item.id === spaceId)
    return space ? space.document : null
  }
  return spaceId === 'single' && isSerializedVoxelDocument(document) ? document : null
}

compatibilityRoutes.get('/worlds/:worldId/scene/compatibility/inspection', async c => {
  const db = createDb(c.env.DB)
  const world = await ownerOr404(c, db)
  if (!world) return c.json(errorBody('world-unavailable', '世界不存在'), 404)
  const target = parseQueryTarget(c.req.query('version'))
  if (!target) return c.json(errorBody('request-mismatch', '场景版本无效'), 400)
  try {
    const bindings = await loadWorldSceneBindings(db, world.id)
    const result = await inspectSceneCompatibility(db, { worldId: world.id, target, access: { bindings } })
    return result.status === 'ready' ? c.json(result) : c.json(inspectionError(result), result.status === 'missing' ? 404 : 422)
  } catch (error) { return fail(c, error) }
})

compatibilityRoutes.post('/worlds/:worldId/scene/compatibility/preflight', async c => {
  const body = await c.req.json<{ candidate?: unknown }>().catch(() => null)
  if (!body || !isCandidate(body.candidate)) return c.json(errorBody('request-mismatch', '候选编辑格式无效'), 400)
  const db = createDb(c.env.DB)
  const world = await ownerOr404(c, db)
  if (!world) return c.json(errorBody('world-unavailable', '世界不存在'), 404)
  try {
    const bindings = await loadWorldSceneBindings(db, world.id)
    return c.json(await preflightSceneEdit(db, { worldId: world.id, candidate: body.candidate as SceneCandidate, access: { bindings } }))
  } catch (error) { return fail(c, error) }
})

compatibilityRoutes.post('/worlds/:worldId/scene/compatibility/drafts', async c => {
  const body = await c.req.json<{ draftRequestId?: unknown; purpose?: unknown; target?: unknown; expectedCurrentVersion?: unknown }>().catch(() => null)
  const target = parseTarget(body?.target)
  if (!body || typeof body.draftRequestId !== 'string' || !body.draftRequestId || !isPurpose(body.purpose)
    || !target || !Number.isSafeInteger(body.expectedCurrentVersion) || (body.purpose === 'repair-current' && target.kind !== 'current')
    || (body.purpose === 'restore-history' && target.kind !== 'history')) {
    return c.json(errorBody('request-mismatch', '草稿参数不完整或目标不匹配'), 400)
  }
  const db = createDb(c.env.DB)
  const world = await ownerOr404(c, db)
  if (!world) return c.json(errorBody('world-unavailable', '世界不存在'), 404)
  try {
    const bindings = await loadWorldSceneBindings(db, world.id)
    const draft = await createCompatibilityDraft(db, {
      worldId: world.id,
      actorKey: c.get('user').id,
      draftRequestId: body.draftRequestId,
      purpose: body.purpose,
      target: target as SceneTarget,
      expectedCurrentVersion: body.expectedCurrentVersion as number,
      access: { bindings },
    })
    return c.json(toDraftView(draft))
  } catch (error) { return fail(c, error) }
})

compatibilityRoutes.get('/worlds/:worldId/scene/compatibility/drafts/:draftId', async c => {
  const db = createDb(c.env.DB); const world = await ownerOr404(c, db)
  if (!world) return c.json(errorBody('world-unavailable', '世界不存在'), 404)
  try {
    const draft = await readCompatibilityDraft(db, { worldId: world.id, draftId: c.req.param('draftId'), actorKey: c.get('user').id })
    return c.json(toDraftView(draft))
  } catch (error) { return fail(c, error) }
})

compatibilityRoutes.post('/worlds/:worldId/scene/compatibility/drafts/:draftId/cancel', async c => {
  const db = createDb(c.env.DB); const world = await ownerOr404(c, db)
  if (!world) return c.json(errorBody('world-unavailable', '世界不存在'), 404)
  try {
    const draft = await cancelCompatibilityDraft(db, { worldId: world.id, draftId: c.req.param('draftId'), actorKey: c.get('user').id })
    return c.json(toDraftView(draft))
  } catch (error) { return fail(c, error) }
})

compatibilityRoutes.post('/worlds/:worldId/scene/compatibility/confirm', async c => {
  const body = await c.req.json<{ draftId?: unknown; requestId?: unknown; expectedCurrentVersion?: unknown; expectedAttempt?: unknown }>().catch(() => null)
  if (!body || typeof body.draftId !== 'string' || typeof body.requestId !== 'string' || !body.draftId || !body.requestId
    || !Number.isSafeInteger(body.expectedCurrentVersion) || !Number.isSafeInteger(body.expectedAttempt)) return c.json(errorBody('request-mismatch', '确认参数不完整'), 400)
  const db = createDb(c.env.DB); const world = await ownerOr404(c, db)
  if (!world) return c.json(errorBody('world-unavailable', '世界不存在'), 404)
  try {
    const bindings = await loadWorldSceneBindings(db, world.id)
    const result = await confirmCompatibility(db, {
      worldId: world.id,
      actorKey: c.get('user').id,
      draftId: body.draftId,
      requestId: body.requestId,
      expectedCurrentVersion: body.expectedCurrentVersion as number,
      expectedAttempt: body.expectedAttempt as number,
      access: { bindings },
    })
    return c.json(toRequestView(result))
  } catch (error) { return fail(c, error) }
})

compatibilityRoutes.get('/worlds/:worldId/scene/compatibility/requests/:requestId', async c => {
  const db = createDb(c.env.DB); const world = await ownerOr404(c, db)
  if (!world) return c.json(errorBody('world-unavailable', '世界不存在'), 404)
  try {
    const result = await readCompatibilityRequest(db, { worldId: world.id, requestId: c.req.param('requestId'), actorKey: c.get('user').id })
    return c.json(toRequestView(result))
  } catch (error) { return fail(c, error) }
})

compatibilityRoutes.post('/worlds/:worldId/scene/compatibility/requests/:requestId/recover', async c => {
  const body = await c.req.json<{ draftId?: unknown; expectedCurrentVersion?: unknown; expectedAttempt?: unknown }>().catch(() => null)
  if (!body || typeof body.draftId !== 'string' || !body.draftId || !Number.isSafeInteger(body.expectedCurrentVersion) || !Number.isSafeInteger(body.expectedAttempt)) {
    return c.json(errorBody('request-mismatch', '恢复参数不完整'), 400)
  }
  const db = createDb(c.env.DB); const world = await ownerOr404(c, db)
  if (!world) return c.json(errorBody('world-unavailable', '世界不存在'), 404)
  try {
    const bindings = await loadWorldSceneBindings(db, world.id)
    const result = await recoverCompatibilityRequest(db, {
      worldId: world.id,
      actorKey: c.get('user').id,
      draftId: body.draftId,
      requestId: c.req.param('requestId'),
      expectedCurrentVersion: body.expectedCurrentVersion as number,
      expectedAttempt: body.expectedAttempt as number,
      access: { bindings },
    })
    return c.json(toRequestView(result))
  } catch (error) { return fail(c, error) }
})

compatibilityRoutes.get('/worlds/:worldId/scene/compatibility/drafts/:draftId/spaces/:spaceId', async c => {
  const db = createDb(c.env.DB); const world = await ownerOr404(c, db)
  if (!world) return c.json(errorBody('world-unavailable', '世界不存在'), 404)
  try {
    const draft = await readCompatibilityDraft(db, { worldId: world.id, draftId: c.req.param('draftId'), actorKey: c.get('user').id })
    const document = draft.candidate ? spaceDocument(draft.candidate, c.req.param('spaceId')) : null
    if (!document) return c.json(errorBody('scene-missing', '草稿候选没有该空间'), 404)
    return c.json({ spaceId: c.req.param('spaceId'), side: 'candidate', document })
  } catch (error) { return fail(c, error) }
})

compatibilityRoutes.get('/worlds/:worldId/scene/compatibility/source/:version/spaces/:spaceId', async c => {
  const db = createDb(c.env.DB); const world = await ownerOr404(c, db)
  if (!world) return c.json(errorBody('world-unavailable', '世界不存在'), 404)
  const version = Number(c.req.param('version'))
  if (!Number.isSafeInteger(version) || version <= 0) return c.json(errorBody('request-mismatch', '场景版本无效'), 400)
  try {
    const stored = await readSceneVersion(db, world.id, version)
    const document = stored ? spaceDocument(stored.document, c.req.param('spaceId')) : null
    if (!document) return c.json(errorBody('scene-missing', '来源版本没有该空间'), 404)
    return c.json({ spaceId: c.req.param('spaceId'), side: 'source', version, document })
  } catch (error) { return fail(c, error) }
})

export default compatibilityRoutes
