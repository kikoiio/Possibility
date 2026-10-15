import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { timelines, universeEvidence, universeRevisions, worlds } from '../db/schema'
import type { AccessContext } from '../access/types'
import { effectiveTimeZone } from './time-zone'
import { capabilityView, normalizeTimelineStatus, normalizeWorldStatus, normalizeWorldStatusReason, timelineStatusView, worldStatusView, type VisitContext, type WorldTimeContext } from './status'

export interface TimeContextTarget {
  worldId: string
  timelineId?: string
  visit?: VisitContext
}

export async function readWorldTimeContext(
  db: Db,
  access: AccessContext,
  target: TimeContextTarget,
): Promise<WorldTimeContext | null> {
  const world = await db.select().from(worlds).where(eq(worlds.id, target.worldId)).get()
  if (!world) return null
  const canRead = access.kind === 'user'
    ? world.userId === access.userId
    : access.kind === 'guest'
      ? world.id === access.worldId && world.userId === access.ownerId
      : world.isDemo
  if (!canRead) return null
  const timeline = target.timelineId
    ? await db.select().from(timelines).where(and(eq(timelines.id, target.timelineId), eq(timelines.worldId, world.id))).get()
    : await db.select().from(timelines).where(and(eq(timelines.worldId, world.id), isNull(timelines.parentTimelineId))).get()
  if (!timeline) return null
  const revision = await db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timeline.id)).get()
  const evidence = await db.select({ level: universeEvidence.level }).from(universeEvidence).where(eq(universeEvidence.timelineId, timeline.id)).get()
  const ownsWorld = access.kind === 'user' ? access.userId === world.userId : access.kind === 'guest' ? access.ownerId === world.userId && access.worldId === world.id : false
  const worldStatus = normalizeWorldStatus(world.status)
  const worldReason = normalizeWorldStatusReason(world.pauseReason)
  const timelineStatus = normalizeTimelineStatus(timeline.status)
  return {
    worldId: world.id,
    timelineId: timeline.id,
    simNow: timeline.simNow,
    timeZone: effectiveTimeZone(world.timeZone),
    stateVersion: revision?.version ?? 0,
    revisionVersion: revision?.version ?? 0,
    world: { status: worldStatus, reason: worldReason, view: worldStatusView(worldStatus, worldReason) },
    timeline: { status: timelineStatus, view: timelineStatusView(timelineStatus) },
    access: capabilityView({ access, ownsWorld, worldStatus, timelineStatus, evidenceComplete: evidence?.level === 'complete' }),
    visit: target.visit ?? { phase: 'unknown', sessionId: null, enteredSimTime: null, previousExitedSimTime: null, hasValidPreviousWatermark: false },
  }
}
