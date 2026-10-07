import { Hono, type Context } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { timelines } from '../db/schema'
import { applyEdits, deserialize, ensureAssetPlacementIds, isSerializedVoxelSpaces, serialize, type SerializedVoxelSpaces } from '@possibility/voxel-contract'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { resolveWorldScope } from '../access/world-scope'
import { createDb } from '../db/client'
import { budgetFromEnv } from '../engine/budget'
import { BudgetRefusal, userReservation } from '../engine/guard'
import { complete } from '../llm/client'
import { byokFailureHint, resolveLlmConfig, type LlmConfigSource } from '../llm/resolve'
import { LlmContractError } from '../llm/contracts'
import type { Env } from '../index'
import { planEdits, EditPlannerError } from './edit-planner'
import { buildEditPlannerMessages } from './prompts'
import { readCurrentScene } from '../scenes/repository'
import { loadWorldSceneBindings } from '../scenes/compatibility/context'
import { inspectSceneCompatibility, validateStoredSceneCandidate } from '../scenes/compatibility/service'
import { reportView } from '../scenes/compatibility/http'
import { compatibilityFixturePlannerComplete } from '../scenes/e2e-fixture'

type EditPlanFailureKind = 'permission' | 'input' | 'budget' | 'config' | 'planning' | 'service' | 'compatibility' | 'conflict'

function editPlanFailure(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  status: 400 | 403 | 404 | 409 | 413 | 422 | 429 | 502 | 503,
  kind: EditPlanFailureKind,
  error: string,
  retryable: boolean,
  nextStep?: string,
) {
  return c.json({ error, kind, retryable, ...(nextStep ? { nextStep } : {}) }, status)
}

function stableText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableText).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableText(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** 体素世界 AI 编辑规划（F17）：意图 + 当前文档 → EditOperation[]（预览确认后由客户端应用） */
export const voxelRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
voxelRoutes.use('/voxel/*', authMiddleware)

voxelRoutes.post('/voxel/edit-plan', async (c) => {
  const body = await c.req.json<{ worldId?: string; timelineId?: string; representation?: string; spaceId?: string; requestId?: string; intent?: string; document?: string }>().catch(() => null)
  if (typeof body?.worldId !== 'string' || !body.worldId.trim()
    || typeof body.requestId !== 'string' || !body.requestId.trim()
    || typeof body.intent !== 'string' || !body.intent.trim()
    || typeof body.document !== 'string') {
    return editPlanFailure(c, 400, 'input', '请提供目标世界、请求 ID、改造意图和当前世界文档。', false,
      '返回有权限的已保存世界后重新发起改造。')
  }
  const user = c.get('user')
  const db = createDb(c.env.DB)
  const scope = await resolveWorldScope(db, {
    kind: 'user', userId: user.id, username: user.username, role: user.role, ownerId: user.id,
  }, body.worldId)
  if (!scope) {
    return editPlanFailure(c, 404, 'permission', '世界不存在或当前账号无权访问。', false,
      '打开你有权访问的世界后重试。')
  }
  if (!scope.capabilities.editScene) {
    return editPlanFailure(c, 403, 'permission', '当前世界不允许编辑场景。', false,
      '请切换到你有编辑权限的世界。')
  }
  if (body.document.length > 4_000_000) {
    return editPlanFailure(c, 413, 'input', '当前世界文档过大，无法生成改造方案。', false,
      '重新加载场景后再试。')
  }
  let doc: ReturnType<typeof deserialize>
  try {
    doc = deserialize(body.document)
  } catch {
    return editPlanFailure(c, 400, 'input', '当前世界文档无法读取。', false,
      '重新加载场景后再试。')
  }
  // A1(B52):模型配置/预算之前先核对权威场景——客户端文档必须对应真实当前基底,
  // 且既有场景必须通过完整检查;无效旧场景直接返回兼容诊断,模型调用为 0。
  if (body.representation !== undefined && body.representation !== 'voxel') {
    return editPlanFailure(c, 422, 'input', '该表现不支持体素编辑。', false)
  }
  const timeline = await db.select().from(timelines).where(and(eq(timelines.worldId, body.worldId),
    body.timelineId !== undefined ? eq(timelines.id, body.timelineId) : isNull(timelines.parentTimelineId))).get()
  if (!timeline || timeline.status !== 'active') return editPlanFailure(c, 409, 'permission', '目标时间线不存在或只读。', false)
  const sceneScope = body.timelineId !== undefined ? { worldId: body.worldId, timelineId: timeline.id, representation: 'voxel' } : undefined
  const spaceId = body.spaceId === 'exterior' ? 'single' : body.spaceId
  const bindings = await loadWorldSceneBindings(db, body.worldId, sceneScope, spaceId)
  const access = { bindings, ...(sceneScope ? { scope: sceneScope } : {}), ...(spaceId ? { spaceId } : {}) }
  const current = await readCurrentScene(db, body.worldId, sceneScope)
  if (!current) {
    return editPlanFailure(c, 409, 'conflict', '世界还没有已保存的场景。', false,
      '请先为这个世界创建场景。')
  }
  const inspection = await inspectSceneCompatibility(db, { worldId: body.worldId, access })
  if (inspection.status !== 'ready') {
    return c.json({ error: inspection.error.message, kind: 'compatibility', retryable: false, errorCode: inspection.error.code, nextStep: '请先完成场景兼容检查。' }, inspection.status === 'missing' ? 404 : 422)
  }
  if (inspection.report.status !== 'valid') {
    return c.json({
      error: inspection.report.status === 'invalid' ? '当前场景存在既存问题，请先完成兼容修复' : '当前场景检查未完成，不能规划编辑',
      kind: 'compatibility', retryable: false,
      errorCode: inspection.report.status === 'invalid' ? 'compatibility-required' : 'validation-incomplete',
      report: reportView(inspection.report) ?? undefined,
      nextStep: '打开场景兼容检查并完成修复后再继续原来的改造。',
    }, 422)
  }
  const spaces = isSerializedVoxelSpaces(current.document) ? current.document.spaces : null
  const clientHash = stableText(JSON.parse(body.document))
  const matched = spaces
    ? spaces.find(space => (!spaceId || space.id === spaceId) && stableText(space.document) === clientHash)
    : ((!spaceId || spaceId === 'single') && stableText(current.document) === clientHash ? { id: 'single', document: current.document } : null)
  if (!matched) {
    return editPlanFailure(c, 409, 'conflict', '当前文档与已保存场景不一致，请重新加载后再试。', false,
      '刷新场景后再发起改造。')
  }
  const baseDoc = deserialize(JSON.stringify(matched.document))
  let source: LlmConfigSource = 'env'
  try {
    const resolution = await resolveLlmConfig(db, c.env, { userId: user.id, worldId: body.worldId },
      userReservation(db, user.id, budgetFromEnv(c.env), 'scene'))
    source = resolution.source
    // A1(B68):仅 s02-e2e 显式兼容 fixture 模式注入确定性测试提供者;模式只取环境变量,
    // 绝不取 HTTP body。auth、resolveLlmConfig、预算/调用记录、planEdits 与 B69 预检原样保留。
    const fixtureComplete = compatibilityFixturePlannerComplete(c.env)
    const ops = await planEdits(baseDoc, body.intent.trim(), {
      complete: fixtureComplete ?? ((messages) => complete(resolution.config, messages, {
        maxTokens: 4000,
        requestId: body.requestId,
        responseFormat: { type: 'json_object' },
        thinking: { type: 'disabled' },
      })),
      buildMessages: buildEditPlannerMessages,
    })
    // A1(B69):规划成功不是许可——在权威基底上组装完整候选并通过完整预检才返回依据。
    const applied = applyEdits(baseDoc, ops)
    const edited = ensureAssetPlacementIds(applied.document)
    const candidate = spaces
      ? { ...(current.document as SerializedVoxelSpaces), spaces: spaces.map(space => space.id === matched.id ? { ...space, document: JSON.parse(serialize(edited)) as typeof space.document } : space) }
      : JSON.parse(serialize(edited)) as typeof current.document
    const preflight = await validateStoredSceneCandidate(db, { worldId: body.worldId, document: candidate, access })
    if (preflight.status !== 'valid') {
      return c.json({
        error: preflight.status === 'invalid' ? '改造结果未通过完整校验，请调整描述后重试' : '改造结果检查未完成，请重试',
        kind: 'planning', retryable: true,
        errorCode: preflight.status === 'invalid' ? 'scene-invalid' : 'validation-incomplete',
        report: reportView(preflight.report) ?? undefined,
        nextStep: '保留或修改描述后，点击“重试生成预览”。',
      }, 422)
    }
    return c.json({ ops, previewBasis: preflight.basis })
  } catch (error) {
    if (error instanceof BudgetRefusal) {
      return editPlanFailure(c, error.status, 'budget', error.message, false,
        '请查看当前调用额度，或在额度恢复后重试。')
    }
    if (error instanceof EditPlannerError) {
      return editPlanFailure(c, 422, 'planning', 'AI 暂时没能生成有效方案，请调整描述后重试。', true,
        '保留或修改描述后，点击“重试生成预览”。')
    }
    if (error instanceof LlmContractError && error.code === 'provider_http_error' && /(?:401|403)/.test(error.message)) {
      return editPlanFailure(c, 502, 'config', byokFailureHint(source) ?? '模型配置无法使用，请检查 API Key 和服务地址。', false,
        '修正模型配置后重新生成预览。')
    }
    return editPlanFailure(c, 503, 'service', 'AI 改造暂时遇到问题，请稍后重试。', true,
      '请保留当前描述并重试。')
  }
})
