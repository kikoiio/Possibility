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
import { BudgetRefusal } from '../engine/guard'
import { budgetFromEnv } from '../engine/budget'
import type { Env } from '../index'
import { LlmContractError } from '../llm/contracts'
import { byokFailureHint } from '../llm/resolve'
import { CONTENT_ISSUE_COPY, CONTENT_ISSUE_FALLBACK } from './error-copy'
import { createVoxelSceneDraft } from './voxel-draft'
import { createSceneRepairDraft, readSceneRepairContext, SceneRepairError } from './repair'
import { commitScene, listSceneVersions, readCurrentScene, SceneConflict } from './repository'
import { generateWorld, WorldGeneratorError } from '../voxel/generate'
import { buildWorldGeneratorMessages } from '../voxel/prompts'
import { complete } from '../llm/client'
import { resolveLlmConfig } from '../llm/resolve'
import { userReservation } from '../engine/guard'
import { restoreSceneVersion } from './service'
import { loadWorldSceneBindings } from './compatibility/context'
import { SceneCompatibilityServiceError, validateStoredSceneCandidate } from './compatibility/service'
import { reportView } from './compatibility/http'

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
    || /^(?:\/api)?\/worlds\/[^/]+\/scene\/(?:voxel-revision|restore|repair-context|repair-draft|revisions)(?:\/|$)/.test(path)
  if (loginOnly) return authMiddleware(c, next)
  await next()
})

async function ownedWorld(db: ReturnType<typeof createDb>, worldId: string, userId: string) {
  return (await db.select().from(worlds).where(and(eq(worlds.id, worldId), eq(worlds.userId, userId))).get()) ?? null
}
const err = (c: Context<{ Bindings: Env; Variables: AuthVariables }>, error: unknown) => {
  if (error instanceof BudgetRefusal) return c.json({ error: error.message }, error.status)
  if (error instanceof SceneConflict) return c.json({ error: error.message }, 409)
  if (error instanceof SceneRepairError) {
    const status = error.code === 'world_missing' ? 404 : 409
    return c.json({ error: error.message, errorCode: error.code }, status)
  }
  if (error instanceof SceneCompatibilityServiceError) {
    return c.json({ error: error.message, errorCode: error.code, ...(error.report ? { report: reportView(error.report) ?? undefined } : {}) }, error.status as 409 | 422)
  }
  return c.json({ error: error instanceof Error ? error.message : '场景处理失败' }, 400)
}

scenesRoutes.post('/scene-drafts/voxel', async c => {
  const body = await c.req.json<{ requestId?: string; prompt?: string; personIds?: string[] }>().catch(() => null)
  if (!body || !body.requestId || !body.prompt?.trim() || !Array.isArray(body.personIds)) return c.json({ error: '请提供 requestId、场景描述和居民' }, 400)
  const db = createDb(c.env.DB)
  try {
    return c.json(await createVoxelSceneDraft(c.env, db, c.get('user').id, { requestId: body.requestId, prompt: body.prompt, personIds: body.personIds }))
  } catch (error) {
    const requestId = body.requestId
    const callsUsed = error && typeof error === 'object' && 'callsUsed' in error
      && typeof error.callsUsed === 'number' ? error.callsUsed : 0
    if (error instanceof BudgetRefusal) return c.json({ error: error.message, kind: 'budget', callsUsed, requestId }, error.status)
    if (error instanceof WorldGeneratorError) {
      const issues = error.issues.slice(0, 12).map(issue => ({
        code: issue.code,
        ...(CONTENT_ISSUE_COPY[issue.code as keyof typeof CONTENT_ISSUE_COPY] ?? CONTENT_ISSUE_FALLBACK),
      }))
      return c.json({ error: '场景暂时没有生成成功,请按建议调整描述后重试。', kind: 'content', issues, callsUsed, requestId }, 502)
    }
    if (error instanceof LlmContractError && error.code === 'provider_http_error' && /(?:401|403)/.test(error.message)) {
      const hint = byokFailureHint('user')
      return c.json({ error: hint ?? '模型配置无法使用,请检查 API Key 和服务地址。', kind: 'config', callsUsed, requestId }, 502)
    }
    return c.json({ error: '场景生成时遇到问题,请稍后重试。', kind: 'system', callsUsed, requestId }, 400)
  }
})

scenesRoutes.get('/worlds/:worldId/scene/repair-context', async c => {
  const db = createDb(c.env.DB)
  try {
    const context = await readSceneRepairContext(db, c.get('user').id, c.req.param('worldId'))
    if (context.sceneStatus === 'ready') return c.json({ error: '这个世界已经有场景，可以直接进入。', errorCode: 'scene_exists' }, 409)
    return c.json(context)
  } catch (error) { return err(c, error) }
})

scenesRoutes.post('/worlds/:worldId/scene/repair-draft', async c => {
  const body = await c.req.json<{ requestId?: string; prompt?: string }>().catch(() => null)
  if (!body?.requestId || !body.prompt?.trim()) return c.json({ error: '请提供场景描述和请求标识', errorCode: 'invalid_request' }, 400)
  const db = createDb(c.env.DB)
  try {
    return c.json(await createSceneRepairDraft(c.env, db, c.get('user').id, c.req.param('worldId'), {
      requestId: body.requestId, prompt: body.prompt.trim(),
    }))
  } catch (error) {
    if (error instanceof BudgetRefusal) return c.json({ error: error.message, errorCode: 'budget' }, error.status)
    if (error instanceof WorldGeneratorError) {
      const issues = error.issues.slice(0, 12).map(issue => ({
        code: issue.code,
        ...(CONTENT_ISSUE_COPY[issue.code as keyof typeof CONTENT_ISSUE_COPY] ?? CONTENT_ISSUE_FALLBACK),
      }))
      return c.json({ error: '场景暂时没有生成成功，请调整描述后重试。', errorCode: 'content', issues }, 502)
    }
    if (error instanceof LlmContractError && error.code === 'provider_http_error' && /(?:401|403)/.test(error.message)) {
      return c.json({ error: byokFailureHint('user') ?? '模型配置无法使用，请检查 API Key 和服务地址。', errorCode: 'config' }, 502)
    }
    return err(c, error)
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
  const body = await c.req.json<{ requestId?: string; expectedVersion?: number; document?: unknown; spaceId?: string; repair?: boolean }>().catch(() => null)
  if (!body?.requestId || !Number.isSafeInteger(body.expectedVersion) || !body.document) return c.json({ error: '体素场景提交参数不完整' }, 400)
  if (body.repair && body.expectedVersion !== 0) return c.json({ error: '原世界场景补建必须提交首版场景', errorCode: 'invalid_repair_version' }, 400)
  try {
    // A ready scene is allowed through only so commitScene can replay the identical successful repair request.
    const repairContext = body.repair
      ? await readSceneRepairContext(db, user.id, world.id)
      : null
    if (body.repair && isSerializedVoxelSpaces(body.document)) {
      return c.json({ error: '原世界补建首版仅接受单体素场景文档', errorCode: 'invalid_repair_scene' }, 422)
    }
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
      if (repairContext) {
        const expected = repairContext.world.locations.map(location => location.name)
        const actual = doc.locations.map(location => location.name)
        if (actual.length !== expected.length || new Set(actual).size !== actual.length
          || expected.some(location => !actual.includes(location))) {
          return c.json({ error: '体素场景地点必须与原世界完全一致', errorCode: 'repair_location_mismatch' }, 422)
        }
      }
      document = JSON.parse(serialize(doc)) as SerializedVoxelDocument
    } else return c.json({ error: '文档不是序列化体素信封或空间包' }, 422)
    // A1:普通保存也必须通过完整信封校验——未编辑空间、绑定与连接一并检查。
    const saveBindings = await loadWorldSceneBindings(db, world.id)
    const validation = await validateStoredSceneCandidate(db, { worldId: world.id, document, access: { bindings: saveBindings } })
    if (validation.status !== 'valid') {
      return c.json({
        error: validation.status === 'invalid' ? '场景未通过完整校验，请先处理兼容问题' : '场景检查未完成，不能保存',
        errorCode: validation.status === 'invalid' ? 'compatibility-required' : 'validation-incomplete',
        report: reportView(validation.report) ?? undefined,
      }, 422)
    }
    const baseline = await db.select({ id: demoBaselines.id }).from(demoBaselines)
      .where(and(eq(demoBaselines.worldId, world.id), eq(demoBaselines.status, 'active'))).get()
    const allowBaseline = !!baseline && world.isDemo && user.role === 'admin'
    const isRepair = body.repair === true
    const result = await commitScene(db, {
      worldId: world.id,
      expectedVersion: body.expectedVersion!,
      requestId: body.requestId,
      document,
      summary: isRepair ? '为原世界补建场景' : body.spaceId ? `编辑空间 ${body.spaceId}` : '体素编辑',
      kind: isRepair ? 'scene-repair' : 'voxel-edit',
      allowBaseline,
    })
    return c.json(result)
  } catch (error) { return err(c, error) }
})

scenesRoutes.post('/worlds/:worldId/scene/voxel-regenerate', async c => {
  const db = createDb(c.env.DB); const user = c.get('user')
  const world = await ownedWorld(db, c.req.param('worldId'), user.id)
  if (!world || !world.isDemo || user.role !== 'admin') return c.json({ error: '仅演示世界管理员可重新生成' }, 404)
  const body = await c.req.json<{ expectedVersion?: number; requestId?: string }>().catch(() => null)
  if (!body?.requestId || !Number.isSafeInteger(body.expectedVersion)) return c.json({ error: '重新生成参数不完整' }, 400)
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
    const regenerated = { ...source, spaces }
    const regeneration = await validateStoredSceneCandidate(db, { worldId: world.id, document: regenerated, access: { bindings: await loadWorldSceneBindings(db, world.id) } })
    if (regeneration.status !== 'valid') {
      return c.json({ error: '重新生成的场景未通过完整校验，未保存任何内容', errorCode: regeneration.status === 'invalid' ? 'compatibility-required' : 'validation-incomplete', report: reportView(regeneration.report) ?? undefined }, 502)
    }
    // A1 B28：基线重指向与新修订同一批写入；任一步失败整批回滚，不留指向旧版本的崩溃窗口
    const activeBaseline = await db.select({ id: demoBaselines.id }).from(demoBaselines)
      .where(and(eq(demoBaselines.worldId, world.id), eq(demoBaselines.status, 'active'))).get()
    const result = await commitScene(db, {
      worldId: world.id, expectedVersion: body.expectedVersion!, requestId: body.requestId,
      document: regenerated, summary: '管理员重新生成演示体素世界', kind: 'voxel-regenerate', allowBaseline: true,
      ...(activeBaseline ? { baselineUpdate: { baselineId: activeBaseline.id } } : {}),
    })
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
  try { return c.json(await restoreSceneVersion(db, { worldId: world.id, requestId: body.requestId, expectedVersion: body.expectedVersion!, targetVersion: body.targetVersion!, access: { bindings: await loadWorldSceneBindings(db, world.id) } })) }
  catch (error) { return err(c, error) }
})
