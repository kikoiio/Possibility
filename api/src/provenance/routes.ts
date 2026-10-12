import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { accessMiddleware } from '../access/middleware'
import type { AccessVariables } from '../access/types'
import { createDb } from '../db/client'
import { conversations, provenanceResponseSnapshots } from '../db/schema'
import type { Env } from '../index'
import { finalizeGroundedResponse } from './grounding'
import {
  ensureResponseAttempt,
  completeResponseAttempt,
  getResponseAttempt,
  readResponseSnapshot,
  ResponsePersistenceError,
} from './responses'
import { getMessageReceipt, getMessageReceiptById } from './receipts'
import { buildEvidenceSnapshot } from './read'
import { ProvenanceScopeError, resolveEvidenceScope, type ProvenanceAccess } from './scope'
import type { EvidenceQuery, EvidenceTarget } from './types'

export const provenanceRoutes = new Hono<{ Bindings: Env; Variables: AccessVariables }>()
provenanceRoutes.use('*', accessMiddleware)

function accessOf(c: { get(name: 'access'): AccessVariables['access'] }): ProvenanceAccess {
  const access = c.get('access')
  if (access.kind === 'anonymous') throw new ProvenanceScopeError(403, '来源读取需要登录', 'unauthenticated')
  return access
}

function queryInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ProvenanceScopeError(400, '分页参数无效', 'invalid_input')
  return value
}

function targetFromQuery(worldId: string, query: Record<string, string | undefined>): EvidenceTarget {
  if (!query.timelineId || !query.residentId) throw new ProvenanceScopeError(400, 'timelineId 与 residentId 必填', 'invalid_input')
  return {
    worldId,
    timelineId: query.timelineId,
    residentId: query.residentId,
    simNow: query.simNow,
    revisionVersion: query.revisionVersion === undefined ? undefined : queryInt(query.revisionVersion, 0, 0, Number.MAX_SAFE_INTEGER),
  }
}

function queryEvidence(c: { req: { query(name?: string): string | Record<string, string> } }): EvidenceQuery {
  const query = c.req.query() as Record<string, string | undefined>
  const limit = query.limit === undefined ? undefined : queryInt(query.limit, 50, 1, 100)
  return {
    receiptId: query.receiptId,
    topic: query.topic,
    fromSimTime: query.fromSimTime,
    cursor: query.cursor,
    limit,
  }
}

function errorResponse(c: any, error: unknown) {
  if (error instanceof ProvenanceScopeError || error instanceof ResponsePersistenceError) {
    return c.json({ error: error.message, code: 'reasonCode' in error ? error.reasonCode : 'provenance_error' }, error.status)
  }
  if (error instanceof Error && /游标|来源起始时间/.test(error.message)) return c.json({ error: error.message, code: 'invalid_input' }, 400)
  throw error
}

provenanceRoutes.get('/worlds/:id/provenance/receipts/:commandId', async c => {
  try {
    const db = createDb(c.env.DB)
    const access = accessOf(c)
    const query = c.req.query()
    const target = targetFromQuery(c.req.param('id'), query)
    const scope = await resolveEvidenceScope(db, access, target)
    const result = await getMessageReceipt(db, access, scope, c.req.param('commandId'))
    return c.json(result)
  } catch (error) { return errorResponse(c, error) }
})
provenanceRoutes.get('/worlds/:id/provenance/receipts/by-id/:receiptId', async c => {
  try {
    const db = createDb(c.env.DB)
    const access = accessOf(c)
    const target = targetFromQuery(c.req.param('id'), c.req.query())
    const scope = await resolveEvidenceScope(db, access, target)
    return c.json(await getMessageReceiptById(db, access, scope, c.req.param('receiptId')))
  } catch (error) { return errorResponse(c, error) }
})
provenanceRoutes.get('/worlds/:id/provenance/evidence', async c => {
  try {
    const db = createDb(c.env.DB)
    const access = accessOf(c)
    const target = targetFromQuery(c.req.param('id'), c.req.query())
    const scope = await resolveEvidenceScope(db, access, target)
    const snapshot = await buildEvidenceSnapshot(db, access, scope, queryEvidence(c))
    return c.json(snapshot)
  } catch (error) { return errorResponse(c, error) }
})

async function ownedResponse(db: ReturnType<typeof createDb>, responseId: string, userId: string) {
  const row = await db.select({ snapshot: provenanceResponseSnapshots, conversation: conversations })
    .from(provenanceResponseSnapshots)
    .innerJoin(conversations, eq(conversations.id, provenanceResponseSnapshots.conversationId))
    .where(and(eq(provenanceResponseSnapshots.responseId, responseId), eq(provenanceResponseSnapshots.userId, userId), eq(conversations.userId, userId))).get()
  return row?.snapshot ?? null
}

provenanceRoutes.post('/conversations/:id/provenance/responses/:responseId/attempts', async c => {
  try {
    const db = createDb(c.env.DB)
    const access = accessOf(c)
    if (access.kind !== 'user') throw new ProvenanceScopeError(403, '回答重试需要登录账号', 'forbidden')
    const response = await ownedResponse(db, c.req.param('responseId'), access.userId)
    if (!response || response.conversationId !== c.req.param('id')) throw new ProvenanceScopeError(404, '回答来源不存在', 'not_found')
    const body = await c.req.json<{ attemptId?: unknown }>().catch(() => null)
    if (!body || typeof body.attemptId !== 'string' || !body.attemptId.trim() || body.attemptId.length > 120) {
      throw new ResponsePersistenceError('attemptId 必填且长度有效', 400)
    }
    const snapshotRow = await readResponseSnapshot(db, response.responseId, access.userId)
    if (!snapshotRow) throw new ProvenanceScopeError(404, '回答来源不存在', 'not_found')
    const ensured = await ensureResponseAttempt(db, { responseId: response.responseId, attemptId: body.attemptId.trim() })
    if (ensured.row.status === 'pending') {
      // A retry never reads current world state or writes a chat/world row. If a
      // provider is not available, the evidence-backed fallback is still a
      // valid completed result that can be recovered after a disconnect.
      await completeResponseAttempt(db, ensured.row.attemptId,
        finalizeGroundedResponse(snapshotRow.snapshot, null, 'generation_failed'))
    }
    const result = await getResponseAttempt(db, ensured.row.attemptId, access.userId)
    if (!result) throw new ProvenanceScopeError(404, '回答尝试不存在', 'not_found')
    return c.json(result, result.status === 'pending' ? 202 : 200)
  } catch (error) { return errorResponse(c, error) }
})

provenanceRoutes.get('/conversations/:id/provenance/responses/:responseId/attempts/:attemptId', async c => {
  try {
    const db = createDb(c.env.DB)
    const access = accessOf(c)
    if (access.kind !== 'user') throw new ProvenanceScopeError(403, '回答读取需要登录账号', 'forbidden')
    const response = await ownedResponse(db, c.req.param('responseId'), access.userId)
    if (!response || response.conversationId !== c.req.param('id')) throw new ProvenanceScopeError(404, '回答来源不存在', 'not_found')
    const result = await getResponseAttempt(db, c.req.param('attemptId'), access.userId)
    return result ? c.json(result) : c.json({ error: '回答尝试不存在', code: 'not_found' }, 404)
  } catch (error) { return errorResponse(c, error) }
})
