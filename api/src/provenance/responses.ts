import { and, asc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  conversations,
  provenanceResponseAttempts,
  provenanceResponseSnapshots,
} from '../db/schema'
import type {
  EvidenceSnapshot,
  GroundedResponse,
  ResponseAttemptResult,
} from './types'

export interface ResponseSnapshotInput {
  responseId?: string
  chatRequestId: string
  conversationId: string
  worldId: string
  timelineId: string
  residentId: string
  userId: string
  question: string
  snapshot: EvidenceSnapshot
  now?: Date
}

export interface ResponseAttemptInput {
  responseId: string
  attemptId: string
  now?: Date
}

export class ResponsePersistenceError extends Error {
  readonly status: 400 | 403 | 404 | 409
  constructor(message: string, status: 400 | 403 | 404 | 409 = 409) {
    super(message)
    this.name = 'ResponsePersistenceError'
    this.status = status
  }
}

function hashText(value: string): string {
  // This is only an idempotency fingerprint. Keeping it synchronous avoids
  // making the response reservation depend on provider/runtime crypto APIs.
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function parseSnapshot(value: string): EvidenceSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const candidate = parsed as Partial<EvidenceSnapshot>
    if (candidate.schemaVersion !== 1 || typeof candidate.snapshotId !== 'string'
      || !candidate.scope || !Array.isArray(candidate.records) || !Array.isArray(candidate.groups)) return null
    return parsed as EvidenceSnapshot
  } catch {
    return null
  }
}

function parseResponse(value: string | null): GroundedResponse | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const candidate = parsed as Partial<GroundedResponse>
    if (typeof candidate.snapshotId !== 'string' || typeof candidate.body !== 'string'
      || !Array.isArray(candidate.statements) || !Array.isArray(candidate.sources)
      || (candidate.mode !== 'grounded' && candidate.mode !== 'fallback')) return null
    return parsed as GroundedResponse
  } catch {
    return null
  }
}

export type ResponseSnapshotRow = typeof provenanceResponseSnapshots.$inferSelect
export type ResponseAttemptRow = typeof provenanceResponseAttempts.$inferSelect

export function snapshotFromRow(row: ResponseSnapshotRow): EvidenceSnapshot {
  const snapshot = parseSnapshot(row.snapshotJson)
  if (!snapshot) throw new ResponsePersistenceError('来源快照已损坏，不能重试', 409)
  return snapshot
}

export function responseFromAttempt(row: ResponseAttemptRow): GroundedResponse | null {
  return parseResponse(row.outputJson)
}

/**
 * Saves the immutable source snapshot for a chat request. A second call for
 * the same chat request is a read if every identity/fingerprint matches; it
 * cannot silently replace the snapshot with a newer world view.
 */
export async function ensureResponseSnapshot(
  db: Db,
  input: ResponseSnapshotInput,
): Promise<{ row: ResponseSnapshotRow; snapshot: EvidenceSnapshot; created: boolean }> {
  const question = input.question.trim()
  if (!question || question.length > 20_000) throw new ResponsePersistenceError('问题内容无效', 400)
  if (!input.chatRequestId || !input.conversationId || !input.worldId || !input.timelineId || !input.residentId || !input.userId) {
    throw new ResponsePersistenceError('回答来源上下文不完整', 400)
  }
  const questionHash = hashText(question)
  const prior = await db.select().from(provenanceResponseSnapshots)
    .where(eq(provenanceResponseSnapshots.chatRequestId, input.chatRequestId)).get()
  if (prior) {
    if (prior.conversationId !== input.conversationId || prior.userId !== input.userId
      || prior.questionHash !== questionHash || prior.worldId !== input.worldId
      || prior.timelineId !== input.timelineId || prior.residentId !== input.residentId) {
      throw new ResponsePersistenceError('同一聊天请求不能替换来源快照', 409)
    }
    return { row: prior, snapshot: snapshotFromRow(prior), created: false }
  }

  const now = (input.now ?? new Date()).toISOString()
  const responseId = input.responseId?.trim() || `provenance-response:${input.chatRequestId}`
  const values: typeof provenanceResponseSnapshots.$inferInsert = {
    responseId,
    chatRequestId: input.chatRequestId,
    conversationId: input.conversationId,
    worldId: input.worldId,
    timelineId: input.timelineId,
    residentId: input.residentId,
    userId: input.userId,
    question,
    questionHash,
    snapshotId: input.snapshot.snapshotId,
    schemaVersion: input.snapshot.schemaVersion,
    snapshotJson: JSON.stringify(input.snapshot),
    createdAt: now,
  }
  try {
    await db.insert(provenanceResponseSnapshots).values(values)
  } catch (error) {
    const raced = await db.select().from(provenanceResponseSnapshots)
      .where(eq(provenanceResponseSnapshots.chatRequestId, input.chatRequestId)).get()
    if (!raced) throw error
    if (raced.questionHash !== questionHash || raced.userId !== input.userId) {
      throw new ResponsePersistenceError('同一聊天请求不能替换来源快照', 409)
    }
    return { row: raced, snapshot: snapshotFromRow(raced), created: false }
  }
  const row = await db.select().from(provenanceResponseSnapshots).where(eq(provenanceResponseSnapshots.responseId, responseId)).get()
  if (!row) throw new ResponsePersistenceError('来源快照保存失败', 409)
  return { row, snapshot: input.snapshot, created: true }
}

export async function readResponseSnapshot(
  db: Db,
  responseId: string,
  userId: string,
): Promise<{ row: ResponseSnapshotRow; snapshot: EvidenceSnapshot } | null> {
  const row = await db.select().from(provenanceResponseSnapshots).where(and(
    eq(provenanceResponseSnapshots.responseId, responseId),
    eq(provenanceResponseSnapshots.userId, userId),
  )).get()
  return row ? { row, snapshot: snapshotFromRow(row) } : null
}

/** Creates or reads an attempt; an existing attemptId is never rebound. */
export async function ensureResponseAttempt(
  db: Db,
  input: ResponseAttemptInput,
): Promise<{ row: ResponseAttemptRow; created: boolean }> {
  if (!input.responseId || !input.attemptId || input.attemptId.length > 120) {
    throw new ResponsePersistenceError('回答尝试 ID 无效', 400)
  }
  const prior = await db.select().from(provenanceResponseAttempts)
    .where(eq(provenanceResponseAttempts.attemptId, input.attemptId)).get()
  if (prior) {
    if (prior.responseId !== input.responseId) throw new ResponsePersistenceError('回答尝试已绑定其他来源快照', 409)
    return { row: prior, created: false }
  }
  const now = (input.now ?? new Date()).toISOString()
  const values: typeof provenanceResponseAttempts.$inferInsert = {
    attemptId: input.attemptId,
    responseId: input.responseId,
    status: 'pending',
    stage: 'reading',
    outputJson: null,
    errorCode: null,
    leaseToken: null,
    leaseGeneration: 0,
    leaseExpiresAt: null,
    createdAt: now,
    finishedAt: null,
  }
  try { await db.insert(provenanceResponseAttempts).values(values) }
  catch (error) {
    const raced = await db.select().from(provenanceResponseAttempts).where(eq(provenanceResponseAttempts.attemptId, input.attemptId)).get()
    if (!raced) throw error
    if (raced.responseId !== input.responseId) throw new ResponsePersistenceError('回答尝试已绑定其他来源快照', 409)
    return { row: raced, created: false }
  }
  const row = await db.select().from(provenanceResponseAttempts).where(eq(provenanceResponseAttempts.attemptId, input.attemptId)).get()
  if (!row) throw new ResponsePersistenceError('回答尝试保存失败', 409)
  return { row, created: true }
}

export async function claimResponseAttempt(
  db: Db,
  attemptId: string,
  leaseToken: string,
  leaseMs = 30_000,
  now = new Date(),
): Promise<ResponseAttemptRow | null> {
  if (!leaseToken || leaseMs < 1_000 || leaseMs > 300_000) throw new ResponsePersistenceError('回答执行租约无效', 400)
  const expires = new Date(now.getTime() + leaseMs).toISOString()
  const current = await db.select().from(provenanceResponseAttempts).where(eq(provenanceResponseAttempts.attemptId, attemptId)).get()
  if (!current) return null
  const activeLease = current.leaseExpiresAt && current.leaseExpiresAt > now.toISOString()
  if (current.status !== 'pending' || (activeLease && current.leaseToken !== leaseToken)) return current
  const rows = await db.update(provenanceResponseAttempts).set({
    stage: 'generating', leaseToken, leaseGeneration: current.leaseGeneration + 1, leaseExpiresAt: expires,
  }).where(and(eq(provenanceResponseAttempts.attemptId, attemptId), eq(provenanceResponseAttempts.status, 'pending'))).returning().all()
  return rows[0] ?? await db.select().from(provenanceResponseAttempts).where(eq(provenanceResponseAttempts.attemptId, attemptId)).get() ?? null
}

export async function completeResponseAttempt(
  db: Db,
  attemptId: string,
  response: GroundedResponse,
  leaseToken?: string,
  now = new Date(),
): Promise<ResponseAttemptRow> {
  const where = [eq(provenanceResponseAttempts.attemptId, attemptId), eq(provenanceResponseAttempts.status, 'pending')]
  if (leaseToken) where.push(eq(provenanceResponseAttempts.leaseToken, leaseToken))
  const rows = await db.update(provenanceResponseAttempts).set({
    status: 'completed', stage: 'saving', outputJson: JSON.stringify(response), errorCode: null,
    leaseExpiresAt: null, finishedAt: now.toISOString(),
  }).where(and(...where)).returning().all()
  if (!rows[0]) {
    const existing = await db.select().from(provenanceResponseAttempts).where(eq(provenanceResponseAttempts.attemptId, attemptId)).get()
    if (existing?.status === 'completed') return existing
    throw new ResponsePersistenceError('回答尝试已被其他执行者结束', 409)
  }
  return rows[0]
}

export async function failResponseAttempt(
  db: Db,
  attemptId: string,
  errorCode: string,
  canRetry = true,
  leaseToken?: string,
  now = new Date(),
): Promise<ResponseAttemptRow | null> {
  const where = [eq(provenanceResponseAttempts.attemptId, attemptId), eq(provenanceResponseAttempts.status, 'pending')]
  if (leaseToken) where.push(eq(provenanceResponseAttempts.leaseToken, leaseToken))
  const rows = await db.update(provenanceResponseAttempts).set({
    status: 'failed', stage: 'saving', errorCode: `${errorCode}${canRetry ? '' : ':terminal'}`,
    leaseExpiresAt: null, finishedAt: now.toISOString(),
  }).where(and(...where)).returning().all()
  return rows[0] ?? await db.select().from(provenanceResponseAttempts).where(eq(provenanceResponseAttempts.attemptId, attemptId)).get() ?? null
}

export async function getResponseAttempt(
  db: Db,
  attemptId: string,
  userId: string,
): Promise<ResponseAttemptResult | null> {
  const row = await db.select({ attempt: provenanceResponseAttempts, snapshot: provenanceResponseSnapshots })
    .from(provenanceResponseAttempts)
    .innerJoin(provenanceResponseSnapshots, eq(provenanceResponseAttempts.responseId, provenanceResponseSnapshots.responseId))
    .where(and(eq(provenanceResponseAttempts.attemptId, attemptId), eq(provenanceResponseSnapshots.userId, userId))).get()
  if (!row) return null
  const attempt = row.attempt
  if (attempt.status === 'pending') {
    return { status: 'pending', responseId: attempt.responseId, attemptId: attempt.attemptId, stage: attempt.stage as 'reading' | 'generating' | 'validating' | 'saving' }
  }
  if (attempt.status === 'completed') {
    const response = responseFromAttempt(attempt)
    if (!response) throw new ResponsePersistenceError('回答结果已损坏，不能展示', 409)
    return { status: 'completed', responseId: attempt.responseId, attemptId: attempt.attemptId, response }
  }
  return { status: 'failed', responseId: attempt.responseId, attemptId: attempt.attemptId,
    reason: attempt.errorCode ?? 'generation_failed', canRetry: !attempt.errorCode?.endsWith(':terminal') }
}

export async function listResponseAttempts(db: Db, responseId: string): Promise<ResponseAttemptRow[]> {
  return db.select().from(provenanceResponseAttempts).where(eq(provenanceResponseAttempts.responseId, responseId))
    .orderBy(asc(provenanceResponseAttempts.createdAt)).all()
}

/** Read-only ownership check used by retry endpoints before any generation. */
export async function canReadResponse(db: Db, responseId: string, userId: string): Promise<boolean> {
  const row = await db.select({ id: provenanceResponseSnapshots.responseId })
    .from(provenanceResponseSnapshots)
    .innerJoin(conversations, eq(conversations.id, provenanceResponseSnapshots.conversationId))
    .where(and(eq(provenanceResponseSnapshots.responseId, responseId), eq(provenanceResponseSnapshots.userId, userId), eq(conversations.userId, userId))).get()
  return !!row
}
