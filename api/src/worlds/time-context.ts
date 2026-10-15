import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { timelines, universeEvidence, universeRevisions, worlds } from '../db/schema'
import type { AccessContext } from '../access/types'
import { effectiveTimeZone } from './time-zone'
import {
  describeTimelineStatus,
  describeWorldStatus,
  normalizeTimelineStatus,
  normalizeWorldStatus,
  normalizeWorldStatusReason,
  type VisitContext,
  type WorldTimeContext,
} from '@possibility/world-contract'
import { readOwnedVisitContexts, UNKNOWN_VISIT_CONTEXT } from '../life/visit-context'
import { capabilityView } from './status'

export interface TimeContextTarget {
  worldId: string
  timelineId?: string
  visit?: VisitContext
}

export interface OwnedWorldSummary {
  id: string
  name: string
  status: string
  pauseReason: string | null
  isDemo: boolean
  timeZone: string | null
}

export interface OwnedTimelineSummary {
  id: string
  worldId: string
  parentTimelineId: string | null
  simNow: string
  status: string
}

export interface OwnedWorldContexts {
  worlds: readonly OwnedWorldSummary[]
  timelines: readonly OwnedTimelineSummary[]
  byTimeline: ReadonlyMap<string, WorldTimeContext>
}

type UserAccess = Extract<AccessContext, { kind: 'user' }>

interface TimeContextSource {
  worldId: string
  timelineId: string
  simNow: string
  timeZone: string
  stateVersion: number
  worldStatus: ReturnType<typeof normalizeWorldStatus>
  worldReason: ReturnType<typeof normalizeWorldStatusReason>
  timelineStatus: ReturnType<typeof normalizeTimelineStatus>
  access: WorldTimeContext['access']
}

function sourceFor(
  world: typeof worlds.$inferSelect,
  timeline: typeof timelines.$inferSelect,
  revision: typeof universeRevisions.$inferSelect | null | undefined,
  evidenceLevel: string | null | undefined,
  access: AccessContext,
): TimeContextSource {
  const worldStatus = normalizeWorldStatus(world.status)
  const worldReason = normalizeWorldStatusReason(world.pauseReason)
  const timelineStatus = normalizeTimelineStatus(timeline.status)
  const ownsWorld = access.kind === 'user'
    ? access.userId === world.userId
    : access.kind === 'guest'
      ? access.ownerId === world.userId && access.worldId === world.id
      : false
  return {
    worldId: world.id,
    timelineId: timeline.id,
    simNow: timeline.simNow,
    timeZone: effectiveTimeZone(world.timeZone),
    stateVersion: revision?.version ?? 0,
    worldStatus,
    worldReason,
    timelineStatus,
    access: capabilityView({ access, ownsWorld, worldStatus, timelineStatus, evidenceComplete: evidenceLevel === 'complete' }),
  }
}

function projectTimeContext(source: TimeContextSource, visit: VisitContext): WorldTimeContext {
  return {
    worldId: source.worldId,
    timelineId: source.timelineId,
    simNow: source.simNow,
    timeZone: source.timeZone,
    stateVersion: source.stateVersion,
    revisionVersion: source.stateVersion,
    world: {
      status: source.worldStatus,
      reason: source.worldReason,
      view: describeWorldStatus(source.worldStatus, source.worldReason),
    },
    timeline: { status: source.timelineStatus, view: describeTimelineStatus(source.timelineStatus) },
    access: source.access,
    visit,
  }
}

export async function readOwnedWorldContexts(db: Db, access: UserAccess): Promise<OwnedWorldContexts> {
  const rows = await db.select({
    world: worlds,
    timeline: timelines,
    revision: universeRevisions,
    evidenceLevel: universeEvidence.level,
  })
    .from(worlds)
    .leftJoin(timelines, eq(timelines.worldId, worlds.id))
    .leftJoin(universeRevisions, eq(universeRevisions.timelineId, timelines.id))
    .leftJoin(universeEvidence, eq(universeEvidence.timelineId, timelines.id))
    .where(eq(worlds.userId, access.userId))
    .all()
  const visitsByTimeline = await readOwnedVisitContexts(db, access)
  const worldsById = new Map<string, OwnedWorldSummary>()
  const ownedTimelines: OwnedTimelineSummary[] = []
  const byTimeline = new Map<string, WorldTimeContext>()

  for (const row of rows) {
    const world = row.world
    if (!worldsById.has(world.id)) worldsById.set(world.id, {
      id: world.id,
      name: world.name,
      status: world.status,
      pauseReason: world.pauseReason,
      isDemo: world.isDemo,
      timeZone: world.timeZone,
    })
    if (!row.timeline) continue
    const timeline = row.timeline
    ownedTimelines.push({
      id: timeline.id,
      worldId: world.id,
      parentTimelineId: timeline.parentTimelineId,
      simNow: timeline.simNow,
      status: timeline.status,
    })
    byTimeline.set(timeline.id, projectTimeContext(
      sourceFor(world, timeline, row.revision, row.evidenceLevel, access),
      visitsByTimeline.get(timeline.id) ?? UNKNOWN_VISIT_CONTEXT,
    ))
  }

  return { worlds: [...worldsById.values()], timelines: ownedTimelines, byTimeline }
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
  const [revision, evidence] = await Promise.all([
    db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timeline.id)).get(),
    db.select({ level: universeEvidence.level }).from(universeEvidence).where(eq(universeEvidence.timelineId, timeline.id)).get(),
  ])
  return projectTimeContext(
    sourceFor(world, timeline, revision, evidence?.level, access),
    target.visit ?? UNKNOWN_VISIT_CONTEXT,
  )
}
