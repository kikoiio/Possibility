import { Hono, type Context } from 'hono'
import { deserialize } from '@possibility/voxel-contract'
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

type EditPlanFailureKind = 'permission' | 'input' | 'budget' | 'config' | 'planning' | 'service'

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

/** 体素世界 AI 编辑规划（F17）：意图 + 当前文档 → EditOperation[]（预览确认后由客户端应用） */
export const voxelRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
voxelRoutes.use('/voxel/*', authMiddleware)

voxelRoutes.post('/voxel/edit-plan', async (c) => {
  const body = await c.req.json<{ worldId?: string; requestId?: string; intent?: string; document?: string }>().catch(() => null)
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
  let source: LlmConfigSource = 'env'
  try {
    const resolution = await resolveLlmConfig(db, c.env, { userId: user.id, worldId: body.worldId },
      userReservation(db, user.id, budgetFromEnv(c.env), 'scene'))
    source = resolution.source
    const ops = await planEdits(doc, body.intent.trim(), {
      complete: (messages) => complete(resolution.config, messages, {
        maxTokens: 4000,
        requestId: body.requestId,
        responseFormat: { type: 'json_object' },
        thinking: { type: 'disabled' },
      }),
      buildMessages: buildEditPlannerMessages,
    })
    return c.json({ ops })
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
