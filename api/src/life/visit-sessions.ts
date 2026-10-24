import { and, eq } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../db/client'
import { worldVisitRequests, worldVisitSessions } from '../db/schema'
import type { AccessContext } from '../access/types'
import type { WorldTimeContext } from '@possibility/world-contract'
import { readWorldTimeContext } from '../worlds/time-context'
import { readVisitContext } from './visit-context'

export interface VisitRequest {
  worldId: string
  timelineId: string
  clientSessionId: string
  requestId: string
}

interface Principal {
  key: string
  userId: string | null
  guestSessionId: string | null
}

type VisitOperation = 'enter' | 'leave'
type VisitReceipt = typeof worldVisitRequests.$inferSelect

export interface VisitResult {
  context: WorldTimeContext
  requestId: string
}

function principalFor(access: AccessContext): Principal | null {
  if (access.kind === 'user') return { key: `user:${access.userId}`, userId: access.userId, guestSessionId: null }
  if (access.kind === 'guest') return { key: `guest:${access.sessionId}`, userId: null, guestSessionId: access.sessionId }
  return null
}

function validateRequest(input: VisitRequest): string | null {
  if (!input.worldId || !input.timelineId) return '世界和时间线必填'
  if (!input.clientSessionId || input.clientSessionId.length > 200) return 'clientSessionId 无效'
  if (!input.requestId || input.requestId.length > 200) return 'requestId 无效'
  return null
}

export class VisitServiceError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 404 | 409 = 400) {
    super(message)
    this.name = 'VisitServiceError'
  }
}

interface AuthorizedVisitTarget {
  principal: Principal
  context: WorldTimeContext
}

async function requireVisitTarget(db: Db, access: AccessContext, input: VisitRequest): Promise<AuthorizedVisitTarget> {
  const invalid = validateRequest(input)
  if (invalid) throw new VisitServiceError(invalid, 400)
  const principal = principalFor(access)
  if (!principal) throw new VisitServiceError('未登录或访客体验已失效', 401)
  const context = await readWorldTimeContext(db, access, { worldId: input.worldId, timelineId: input.timelineId })
  if (!context || !context.access.capabilities.read) throw new VisitServiceError('世界或时间线不存在', 404)
  return { principal, context }
}

async function readReceipt(db: Db, principalKey: string, requestId: string): Promise<VisitReceipt | null> {
  return await db.select().from(worldVisitRequests).where(and(
    eq(worldVisitRequests.principalKey, principalKey),
    eq(worldVisitRequests.requestId, requestId),
  )).get() ?? null
}

function receiptMatches(
  receipt: VisitReceipt,
  principal: Principal,
  input: VisitRequest,
  operation: VisitOperation,
): boolean {
  return receipt.kind === 'request'
    && receipt.operation === operation
    && receipt.worldId === input.worldId
    && receipt.timelineId === input.timelineId
    && receipt.clientSessionId === input.clientSessionId
    && receipt.principalKey === principal.key
}

async function applyVisit(
  db: Db,
  access: AccessContext,
  input: VisitRequest,
  operation: VisitOperation,
  now: Date,
): Promise<VisitResult> {
  const { principal, context } = await requireVisitTarget(db, access, input)
  const nowIso = now.toISOString()
  const requestReceipt = db.insert(worldVisitRequests).values({
    principalKey: principal.key,
    requestId: input.requestId,
    kind: 'request',
    operation,
    worldId: input.worldId,
    timelineId: input.timelineId,
    clientSessionId: input.clientSessionId,
    acceptedAt: nowIso,
  })

  const sessionTransition = operation === 'enter'
    ? db.insert(worldVisitSessions).values({
      id: crypto.randomUUID(),
      principalKey: principal.key,
      userId: principal.userId,
      guestSessionId: principal.guestSessionId,
      worldId: input.worldId,
      timelineId: input.timelineId,
      clientSessionId: input.clientSessionId,
      status: 'open',
      enteredSimTime: context.simNow,
      enteredAt: nowIso,
      exitedSimTime: null,
      exitedAt: null,
      lastRequestId: input.requestId,
      createdAt: nowIso,
      updatedAt: nowIso,
    }).onConflictDoUpdate({
      target: [
        worldVisitSessions.principalKey,
        worldVisitSessions.worldId,
        worldVisitSessions.timelineId,
        worldVisitSessions.clientSessionId,
      ],
      set: {
        status: 'open',
        enteredSimTime: context.simNow,
        enteredAt: nowIso,
        lastRequestId: input.requestId,
        updatedAt: nowIso,
      },
    })
    : db.update(worldVisitSessions).set({
      status: 'closed',
      exitedSimTime: context.simNow,
      exitedAt: nowIso,
      lastRequestId: input.requestId,
      updatedAt: nowIso,
    }).where(and(
      eq(worldVisitSessions.principalKey, principal.key),
      eq(worldVisitSessions.worldId, input.worldId),
      eq(worldVisitSessions.timelineId, input.timelineId),
      eq(worldVisitSessions.clientSessionId, input.clientSessionId),
      eq(worldVisitSessions.status, 'open'),
    ))

  const writes: [BatchItem<'sqlite'>, BatchItem<'sqlite'>] = [requestReceipt, sessionTransition]
  try {
    await db.batch(writes)
  } catch (error) {
    const prior = await readReceipt(db, principal.key, input.requestId)
    if (!prior) throw error
    if (!receiptMatches(prior, principal, input, operation)) {
      throw new VisitServiceError('requestId 已用于其他访问操作', 409)
    }
  }

  const visit = await readVisitContext(db, access, {
    worldId: input.worldId,
    timelineId: input.timelineId,
    clientSessionId: input.clientSessionId,
  })
  return { context: { ...context, visit }, requestId: input.requestId }
}

/** Explicitly establish or reuse a visit session. This does not write world facts. */
export async function enterVisit(db: Db, access: AccessContext, input: VisitRequest, now = new Date()): Promise<VisitResult> {
  return applyVisit(db, access, input, 'enter', now)
}

/** Close the current session idempotently; no simulation or history write occurs. */
export async function leaveVisit(db: Db, access: AccessContext, input: VisitRequest, now = new Date()): Promise<VisitResult> {
  return applyVisit(db, access, input, 'leave', now)
}
