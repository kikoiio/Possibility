import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  deserialize, ensureAssetPlacementIds, isSerializedVoxelDocument, isSerializedVoxelSpaces, serialize, validateDocument, validateWalkability,
  type SerializedVoxelDocument, type SerializedVoxelSpaces,
} from '@possibility/voxel-contract'
import { libraryManifest } from '../voxel/library-manifest'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { scopedUserMiddleware } from '../access/scoped-user-middleware'
import { createDb } from '../db/client'
import { demoBaselines, worlds } from '../db/schema'
import { BudgetRefusal, gateUser } from '../engine/guard'
import { budgetFromEnv } from '../engine/budget'
import type { Env } from '../index'
import { createVoxelSceneDraft } from './voxel-draft'
import { commitScene, listSceneVersions, readCurrentScene, SceneConflict } from './repository'
import { generateWorld, WorldGeneratorError } from '../voxel/generate'
import { buildWorldGeneratorMessages } from '../voxel/prompts'
import { complete } from '../llm/client'
import { resolveLlmConfig } from '../llm/resolve'
import { userReservation } from '../engine/guard'
import { restoreSceneVersion } from './service'

export const scenesRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
scenesRoutes.use('*', async (c, next) => {
  const path = c.req.path
  const apiPrefix = path.startsWith('/api/') ? '/api' : ''
  const sceneRoot = path.match(/^(?:\/api)?\/worlds\/([^/]+)\/scene$/)
  if (sceneRoot && c.req.method === 'GET') {
    return scopedUserMiddleware((method, requestPath, scopedId) => method === 'GET' && requestPath === `${apiPrefix}/worlds/${encodeURIComponent(scopedId)}/scene`)(c, next)
  }
  const loginOnly = path === '/api/scene-drafts' || path.startsWith('/api/scene-drafts/')
    || path === '/scene-drafts' || path.startsWith('/scene-drafts/')
    || /^(?:\/api)?\/worlds\/[^/]+\/scene\/(?:voxel-revision|restore)(?:\/|$)/.test(path)
  if (loginOnly) return authMiddleware(c, next)
  await next()
})

async function ownedWorld(db: ReturnType<typeof createDb>, worldId: string, userId: string) {
  return (await db.select().from(worlds).where(and(eq(worlds.id, worldId), eq(worlds.userId, userId))).get()) ?? null
}
const err = (c: Context<{ Bindings: Env; Variables: AuthVariables }>, error: unknown) => {
  if (error instanceof BudgetRefusal) return c.json({ error: error.message }, error.status)
  if (error instanceof SceneConflict) return c.json({ error: error.message }, 409)
  return c.json({ error: error instanceof Error ? error.message : '场景处理失败' }, 400)
}

scenesRoutes.post('/scene-drafts/voxel', async c => {
  const body = await c.req.json<{ requestId?: string; prompt?: string; personIds?: string[] }>().catch(() => null)
  if (!body || !body.requestId || !body.prompt?.trim() || !Array.isArray(body.personIds)) return c.json({ error: '请提供 requestId、场景描述和居民' }, 400)
  const db = createDb(c.env.DB); const gate = await gateUser(db, c.get('user').id, budgetFromEnv(c.env))
  if (!gate.ok) return c.json({ error: gate.error }, gate.status)
  try {
    return c.json(await createVoxelSceneDraft(c.env, db, c.get('user').id, { requestId: body.requestId, prompt: body.prompt, personIds: body.personIds }))
  } catch (error) {
    if (error instanceof BudgetRefusal) return c.json({ error: error.message }, error.status)
    if (error instanceof WorldGeneratorError) return c.json({ error: error.message, issues: error.issues.slice(0, 12) }, 502)
    return c.json({ error: error instanceof Error ? error.message : '体素场景生成失败' }, 400)
  }
})

scenesRoutes.get('/worlds/:worldId/scene', async c => {
  const db = createDb(c.env.DB); const world = await ownedWorld(db, c.req.param('worldId'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  try { const scene = await readCurrentScene(db, world.id); return scene ? c.json({ status: 'ready', ...scene }) : c.json({ status: 'missing' }) }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : '场景读取失败' }, 500) }
})

scenesRoutes.get('/worlds/:worldId/scene/revisions', async c => {
  const db = createDb(c.env.DB); const world = await ownedWorld(db, c.req.param('worldId'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  return c.json({ revisions: await listSceneVersions(db, world.id, Number(c.req.query('limit') ?? 30)) })
})

scenesRoutes.post('/worlds/:worldId/scene/voxel-revision', async c => {
  const db = createDb(c.env.DB); const user = c.get('user')
  const world = await ownedWorld(db, c.req.param('worldId'), user.id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const body = await c.req.json<{ requestId?: string; expectedVersion?: number; document?: unknown; spaceId?: string }>().catch(() => null)
  if (!body?.requestId || !Number.isSafeInteger(body.expectedVersion) || !body.document) return c.json({ error: '体素场景提交参数不完整' }, 400)
  try {
    let document: SerializedVoxelDocument | SerializedVoxelSpaces
    if (isSerializedVoxelSpaces(body.document)) {
      if (!body.spaceId) return c.json({ error: '多空间体素保存需要 spaceId' }, 400)
      const current = await readCurrentScene(db, world.id)
      if (!current || !isSerializedVoxelSpaces(current.document)) return c.json({ error: '当前场景不是多空间体素包' }, 409)
      const currentBundle = current.document
      const index = currentBundle.spaces.findIndex(space => space.id === body.spaceId)
      if (index < 0) return c.json({ error: '空间不存在' }, 404)
      const incomingBundle = body.document as SerializedVoxelSpaces
      const incoming = incomingBundle.spaces.find(space => space.id === body.spaceId)
      if (!incoming || incomingBundle.spaces.length !== currentBundle.spaces.length
        || incomingBundle.spaces.some((space, i) => space.id !== currentBundle.spaces[i]?.id)) return c.json({ error: '体素包空间结构不匹配' }, 422)
      const doc = ensureAssetPlacementIds(deserialize(JSON.stringify(incoming.document)))
      const issues = [...validateDocument(doc, undefined, libraryManifest() ?? undefined), ...validateWalkability(doc)]
      if (issues.length) return c.json({ error: '体素场景未通过校验', issues: issues.slice(0, 12) }, 422)
      document = { ...currentBundle, spaces: currentBundle.spaces.map((space, i) => i === index
        ? { ...space, document: JSON.parse(serialize(doc)) as SerializedVoxelDocument } : space) }
    } else if (isSerializedVoxelDocument(body.document)) {
      const doc = ensureAssetPlacementIds(deserialize(JSON.stringify(body.document)))
      const issues = [...validateDocument(doc, undefined, libraryManifest() ?? undefined), ...validateWalkability(doc)]
      if (issues.length) return c.json({ error: '体素场景未通过校验', issues: issues.slice(0, 12) }, 422)
      document = JSON.parse(serialize(doc)) as SerializedVoxelDocument
    } else return c.json({ error: '文档不是序列化体素信封或空间包' }, 422)
    const baseline = await db.select({ id: demoBaselines.id }).from(demoBaselines)
      .where(and(eq(demoBaselines.worldId, world.id), eq(demoBaselines.status, 'active'))).get()
    const allowBaseline = !!baseline && world.isDemo && user.role === 'admin'
    const result = await commitScene(db, { worldId: world.id, expectedVersion: body.expectedVersion!, requestId: body.requestId, document, summary: body.spaceId ? `编辑空间 ${body.spaceId}` : '体素编辑', kind: 'voxel-edit', allowBaseline })
    return c.json(result)
  } catch (error) { return err(c, error) }
})

scenesRoutes.post('/worlds/:worldId/scene/voxel-regenerate', async c => {
  const db = createDb(c.env.DB); const user = c.get('user')
  const world = await ownedWorld(db, c.req.param('worldId'), user.id)
  if (!world || !world.isDemo || user.role !== 'admin') return c.json({ error: '仅演示世界管理员可重新生成' }, 404)
  const body = await c.req.json<{ expectedVersion?: number; requestId?: string }>().catch(() => null)
  if (!body?.requestId || !Number.isSafeInteger(body.expectedVersion)) return c.json({ error: '重新生成参数不完整' }, 400)
  const gate = await gateUser(db, user.id, budgetFromEnv(c.env))
  if (!gate.ok) return c.json({ error: gate.error }, gate.status)
  try {
    const activeScene = await readCurrentScene(db, world.id)
    const source = activeScene?.document
    if (!source || !isSerializedVoxelSpaces(source)) return c.json({ error: '当前演示世界没有可重新生成的多空间场景' }, 409)
    const { config } = await resolveLlmConfig(db, c.env, { userId: user.id, worldId: world.id }, userReservation(db, user.id, budgetFromEnv(c.env), 'scene'))
    const spaces = []
    for (const spec of source.spaces) {
      const prompt = `为演示世界「${world.name}」重新生成空间「${spec.name}」。保留世界风格与建筑布局语义，空间尺寸为 ${spec.document.size.width}×${spec.document.size.height}×${spec.document.size.depth}。`
      const generated = await generateWorld(prompt, spec.document.theme, {
        id: `demo-${world.id}-${spec.id}-${body.requestId}`,
        complete: messages => complete(config, messages, { maxTokens: 16000, requestId: `${body.requestId}:${spec.id}`, responseFormat: { type: 'json_object' }, thinking: { type: 'disabled' } }),
        assets: libraryManifest() ?? undefined,
        buildMessages: (description, theme) => buildWorldGeneratorMessages(description, theme, libraryManifest() ?? undefined),
        maxAttempts: 4,
      })
      const normalized = JSON.parse(serialize(generated)) as SerializedVoxelDocument
      spaces.push({ ...spec, document: normalized })
    }
    const result = await commitScene(db, {
      worldId: world.id, expectedVersion: body.expectedVersion!, requestId: body.requestId,
      document: { ...source, spaces }, summary: '管理员重新生成演示体素世界', kind: 'voxel-regenerate', allowBaseline: true,
    })
    await db.update(demoBaselines).set({ sceneVersion: result.version, contentHash: result.contentHash })
      .where(and(eq(demoBaselines.worldId, world.id), eq(demoBaselines.status, 'active')))
    return c.json(result)
  } catch (error) {
    if (error instanceof BudgetRefusal) return c.json({ error: error.message }, error.status)
    if (error instanceof WorldGeneratorError) return c.json({ error: error.message, issues: error.issues.slice(0, 12) }, 502)
    return err(c, error)
  }
})

scenesRoutes.post('/worlds/:worldId/scene/restore', async c => {
  const db = createDb(c.env.DB); const world = await ownedWorld(db, c.req.param('worldId'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const body = await c.req.json<{ requestId?: string; expectedVersion?: number; targetVersion?: number }>().catch(() => null)
  if (!body?.requestId || !Number.isSafeInteger(body.expectedVersion) || !Number.isSafeInteger(body.targetVersion)) return c.json({ error: '恢复参数不完整' }, 400)
  try { return c.json(await restoreSceneVersion(db, { worldId: world.id, requestId: body.requestId, expectedVersion: body.expectedVersion!, targetVersion: body.targetVersion! })) }
  catch (error) { return err(c, error) }
})
