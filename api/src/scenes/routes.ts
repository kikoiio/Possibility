import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { applySceneOperations, validateScene } from '@possibility/scene-contract'
import type { SceneDocument, SceneOperation } from '@possibility/scene-contract'
import { isVoxelScenePayload } from './repository'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { scopedUserMiddleware } from '../access/scoped-user-middleware'
import { createDb } from '../db/client'
import { persons, worldPersons, worlds } from '../db/schema'
import { BudgetRefusal, gateUser } from '../engine/guard'
import { budgetFromEnv } from '../engine/budget'
import { contemporaryTheme } from '@possibility/scene-contract'
import type { Env } from '../index'
import { createSceneDraft, previewSceneOperations } from './ai'
import { listSceneVersions, readCurrentScene, SceneConflict } from './repository'
import { applyScenePatch, restoreSceneVersion, saveSceneRevision } from './service'

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
    || /^(?:\/api)?\/worlds\/[^/]+\/scene\/(?:revisions|legacy-preview|edit-preview|legacy-confirm|restore)(?:\/|$)/.test(path)
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

scenesRoutes.post('/scene-drafts', async c => {
  const body = await c.req.json<{ requestId?: string; prompt?: string; personIds?: string[] }>().catch(() => null)
  if (!body || !body.requestId || !body.prompt?.trim() || !Array.isArray(body.personIds)) return c.json({ error: '请提供 requestId、场景描述和居民' }, 400)
  const db = createDb(c.env.DB); const gate = await gateUser(db, c.get('user').id, budgetFromEnv(c.env))
  if (!gate.ok) return c.json({ error: gate.error }, gate.status)
  try { return c.json(await createSceneDraft(c.env, db, c.get('user').id, { requestId: body.requestId, prompt: body.prompt, personIds: body.personIds })) }
  catch (error) { return err(c, error) }
})

scenesRoutes.post('/scene-drafts/edit-preview', async c => {
  const body = await c.req.json<{ requestId?: string; instruction?: string; draft?: SceneDocument; personIds?: string[] }>().catch(() => null)
  if (!body?.requestId || !body.instruction?.trim() || !body.draft) return c.json({ error: '草稿修改参数不完整' }, 400)
  const validation = validateScene(body.draft, contemporaryTheme); if (!validation.ok) return c.json({ error: '场景草稿无效' }, 400)
  try {
    const preview = await previewSceneOperations(c.env, createDb(c.env.DB), c.get('user').id, { requestId: body.requestId, instruction: body.instruction, document: body.draft, selectedPersonIds: body.personIds })
    const result = applySceneOperations(body.draft, preview.operations, contemporaryTheme)
    return c.json({ world: null, preview: { ...preview, baseVersion: body.draft.version, operations: preview.operations, changes: result.changes }, documentPreview: result.document })
  } catch (error) { return err(c, error) }
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

scenesRoutes.post('/worlds/:worldId/scene/legacy-preview', async c => {
  const db = createDb(c.env.DB); const world = await ownedWorld(db, c.req.param('worldId'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  if (await readCurrentScene(db, world.id)) return c.json({ error: '这个世界已经有画布' }, 409)
  const body = await c.req.json<{ requestId?: string }>().catch(() => null); if (!body?.requestId) return c.json({ error: '缺少 requestId' }, 400)
  try {
    const members = await db.select({ id: persons.id, name: persons.name }).from(worldPersons).innerJoin(persons, eq(worldPersons.personId, persons.id)).where(eq(worldPersons.worldId, world.id)).all()
    const locations = JSON.parse(world.locationsJson) as { name: string; description: string }[]
    const draft = await createSceneDraft(c.env, db, c.get('user').id, { requestId: body.requestId, prompt: `${world.description}\n现有地点：${JSON.stringify(locations)}`, personIds: members.map(p => p.id) })
    return c.json({ document: draft.scene, explanation: draft.explanation, warnings: draft.warnings })
  } catch (error) { return err(c, error) }
})

scenesRoutes.post('/worlds/:worldId/scene/edit-preview', async c => {
  const db = createDb(c.env.DB); const world = await ownedWorld(db, c.req.param('worldId'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const body = await c.req.json<{ requestId?: string; instruction?: string; expectedVersion?: number }>().catch(() => null)
  if (!body?.requestId || !body.instruction?.trim() || !Number.isSafeInteger(body.expectedVersion)) return c.json({ error: '修改预览参数不完整' }, 400)
  try {
    const base = await readCurrentScene(db, world.id); if (!base) return c.json({ error: '世界还没有画布' }, 404)
    if (base.version !== body.expectedVersion) throw new SceneConflict()
    if (isVoxelScenePayload(base.document)) return c.json({ error: '体素场景请使用体素编辑通道' }, 422)
    const ai = await previewSceneOperations(c.env, db, c.get('user').id, { requestId: body.requestId, instruction: body.instruction, document: base.document })
    const result = applyScenePatch(base.document, ai.operations, true)
    return c.json({ preview: { ...ai, baseVersion: base.version, result: result.document, changes: result.changes } })
  } catch (error) { return err(c, error) }
})

scenesRoutes.post('/worlds/:worldId/scene/legacy-confirm', async c => {
  const db = createDb(c.env.DB); const world = await ownedWorld(db, c.req.param('worldId'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  if (await readCurrentScene(db, world.id)) return c.json({ error: '这个世界已经有画布' }, 409)
  const body = await c.req.json<{ requestId?: string; document?: SceneDocument }>().catch(() => null)
  if (!body?.requestId || !body.document) return c.json({ error: '缺少布局确认内容' }, 400)
  const validation = validateScene(body.document, contemporaryTheme); if (!validation.ok) return c.json({ error: '布局无效', issues: validation.issues }, 400)
  try {
    const worldLocations = new Set((JSON.parse(world.locationsJson) as { name: string }[]).map(location => location.name))
    const residents = new Set((await db.select({ id: worldPersons.personId }).from(worldPersons).where(eq(worldPersons.worldId, world.id)).all()).map(person => person.id))
    const usedLocations = new Set(body.document.objects.flatMap(object => object.binding?.kind === 'location' ? [object.binding.locationName] : []))
    const usedResidents = new Set(body.document.objects.flatMap(object => object.binding?.kind === 'person' ? [object.binding.personId] : []))
    if (usedLocations.size !== worldLocations.size || [...worldLocations].some(name => !usedLocations.has(name))) return c.json({ error: '布局地点必须与现有世界完全一致' }, 400)
    if (usedResidents.size !== residents.size || [...residents].some(id => !usedResidents.has(id))) return c.json({ error: '布局居民必须与现有世界完全一致' }, 400)
    return c.json(await (await import('./repository')).commitScene(db, { worldId: world.id, expectedVersion: 0, requestId: body.requestId, document: body.document, summary: '确认现有世界布局', kind: 'legacy_layout' }))
  } catch (error) { return err(c, error) }
})

scenesRoutes.post('/worlds/:worldId/scene/revisions', async c => {
  const db = createDb(c.env.DB); const world = await ownedWorld(db, c.req.param('worldId'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const body = await c.req.json<{ requestId?: string; expectedVersion?: number; operations?: SceneOperation[]; kind?: string }>().catch(() => null)
  if (!body?.requestId || !Number.isSafeInteger(body.expectedVersion) || !Array.isArray(body.operations)) return c.json({ error: '场景提交参数不完整' }, 400)
  try {
    const result = await saveSceneRevision(db, { worldId: world.id, requestId: body.requestId, expectedVersion: body.expectedVersion!, operations: body.operations, running: true, kind: body.kind })
    return c.json(result)
  } catch (error) { return err(c, error) }
})

scenesRoutes.post('/worlds/:worldId/scene/restore', async c => {
  const db = createDb(c.env.DB); const world = await ownedWorld(db, c.req.param('worldId'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const body = await c.req.json<{ requestId?: string; expectedVersion?: number; targetVersion?: number }>().catch(() => null)
  if (!body?.requestId || !Number.isSafeInteger(body.expectedVersion) || !Number.isSafeInteger(body.targetVersion)) return c.json({ error: '恢复参数不完整' }, 400)
  try { return c.json(await restoreSceneVersion(db, { worldId: world.id, requestId: body.requestId, expectedVersion: body.expectedVersion!, targetVersion: body.targetVersion! })) }
  catch (error) { return err(c, error) }
})
