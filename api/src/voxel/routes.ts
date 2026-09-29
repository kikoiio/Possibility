import { Hono } from 'hono'
import { deserialize } from '@possibility/voxel-contract'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { createDb } from '../db/client'
import { budgetFromEnv } from '../engine/budget'
import { BudgetRefusal, gateUser, userReservation } from '../engine/guard'
import { complete, configFromEnv } from '../llm/client'
import type { Env } from '../index'
import { planEdits, EditPlannerError } from './edit-planner'
import { buildEditPlannerMessages } from './prompts'

/** 体素世界 AI 编辑规划（F17）：意图 + 当前文档 → EditOperation[]（预览确认后由客户端应用） */
export const voxelRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
voxelRoutes.use('/voxel/*', authMiddleware)

voxelRoutes.post('/voxel/edit-plan', async (c) => {
  const body = await c.req.json<{ requestId?: string; intent?: string; document?: string }>().catch(() => null)
  if (!body?.requestId || !body.intent?.trim() || typeof body.document !== 'string') {
    return c.json({ error: '请提供 requestId、改造意图和当前世界文档' }, 400)
  }
  if (body.document.length > 4_000_000) return c.json({ error: '世界文档过大' }, 413)
  let doc
  try {
    doc = deserialize(body.document)
  } catch (error) {
    return c.json({ error: `世界文档无效：${error instanceof Error ? error.message : String(error)}` }, 400)
  }
  const db = createDb(c.env.DB)
  const gate = await gateUser(db, c.get('user').id, budgetFromEnv(c.env))
  if (!gate.ok) return c.json({ error: gate.error }, gate.status)
  const config = configFromEnv(c.env, userReservation(db, c.get('user').id, budgetFromEnv(c.env), 'scene'))
  try {
    const ops = await planEdits(doc, body.intent.trim(), {
      complete: (messages) => complete(config, messages, {
        maxTokens: 4000,
        requestId: body.requestId,
        responseFormat: { type: 'json_object' },
        thinking: { type: 'disabled' },
      }),
      buildMessages: buildEditPlannerMessages,
    })
    return c.json({ ops })
  } catch (error) {
    if (error instanceof BudgetRefusal) return c.json({ error: error.message }, error.status)
    if (error instanceof EditPlannerError) {
      return c.json({ error: error.message, issues: error.issues }, 422)
    }
    return c.json({ error: error instanceof Error ? error.message : '编辑规划失败' }, 400)
  }
})
