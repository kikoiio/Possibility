import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { timelines, worldVisitSessions, worldVisits } from '../db/schema'
import type { AccessContext } from '../access/types'
import { readWorldTimeContext } from '../worlds/time-context'
import type { VisitContext, WorldTimeContext } from '../worlds/status'

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

async function readTimeline(db: Db, worldId: string, timelineId: string) {
  return db.select().from(timelines).where(and(eq(timelines.id, timelineId), eq(timelines.worldId, worldId))).get()
}

async function readSessions(db: Db, principal: Principal, input: VisitRequest) {
  return db.select().from(worldVisitSessions).where(and(
    eq(worldVisitSessions.principalKey, principal.key),
    eq(worldVisitSessions.worldId, input.worldId),
    eq(worldVisitSessions.timelineId, input.timelineId),
  )).orderBy(desc(worldVisitSessions.updatedAt)).all()
}

/** Read visit phase without creating a session or advancing a return watermark. */
export async function readVisitContext(
  db: Db,
  access: AccessContext,
  input: Pick<VisitRequest, 'worldId' | 'timelineId'> & { sessionId?: string | null },
): Promise<VisitContext> {
  const principal = principalFor(access)
  if (!principal) return { phase: 'unknown', sessionId: null, enteredSimTime: null, previousExitedSimTime: null, hasValidPreviousWatermark: false }
  const rows = await db.select().from(worldVisitSessions).where(and(
    eq(worldVisitSessions.principalKey, principal.key),
    eq(worldVisitSessions.worldId, input.worldId),
    eq(worldVisitSessions.timelineId, input.timelineId),
  )).orderBy(desc(worldVisitSessions.updatedAt)).all()
  const current = input.sessionId ? rows.find(row => row.id === input.sessionId) : rows.find(row => row.status === 'open')
  const previous = rows.find(row => row.id !== current?.id && row.exitedAt)
  const watermark = principal.userId
    ? await db.select().from(worldVisits).where(and(eq(worldVisits.userId, principal.userId), eq(worldVisits.timelineId, input.timelineId))).get()
    : null
  const hasValidPreviousWatermark = !!previous?.exitedAt || !!watermark
  const phase = current?.status === 'open'
    ? (hasValidPreviousWatermark ? 'returning' : 'first_visit')
    : hasValidPreviousWatermark ? 'returning' : 'unknown'
  return {
    phase,
    sessionId: current?.id ?? null,
    enteredSimTime: current?.enteredSimTime ?? null,
    previousExitedSimTime: previous?.exitedSimTime ?? (current?.status === 'closed' ? current.exitedSimTime : null) ?? null,
    hasValidPreviousWatermark,
  }
}

async function contextFor(db: Db, access: AccessContext, input: VisitRequest, visit: VisitContext): Promise<WorldTimeContext> {
  const context = await readWorldTimeContext(db, access, { worldId: input.worldId, timelineId: input.timelineId, visit })
  if (!context) throw new VisitServiceError('世界或时间线不存在', 404)
  if (!context.access.capabilities.read) throw new VisitServiceError('无权访问此世界', 404)
  return context
}

export class VisitServiceError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 404 | 409 = 400) {
    super(message)
    this.name = 'VisitServiceError'
  }
}

/** Explicitly establish or reuse a visit session. This does not write world facts. */
export async function enterVisit(db: Db, access: AccessContext, input: VisitRequest, now = new Date()): Promise<VisitResult> {
  const invalid = validateRequest(input)
  if (invalid) throw new VisitServiceError(invalid, 400)
  const principal = principalFor(access)
  if (!principal) throw new VisitServiceError('未登录或访客体验已失效', 401)
  const timeline = await readTimeline(db, input.worldId, input.timelineId)
  if (!timeline) throw new VisitServiceError('世界或时间线不存在', 404)
  const nowIso = now.toISOString()
  const rows = await readSessions(db, principal, input)
  const existing = rows.find(row => row.clientSessionId === input.clientSessionId)
  if (existing?.lastRequestId === input.requestId) {
    const visit = await readVisitContext(db, access, { ...input, sessionId: existing.id })
    return { context: await contextFor(db, access, input, visit), requestId: input.requestId }
  }

  let sessionId = existing?.id ?? crypto.randomUUID()
  let enteredSimTime = timeline.simNow
  let previousExitedSimTime = existing?.exitedSimTime ?? rows.find(row => row.exitedAt)?.exitedSimTime ?? null
  let phase: VisitContext['phase'] = existing?.status === 'closed' || !!previousExitedSimTime ? 'returning' : 'first_visit'
  if (existing) {
    await db.update(worldVisitSessions).set({
      status: 'open', enteredSimTime: timeline.simNow, enteredAt: nowIso,
      lastRequestId: input.requestId, updatedAt: nowIso,
    }).where(eq(worldVisitSessions.id, existing.id))
  } else {
    await db.insert(worldVisitSessions).values({
      id: sessionId, principalKey: principal.key, userId: principal.userId,
      guestSessionId: principal.guestSessionId, worldId: input.worldId, timelineId: input.timelineId,
      clientSessionId: input.clientSessionId, status: 'open', enteredSimTime: timeline.simNow,
      enteredAt: nowIso, exitedSimTime: null, exitedAt: null, lastRequestId: input.requestId,
      createdAt: nowIso, updatedAt: nowIso,
    }).onConflictDoNothing().run()
    const raced = await db.select().from(worldVisitSessions).where(and(
      eq(worldVisitSessions.principalKey, principal.key), eq(worldVisitSessions.worldId, input.worldId),
      eq(worldVisitSessions.timelineId, input.timelineId), eq(worldVisitSessions.clientSessionId, input.clientSessionId),
    )).get()
    if (!raced) throw new VisitServiceError('访问会话暂时无法建立', 409)
    const insertedSessionId = sessionId
    sessionId = raced.id
    if (raced.id !== insertedSessionId) phase = raced.status === 'closed' || !!raced.exitedAt ? 'returning' : 'first_visit'
    enteredSimTime = raced.enteredSimTime
    previousExitedSimTime = raced.exitedSimTime
  }
  const visit: VisitContext = {
    phase,
    sessionId,
    enteredSimTime,
    previousExitedSimTime,
    hasValidPreviousWatermark: phase === 'returning',
  }
  return { context: await contextFor(db, access, input, visit), requestId: input.requestId }
}

/** Close the current session idempotently; no simulation or history write occurs. */
export async function leaveVisit(db: Db, access: AccessContext, input: VisitRequest, now = new Date()): Promise<VisitResult> {
  const invalid = validateRequest(input)
  if (invalid) throw new VisitServiceError(invalid, 400)
  const principal = principalFor(access)
  if (!principal) throw new VisitServiceError('未登录或访客体验已失效', 401)
  const timeline = await readTimeline(db, input.worldId, input.timelineId)
  if (!timeline) throw new VisitServiceError('世界或时间线不存在', 404)
  const existing = (await readSessions(db, principal, input)).find(row => row.clientSessionId === input.clientSessionId)
  if (!existing) {
    const visit = await readVisitContext(db, access, { ...input, sessionId: null })
    return { context: await contextFor(db, access, input, visit), requestId: input.requestId }
  }
  if (existing.status === 'open' && existing.lastRequestId !== input.requestId) {
    const nowIso = now.toISOString()
    await db.update(worldVisitSessions).set({
      status: 'closed', exitedSimTime: timeline.simNow, exitedAt: nowIso,
      lastRequestId: input.requestId, updatedAt: nowIso,
    }).where(and(eq(worldVisitSessions.id, existing.id), eq(worldVisitSessions.status, 'open')))
  }
  const closed = await db.select().from(worldVisitSessions).where(eq(worldVisitSessions.id, existing.id)).get()
  const visit: VisitContext = {
    phase: 'returning', sessionId: closed?.id ?? existing.id,
    enteredSimTime: closed?.enteredSimTime ?? existing.enteredSimTime,
    previousExitedSimTime: closed?.exitedSimTime ?? existing.exitedSimTime,
    hasValidPreviousWatermark: true,
  }
  return { context: await contextFor(db, access, input, visit), requestId: input.requestId }
}
