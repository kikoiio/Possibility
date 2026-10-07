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
import { demoBaselines, timelines, worlds } from '../../db/schema'
import type { Env } from '../../index'
import type { SceneCandidate, SceneTarget, StoredSceneDocument } from '@possibility/voxel-contract'
import { isSerializedVoxelDocument, isSerializedVoxelSpaces } from '@possibility/voxel-contract'
import { listTimelineSceneHistory, readSceneVersion, type TimelineSceneScope } from '../repository'
import { loadWorldSceneBindings } from './context'
import {
  errorBody,
  inspectionError,
  isCandidate,
  isPurpose,
  parseQueryTarget,
  parseDraftPageQuery,
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

async function activeDemoBaseline(db: Db, worldId: string) {
  return await db.select().from(demoBaselines).where(and(
    eq(demoBaselines.worldId, worldId), eq(demoBaselines.status, 'active'),
  )).get() ?? null
}

function canMaintainBaseline(
  world: NonNullable<Awaited<ReturnType<typeof ownedWorld>>>,
  user: AuthVariables['user'],
): boolean {
  return world.isDemo && world.userId === user.id && user.role === 'admin'
}

function baselineWriteDenied(c: RouteContext) {
  return c.json(errorBody('world-unavailable', '公共演示基线仅管理员物主可维护'), 403)
}

function fail(c: RouteContext, error: unknown) {
  const candidateCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null
  const knownCodes = new Set([
    'basis-changed', 'context-unavailable', 'draft-blocked', 'draft-unavailable', 'format-unsupported',
    'repair-not-required', 'request-mismatch', 'scene-changed', 'scene-corrupt', 'scene-invalid',
    'scene-missing', 'service-busy', 'storage-failure', 'validation-incomplete', 'world-unavailable',
  ])
  const code = candidateCode && knownCodes.has(candidateCode) ? candidateCode : 'storage-failure'
  const message = code === 'storage-failure'
    ? '场景兼容处理遇到存储故障；提交结果可能未知，请先查询请求状态。'
    : error instanceof Error ? error.message : '兼容处理失败'
  const rawStatus = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
    ? error.status
    : code === 'storage-failure' ? 500 : 400
  const status = [400, 401, 404, 409, 422, 500, 503].includes(rawStatus) ? rawStatus : 500
  return c.json(errorBody(code, message), status as 400 | 401 | 404 | 409 | 422 | 500 | 503)
}

async function ownerOr404(c: RouteContext, db: Db) {
  const worldId = c.req.param('worldId')
  if (!worldId) return null
  return await ownedWorld(db, worldId, c.get('user').id)
}

async function resolveScope(
  c: RouteContext,
  db: Db,
  worldId: string,
  input: Record<string, unknown> = {},
  requireActive = false,
) {
  const queryTimelineId = c.req.query('timelineId')
  const bodyTimelineId = typeof input.timelineId === 'string' ? input.timelineId : undefined
  if (input.timelineId !== undefined && typeof input.timelineId !== 'string') {
    return { error: c.json(errorBody('request-mismatch', '时间线参数无效'), 400) } as const
  }
  if (queryTimelineId && bodyTimelineId && queryTimelineId !== bodyTimelineId) {
    return { error: c.json(errorBody('request-mismatch', '时间线参数不一致'), 400) } as const
  }
  const timelineId = queryTimelineId ?? bodyTimelineId
  if (timelineId !== undefined && (!timelineId || timelineId.length > 200)) {
    return { error: c.json(errorBody('request-mismatch', '时间线参数无效'), 400) } as const
  }
  if (input.representation !== undefined && typeof input.representation !== 'string') {
    return { error: c.json(errorBody('request-mismatch', '表现参数无效'), 400) } as const
  }
  if (input.spaceId !== undefined && typeof input.spaceId !== 'string') {
    return { error: c.json(errorBody('request-mismatch', '空间参数无效'), 400) } as const
  }
  const queryRepresentation = c.req.query('representation')
  const bodyRepresentation = input.representation as string | undefined
  const querySpaceId = c.req.query('spaceId')
  const bodySpaceId = input.spaceId as string | undefined
  if ((queryRepresentation && bodyRepresentation && queryRepresentation !== bodyRepresentation)
    || (querySpaceId && bodySpaceId && querySpaceId !== bodySpaceId)) {
    return { error: c.json(errorBody('request-mismatch', '场景表现或空间参数不一致'), 400) } as const
  }
  const representationValue = queryRepresentation ?? bodyRepresentation
  const spaceIdValue = querySpaceId ?? bodySpaceId
  if (spaceIdValue !== undefined && (!spaceIdValue || spaceIdValue.length > 200)) {
    return { error: c.json(errorBody('request-mismatch', '空间参数无效'), 400) } as const
  }
  if (!timelineId) {
    if (representationValue !== undefined || spaceIdValue !== undefined) {
      return { error: c.json(errorBody('request-mismatch', '表现或空间参数需要时间线作用域'), 400) } as const
    }
    return { scope: undefined, spaceId: undefined, actorKey: c.get('user').id, status: undefined } as const
  }
  const representation = representationValue ?? 'voxel'
  if (representation !== 'voxel') {
    return { error: c.json(errorBody('format-unsupported', '此场景表现尚未接入时间线场景服务'), 422) } as const
  }
  const timeline = await db.select({ id: timelines.id, status: timelines.status }).from(timelines).where(and(
    eq(timelines.id, timelineId), eq(timelines.worldId, worldId),
  )).get()
  if (!timeline) return { error: c.json(errorBody('world-unavailable', '时间线不存在'), 404) } as const
  if (requireActive && timeline.status !== 'active') {
    return { error: c.json(errorBody('edit-forbidden', '归档时间线只读，请重新激活后再编辑'), 409) } as const
  }
  const scope: TimelineSceneScope = { worldId, timelineId, representation }
  const spaceId = spaceIdValue
  const actorKey = JSON.stringify({ userId: c.get('user').id, worldId, timelineId, representation, spaceId: spaceId ?? null })
  return { scope, spaceId, actorKey, status: timeline.status } as const
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
  const targetRevisionId = c.req.query('targetRevisionId')
  const target = parseQueryTarget(c.req.query('version'), targetRevisionId)
  if (!target) return c.json(errorBody('request-mismatch', '场景版本无效'), 400)
  try {
    const selected = await resolveScope(c, db, world.id)
    if (selected.error) return selected.error
    const bindings = await loadWorldSceneBindings(db, world.id, selected.scope, selected.spaceId)
    const result = await inspectSceneCompatibility(db, { worldId: world.id, target, access: { bindings, ...(selected.scope ? { scope: selected.scope } : {}), ...(selected.spaceId ? { spaceId: selected.spaceId } : {}) } })
    return result.status === 'ready' ? c.json(result) : c.json(inspectionError(result), result.status === 'missing' ? 404 : 422)
  } catch (error) { return fail(c, error) }
})

compatibilityRoutes.post('/worlds/:worldId/scene/compatibility/preflight', async c => {
  const body = await c.req.json<{ candidate?: unknown; timelineId?: unknown; representation?: unknown; spaceId?: unknown }>().catch(() => null)
  if (!body || !isCandidate(body.candidate)) return c.json(errorBody('request-mismatch', '候选编辑格式无效'), 400)
  const db = createDb(c.env.DB)
  const world = await ownerOr404(c, db)
  if (!world) return c.json(errorBody('world-unavailable', '世界不存在'), 404)
  try {
    const selected = await resolveScope(c, db, world.id, body as Record<string, unknown>, true)
    if (selected.error) return selected.error
    const bindings = await loadWorldSceneBindings(db, world.id, selected.scope, selected.spaceId)
    return c.json(await preflightSceneEdit(db, { worldId: world.id, candidate: body.candidate as SceneCandidate, access: { bindings, ...(selected.scope ? { scope: selected.scope } : {}), ...(selected.spaceId ? { spaceId: selected.spaceId } : {}) } }))
  } catch (error) { return fail(c, error) }
})

compatibilityRoutes.post('/worlds/:worldId/scene/compatibility/drafts', async c => {
  const body = await c.req.json<{ draftRequestId?: unknown; purpose?: unknown; target?: unknown; expectedCurrentVersion?: unknown; timelineId?: unknown; representation?: unknown; spaceId?: unknown }>().catch(() => null)
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
    const baseline = await activeDemoBaseline(db, world.id)
    const user = c.get('user')
    if (baseline && !canMaintainBaseline(world, user)) return baselineWriteDenied(c)
    const selected = await resolveScope(c, db, world.id, body as Record<string, unknown>, true)
    if (selected.error) return selected.error
    const bindings = await loadWorldSceneBindings(db, world.id, selected.scope, selected.spaceId)
    const draft = await createCompatibilityDraft(db, {
      worldId: world.id,
      actorKey: selected.actorKey,
      draftRequestId: body.draftRequestId,
      purpose: body.purpose,
      target: target as SceneTarget,
      expectedCurrentVersion: body.expectedCurrentVersion as number,
      access: { bindings, ...(selected.scope ? { scope: selected.scope } : {}), ...(selected.spaceId ? { spaceId: selected.spaceId } : {}) },
    })
    return c.json(toDraftView(draft))
  } catch (error) { return fail(c, error) }
})

compatibilityRoutes.get('/worlds/:worldId/scene/compatibility/drafts/:draftId', async c => {
  const page = parseDraftPageQuery({
    limit: c.req.query('limit'), offset: c.req.query('offset'),
    issuesOffset: c.req.query('issuesOffset'), changesOffset: c.req.query('changesOffset'),
  })
  if (!page) return c.json(errorBody('request-mismatch', '分页参数无效'), 400)
  const db = createDb(c.env.DB); const world = await ownerOr404(c, db)
  if (!world) return c.json(errorBody('world-unavailable', '世界不存在'), 404)
  try {
    const selected = await resolveScope(c, db, world.id)
    if (selected.error) return selected.error
    const draft = await readCompatibilityDraft(db, { worldId: world.id, draftId: c.req.param('draftId'), actorKey: selected.actorKey })
    return c.json(toDraftView(draft, page))
  } catch (error) { return fail(c, error) }
})

compatibilityRoutes.post('/worlds/:worldId/scene/compatibility/drafts/:draftId/cancel', async c => {
  const db = createDb(c.env.DB); const world = await ownerOr404(c, db)
  if (!world) return c.json(errorBody('world-unavailable', '世界不存在'), 404)
  try {
    const body = await c.req.json<{ timelineId?: unknown; representation?: unknown; spaceId?: unknown }>().catch(() => ({}))
    const selected = await resolveScope(c, db, world.id, body as Record<string, unknown>, true)
    if (selected.error) return selected.error
    const draft = await cancelCompatibilityDraft(db, { worldId: world.id, draftId: c.req.param('draftId'), actorKey: selected.actorKey })
    return c.json(toDraftView(draft))
  } catch (error) { return fail(c, error) }
})

compatibilityRoutes.post('/worlds/:worldId/scene/compatibility/confirm', async c => {
  const body = await c.req.json<{ draftId?: unknown; requestId?: unknown; expectedCurrentVersion?: unknown; expectedAttempt?: unknown; timelineId?: unknown; representation?: unknown; spaceId?: unknown }>().catch(() => null)
  if (!body || typeof body.draftId !== 'string' || typeof body.requestId !== 'string' || !body.draftId || !body.requestId
    || !Number.isSafeInteger(body.expectedCurrentVersion) || !Number.isSafeInteger(body.expectedAttempt)) return c.json(errorBody('request-mismatch', '确认参数不完整'), 400)
  const db = createDb(c.env.DB); const world = await ownerOr404(c, db)
  if (!world) return c.json(errorBody('world-unavailable', '世界不存在'), 404)
  try {
    const baseline = await activeDemoBaseline(db, world.id)
    const user = c.get('user')
    const mayWriteBaseline = Boolean(baseline && canMaintainBaseline(world, user))
    if (baseline && !mayWriteBaseline) return baselineWriteDenied(c)
    const selected = await resolveScope(c, db, world.id, body as Record<string, unknown>, true)
    if (selected.error) return selected.error
    const bindings = await loadWorldSceneBindings(db, world.id, selected.scope, selected.spaceId)
    const result = await confirmCompatibility(db, {
      worldId: world.id,
      actorKey: selected.actorKey,
      draftId: body.draftId,
      requestId: body.requestId,
      expectedCurrentVersion: body.expectedCurrentVersion as number,
      expectedAttempt: body.expectedAttempt as number,
      access: { bindings, ...(selected.scope ? { scope: selected.scope } : {}), ...(selected.spaceId ? { spaceId: selected.spaceId } : {}) },
      ...(mayWriteBaseline && baseline ? {
        allowBaseline: true,
        baselineUpdate: { baselineId: baseline.id },
      } : {}),
      authority: {
        sessionToken: c.req.header('Authorization')!.slice('Bearer '.length),
        ownerUserId: c.get('user').id,
        ...(mayWriteBaseline ? { adminUserId: user.id } : {}),
      },
    })
    return c.json(toRequestView(result))
  } catch (error) { return fail(c, error) }
})

compatibilityRoutes.get('/worlds/:worldId/scene/compatibility/requests/:requestId', async c => {
  const db = createDb(c.env.DB); const world = await ownerOr404(c, db)
  if (!world) return c.json(errorBody('world-unavailable', '世界不存在'), 404)
  try {
    const selected = await resolveScope(c, db, world.id)
    if (selected.error) return selected.error
    const bindings = await loadWorldSceneBindings(db, world.id, selected.scope, selected.spaceId)
    const result = await readCompatibilityRequest(db, { worldId: world.id, requestId: c.req.param('requestId'), actorKey: selected.actorKey, access: { bindings, ...(selected.scope ? { scope: selected.scope } : {}), ...(selected.spaceId ? { spaceId: selected.spaceId } : {}) } })
    return c.json(toRequestView(result))
  } catch (error) { return fail(c, error) }
})

compatibilityRoutes.post('/worlds/:worldId/scene/compatibility/requests/:requestId/recover', async c => {
  const body = await c.req.json<{ draftId?: unknown; expectedCurrentVersion?: unknown; expectedAttempt?: unknown; timelineId?: unknown; representation?: unknown; spaceId?: unknown }>().catch(() => null)
  if (!body || typeof body.draftId !== 'string' || !body.draftId || !Number.isSafeInteger(body.expectedCurrentVersion) || !Number.isSafeInteger(body.expectedAttempt)) {
    return c.json(errorBody('request-mismatch', '恢复参数不完整'), 400)
  }
  const db = createDb(c.env.DB); const world = await ownerOr404(c, db)
  if (!world) return c.json(errorBody('world-unavailable', '世界不存在'), 404)
  try {
    const selected = await resolveScope(c, db, world.id, body as Record<string, unknown>, true)
    if (selected.error) return selected.error
    const bindings = await loadWorldSceneBindings(db, world.id, selected.scope, selected.spaceId)
    const result = await recoverCompatibilityRequest(db, {
      worldId: world.id,
      actorKey: selected.actorKey,
      draftId: body.draftId,
      requestId: c.req.param('requestId'),
      expectedCurrentVersion: body.expectedCurrentVersion as number,
      expectedAttempt: body.expectedAttempt as number,
      access: { bindings, ...(selected.scope ? { scope: selected.scope } : {}), ...(selected.spaceId ? { spaceId: selected.spaceId } : {}) },
    })
    return c.json(toRequestView(result))
  } catch (error) { return fail(c, error) }
})

compatibilityRoutes.get('/worlds/:worldId/scene/compatibility/drafts/:draftId/spaces/:spaceId', async c => {
  const db = createDb(c.env.DB); const world = await ownerOr404(c, db)
  if (!world) return c.json(errorBody('world-unavailable', '世界不存在'), 404)
  try {
    const selected = await resolveScope(c, db, world.id)
    if (selected.error) return selected.error
    const draft = await readCompatibilityDraft(db, { worldId: world.id, draftId: c.req.param('draftId'), actorKey: selected.actorKey })
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
    const selected = await resolveScope(c, db, world.id)
    if (selected.error) return selected.error
    let stored
    if (selected.scope) {
      let cursor: string | null = null
      stored = null
      while (true) {
        const page = await listTimelineSceneHistory(db, selected.scope, { limit: 100, cursor })
        if (!page) break
        const targetRevisionId = c.req.query('targetRevisionId')
        const revision = targetRevisionId
          ? page.revisions.find(item => item.id === targetRevisionId && item.version === version)
          : page.revisions.find(item => item.version === version && item.source === 'current')
        if (revision) { stored = revision; break }
        if (!page.hasMore || !page.nextCursor) break
        cursor = page.nextCursor
      }
    } else {
      if (c.req.query('targetRevisionId')) return c.json(errorBody('scene-missing', '请求的时间线场景版本不存在'), 404)
      stored = await readSceneVersion(db, world.id, version)
    }
    const document = stored ? spaceDocument(stored.document, c.req.param('spaceId')) : null
    if (!document) return c.json(errorBody('scene-missing', '来源版本没有该空间'), 404)
    return c.json({ spaceId: c.req.param('spaceId'), side: 'source', version, document })
  } catch (error) { return fail(c, error) }
})

export default compatibilityRoutes
