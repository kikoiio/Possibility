import { Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { ancestorCutoffs, readForkSnapshot, selectVisibleEvents, type Timeline } from '../agent/visibility'
import { createDb, type Db } from '../db/client'
import { events, personStates, timelines, worlds } from '../db/schema'
import type { Env } from '../index'

function forkEvidence(child: Timeline | undefined) {
  if (!child) return null
  const snapshot = readForkSnapshot(child)
  return {
    forkTimelineId: child.id,
    sourceTimelineId: child.parentTimelineId,
    sourceSimTime: snapshot?.sourceSimTime ?? null,
    capturedAt: snapshot?.capturedAt ?? child.createdAt,
    provenance: snapshot ? 'snapshot' as const : 'legacy' as const,
    states: snapshot?.states ?? null,
    eventIds: snapshot?.events.map((e) => e.id) ?? null,
  }
}

/** A shared ancestor is evidence of lineage, not proof that a changed variable caused an outcome. */
export function sharedForkOrigin(left: Timeline, right: Timeline, worldTimelines: Timeline[]) {
  const leftPath = [left.id, ...ancestorCutoffs(left, worldTimelines).map((a) => a.timelineId)]
  const rightPath = [right.id, ...ancestorCutoffs(right, worldTimelines).map((a) => a.timelineId)]
  const commonId = leftPath.find((id) => rightPath.includes(id))
  if (!commonId) return null
  const leftChildId = leftPath[leftPath.indexOf(commonId) - 1]
  const rightChildId = rightPath[rightPath.indexOf(commonId) - 1]
  return {
    timelineId: commonId,
    leftFork: forkEvidence(worldTimelines.find((t) => t.id === leftChildId)),
    rightFork: forkEvidence(worldTimelines.find((t) => t.id === rightChildId)),
  }
}

export async function compareTimelines(db: Db, worldId: string, leftId: string, rightId: string) {
  // One read transaction keeps state, clocks, and event evidence on the same database snapshot.
  const [worldTimelines, states, eventRows] = await db.batch([
    db.select().from(timelines).where(eq(timelines.worldId, worldId)),
    db.select().from(personStates).where(inArray(personStates.timelineId,
      db.select({ id: timelines.id }).from(timelines).where(and(eq(timelines.worldId, worldId), inArray(timelines.id, [leftId, rightId]))))),
    db.select().from(events).where(inArray(events.timelineId,
      db.select({ id: timelines.id }).from(timelines).where(eq(timelines.worldId, worldId)))),
  ])
  const left = worldTimelines.find((t) => t.id === leftId)
  const right = worldTimelines.find((t) => t.id === rightId)
  if (!left || !right) return null

  const leftEvents = selectVisibleEvents(eventRows, left, worldTimelines)
  const rightEvents = selectVisibleEvents(eventRows, right, worldTimelines)
  const leftEventIds = new Set(leftEvents.events.map((e) => e.id))
  const rightEventIds = new Set(rightEvents.events.map((e) => e.id))
  const fields = ['location', 'activity', 'mood', 'goal'] as const
  const evidence = (state: typeof personStates.$inferSelect | undefined) => state ? {
    table: 'person_states', personId: state.personId, timelineId: state.timelineId,
    simTime: state.simTime, updatedRealAt: state.updatedRealAt,
  } : null
  const stateDifferences = [...new Set(states.map((s) => s.personId))].sort().flatMap((personId) => {
    const l = states.find((s) => s.personId === personId && s.timelineId === leftId)
    const r = states.find((s) => s.personId === personId && s.timelineId === rightId)
    const changes = fields.filter((field) => l?.[field] !== r?.[field]).map((field) => ({
      field, left: l?.[field] ?? null, right: r?.[field] ?? null,
      leftEvidence: evidence(l), rightEvidence: evidence(r),
    }))
    return changes.length ? [{ personId, changes }] : []
  })
  const timelineEvidence = (t: Timeline, historyComplete: boolean) => ({
    id: t.id, simNow: t.simNow, status: t.status, parentTimelineId: t.parentTimelineId, historyComplete,
  })
  return {
    worldId,
    interpretation: 'observed_differences_not_causal_claims' as const,
    timeAlignment: left.simNow === right.simNow ? 'same_sim_time' as const : 'different_sim_times' as const,
    left: timelineEvidence(left, leftEvents.historyComplete),
    right: timelineEvidence(right, rightEvents.historyComplete),
    sharedForkOrigin: sharedForkOrigin(left, right, worldTimelines),
    differences: {
      states: stateDifferences,
      events: {
        shared: leftEvents.events.filter((e) => rightEventIds.has(e.id)),
        leftOnly: leftEvents.events.filter((e) => !rightEventIds.has(e.id)),
        rightOnly: rightEvents.events.filter((e) => !leftEventIds.has(e.id)),
      },
    },
    limitations: [
      'State values are current observations at each timeline’s own simNow; event differences identify records, not causes.',
      ...(!leftEvents.historyComplete || !rightEvents.historyComplete
        ? ['Legacy fork history lacks an immutable event snapshot; unavailable ancestor events are omitted.'] : []),
    ],
  }
}

/** Mount at / (or the application's shared API prefix). GET performs no writes or LLM calls. */
export const comparisonRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
comparisonRoutes.use('*', authMiddleware)
comparisonRoutes.get('/worlds/:id/compare', async (c) => {
  const db = createDb(c.env.DB)
  const world = await db.select({ id: worlds.id }).from(worlds)
    .where(and(eq(worlds.id, c.req.param('id')), eq(worlds.userId, c.get('user').id))).get()
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const left = c.req.query('left')?.trim()
  const right = c.req.query('right')?.trim()
  if (!left || !right) return c.json({ error: 'left 与 right 时间线必填' }, 400)
  const comparison = await compareTimelines(db, world.id, left, right)
  if (!comparison) return c.json({ error: '时间线不存在' }, 404)
  return c.json(comparison)
})
