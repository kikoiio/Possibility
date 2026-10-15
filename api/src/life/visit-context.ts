import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { timelines, worldVisitSessions, worldVisits, worlds } from '../db/schema'
import type { AccessContext } from '../access/types'
import type { VisitContext } from '@possibility/world-contract'

type UserAccess = Extract<AccessContext, { kind: 'user' }>
type VisitSession = typeof worldVisitSessions.$inferSelect

export const UNKNOWN_VISIT_CONTEXT: VisitContext = {
  phase: 'unknown', sessionId: null, enteredSimTime: null, previousExitedSimTime: null,
  hasValidPreviousWatermark: false,
}

export function projectVisitContext(
  rows: readonly VisitSession[],
  watermark: typeof worldVisits.$inferSelect | null,
  sessionId?: string | null,
): VisitContext {
  const current = sessionId ? rows.find(row => row.id === sessionId) : rows.find(row => row.status === 'open')
  const previous = rows.find(row => row.id !== current?.id && row.exitedAt)
  const hasValidPreviousWatermark = !!previous?.exitedAt || !!watermark
  const phase = current?.status === 'open'
    ? (hasValidPreviousWatermark ? 'returning' : 'first_visit')
    : hasValidPreviousWatermark ? 'returning' : 'unknown'
  return {
    phase,
    sessionId: current?.id ?? null,
    enteredSimTime: current?.enteredSimTime ?? null,
    previousExitedSimTime: previous?.exitedSimTime
      ?? (current?.status === 'closed' ? current.exitedSimTime : null)
      ?? null,
    hasValidPreviousWatermark,
  }
}

/** Reads visit metadata only through timelines attached to worlds owned by this user. */
export async function readOwnedVisitContexts(db: Db, access: UserAccess): Promise<ReadonlyMap<string, VisitContext>> {
  const principalKey = `user:${access.userId}`
  const sessionRows = await db.select({ timelineId: timelines.id, session: worldVisitSessions })
    .from(worldVisitSessions)
    .innerJoin(timelines, and(
      eq(worldVisitSessions.timelineId, timelines.id),
      eq(worldVisitSessions.worldId, timelines.worldId),
    ))
    .innerJoin(worlds, and(
      eq(timelines.worldId, worlds.id),
      eq(worlds.userId, access.userId),
    ))
    .where(and(
      eq(worldVisitSessions.principalKey, principalKey),
      eq(worldVisitSessions.userId, access.userId),
    ))
    .orderBy(desc(worldVisitSessions.updatedAt))
    .all()

  const watermarkRows = await db.select({ timelineId: timelines.id, watermark: worldVisits })
    .from(worldVisits)
    .innerJoin(timelines, eq(worldVisits.timelineId, timelines.id))
    .innerJoin(worlds, and(
      eq(timelines.worldId, worlds.id),
      eq(worlds.userId, access.userId),
    ))
    .where(eq(worldVisits.userId, access.userId))
    .all()

  const sessionsByTimeline = new Map<string, VisitSession[]>()
  for (const { timelineId, session } of sessionRows) {
    const rows = sessionsByTimeline.get(timelineId) ?? []
    rows.push(session)
    sessionsByTimeline.set(timelineId, rows)
  }
  const watermarkByTimeline = new Map(watermarkRows.map(({ timelineId, watermark }) => [timelineId, watermark]))
  const timelineIds = new Set([...sessionsByTimeline.keys(), ...watermarkByTimeline.keys()])
  return new Map([...timelineIds].map(timelineId => [
    timelineId,
    projectVisitContext(sessionsByTimeline.get(timelineId) ?? [], watermarkByTimeline.get(timelineId) ?? null),
  ]))
}

/** Read one target without creating a session or advancing a return watermark. */
export async function readVisitContext(
  db: Db,
  access: AccessContext,
  input: { worldId: string; timelineId: string; sessionId?: string | null },
): Promise<VisitContext> {
  const principal = access.kind === 'user'
    ? { key: `user:${access.userId}`, userId: access.userId }
    : access.kind === 'guest'
      ? { key: `guest:${access.sessionId}`, userId: null }
      : null
  if (!principal) return UNKNOWN_VISIT_CONTEXT

  const rows = await db.select().from(worldVisitSessions).where(and(
    eq(worldVisitSessions.principalKey, principal.key),
    eq(worldVisitSessions.worldId, input.worldId),
    eq(worldVisitSessions.timelineId, input.timelineId),
  )).orderBy(desc(worldVisitSessions.updatedAt)).all()
  const watermark = principal.userId
    ? await db.select().from(worldVisits).where(and(
      eq(worldVisits.userId, principal.userId),
      eq(worldVisits.timelineId, input.timelineId),
    )).get() ?? null
    : null
  return projectVisitContext(rows, watermark, input.sessionId)
}
