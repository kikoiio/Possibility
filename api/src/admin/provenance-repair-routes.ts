import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { createDb } from '../db/client'
import { provenanceRepairRuns } from '../db/schema'
import type { Env } from '../index'
import type { RepairScope } from '../provenance/types'
import { continueProvenanceRepair, getProvenanceRepairRun, listProvenanceRepairItems, repairProvenance } from '../provenance/repair'

export const provenanceRepairRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
provenanceRepairRoutes.use('*', authMiddleware)

function isAdmin(c: { get: (key: 'user') => AuthVariables['user'] }): boolean {
  return c.get('user').role === 'admin'
}

function parseScope(input: Record<string, unknown>): RepairScope | null {
  const candidate = input.scope && typeof input.scope === 'object' && !Array.isArray(input.scope)
    ? input.scope as Record<string, unknown>
    : input
  if (typeof candidate.worldId !== 'string' || !candidate.worldId.trim()
    || typeof candidate.timelineId !== 'string' || !candidate.timelineId.trim()
    || typeof candidate.residentId !== 'string' || !candidate.residentId.trim()) return null
  const recordKinds = candidate.recordKinds === undefined ? ['knowledge_fact', 'memory'] : candidate.recordKinds
  if (!Array.isArray(recordKinds) || recordKinds.some(kind => kind !== 'knowledge_fact' && kind !== 'memory')) return null
  const ruleVersion = candidate.ruleVersion === undefined ? 'message-provenance/v1' : candidate.ruleVersion
  if (ruleVersion !== 'message-provenance/v1') return null
  const scope: RepairScope = {
    worldId: candidate.worldId.trim(), timelineId: candidate.timelineId.trim(), residentId: candidate.residentId.trim(),
    recordKinds: [...new Set(recordKinds)] as RepairScope['recordKinds'], ruleVersion,
  }
  if (typeof candidate.createdFrom === 'string' && candidate.createdFrom) scope.createdFrom = candidate.createdFrom
  if (typeof candidate.createdThrough === 'string' && candidate.createdThrough) scope.createdThrough = candidate.createdThrough
  return scope
}

provenanceRepairRoutes.post('/provenance-repair', async c => {
  if (!isAdmin(c)) return c.json({ error: '仅管理员可操作来源修复' }, 403)
  const body = await c.req.json<unknown>().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: '请求参数无效' }, 400)
  const input = body as Record<string, unknown>
  const scope = parseScope(input)
  const batchSize = input.batchSize === undefined ? 20 : input.batchSize
  if (!scope || typeof batchSize !== 'number' || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) {
    return c.json({ error: 'worldId、timelineId、residentId、recordKinds 或 batchSize 无效' }, 400)
  }
  try {
    const run = await repairProvenance(createDb(c.env.DB), { scope, batchSize })
    return c.json(run)
  } catch (error) {
    const message = error instanceof Error ? error.message : '来源修复失败'
    const status = message.includes('不存在') || message.includes('范围无效') ? 404 : 400
    return c.json({ error: message }, status)
  }
})

provenanceRepairRoutes.get('/provenance-repair/:runId', async c => {
  if (!isAdmin(c)) return c.json({ error: '仅管理员可读取来源修复状态' }, 403)
  const run = await getProvenanceRepairRun(createDb(c.env.DB), c.req.param('runId'))
  return run ? c.json(run) : c.json({ error: '来源修复任务不存在' }, 404)
})

provenanceRepairRoutes.post('/provenance-repair/:runId/continue', async c => {
  if (!isAdmin(c)) return c.json({ error: '仅管理员可继续来源修复' }, 403)
  const body = await c.req.json<unknown>().catch(() => ({}))
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  const batchSize = input.batchSize === undefined ? undefined : input.batchSize
  if (batchSize !== undefined && (typeof batchSize !== 'number' || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50)) {
    return c.json({ error: 'batchSize 范围为 1–50' }, 400)
  }
  try {
    const run = await continueProvenanceRepair(createDb(c.env.DB), c.req.param('runId'), batchSize as number | undefined)
    return c.json(run)
  } catch (error) {
    const message = error instanceof Error ? error.message : '来源修复失败'
    return c.json({ error: message }, message.includes('不存在') ? 404 : 400)
  }
})

provenanceRepairRoutes.get('/provenance-repair/:runId/items', async c => {
  if (!isAdmin(c)) return c.json({ error: '仅管理员可读取来源修复明细' }, 403)
  const db = createDb(c.env.DB)
  const exists = await db.select({ runId: provenanceRepairRuns.runId }).from(provenanceRepairRuns)
    .where(eq(provenanceRepairRuns.runId, c.req.param('runId'))).get()
  if (!exists) return c.json({ error: '来源修复任务不存在' }, 404)
  const page = await listProvenanceRepairItems(db, c.req.param('runId'), {
    cursor: c.req.query('cursor'), limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
  })
  return c.json(page)
})
