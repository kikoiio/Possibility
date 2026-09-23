import { Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { ancestorCutoffs, readForkSnapshot, selectVisibleEvents, type Timeline } from '../agent/visibility'
import { createDb, type Db } from '../db/client'
import { events, personStates, timelines, universeRevisions, worldFacts, worlds } from '../db/schema'
import type { Env } from '../index'

function forkEvidence(child: Timeline | undefined) {
  if (!child) return null
  const snapshot = readForkSnapshot(child)
  let scenario: { whatIf: string | null; startTime: string | null; changedVariable: string | null; participants: string[]; invariants: string[] } | null = null
  try {
    const raw = JSON.parse(child.forkScenarioJson ?? 'null') as Record<string, unknown> | null
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) scenario = {
      whatIf: typeof raw.whatIf === 'string' ? raw.whatIf : null,
      startTime: typeof raw.startTime === 'string' ? raw.startTime : null,
      changedVariable: typeof raw.changedVariable === 'string' ? raw.changedVariable : null,
      participants: Array.isArray(raw.participants) ? raw.participants.filter((item): item is string => typeof item === 'string') : [],
      invariants: Array.isArray(raw.invariants) ? raw.invariants.filter((item): item is string => typeof item === 'string') : [],
    }
  } catch { /* malformed legacy scenario remains unknown */ }
  return {
    forkTimelineId: child.id,
    sourceTimelineId: child.parentTimelineId,
    sourceSimTime: snapshot?.sourceSimTime ?? null,
    capturedAt: snapshot?.capturedAt ?? child.createdAt,
    provenance: snapshot ? 'snapshot' as const : 'legacy' as const,
    states: snapshot?.states ?? null,
    eventIds: snapshot?.events.map((e) => e.id) ?? null,
    sourceStateVersion: snapshot?.sourceStateVersion ?? null,
    worldModelVersion: snapshot?.worldModelVersion ?? null,
    scenario,
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
  const [worldTimelines, states, eventRows, revisions, factRows] = await db.batch([
    db.select().from(timelines).where(eq(timelines.worldId, worldId)),
    db.select().from(personStates).where(inArray(personStates.timelineId,
      db.select({ id: timelines.id }).from(timelines).where(and(eq(timelines.worldId, worldId), inArray(timelines.id, [leftId, rightId]))))),
    db.select().from(events).where(inArray(events.timelineId,
      db.select({ id: timelines.id }).from(timelines).where(eq(timelines.worldId, worldId)))),
    db.select().from(universeRevisions).where(inArray(universeRevisions.timelineId,
      db.select({ id: timelines.id }).from(timelines).where(and(eq(timelines.worldId, worldId), inArray(timelines.id, [leftId, rightId]))))),
    db.select().from(worldFacts).where(inArray(worldFacts.timelineId,
      db.select({ id: timelines.id }).from(timelines).where(and(eq(timelines.worldId, worldId), inArray(timelines.id, [leftId, rightId]))))),
  ])
  const left = worldTimelines.find((t) => t.id === leftId)
  const right = worldTimelines.find((t) => t.id === rightId)
  if (!left || !right) return null

  const worldStateAtSnapshot = (timeline: Timeline) => {
    const revision = revisions.find(item => item.timelineId === timeline.id)
    const inherited = readForkSnapshot(timeline)?.worldFacts ?? []
    const local = factRows.filter(fact => fact.timelineId === timeline.id)
    const current = new Map<string, (typeof local)[number] | (typeof inherited)[number]>()
    for (const fact of [...inherited, ...local]) current.set(`${fact.factType}:${fact.subjectId}`, fact)
    return {
      worldModelVersion: revision?.worldModelVersion ?? null,
      evidenceStatus: !revision || (timeline.parentTimelineId && readForkSnapshot(timeline)?.sourceStateVersion == null)
        ? 'legacy' as const : 'structured' as const,
      current: [...current.values()].map(fact => ({ ...fact, value: JSON.parse(fact.valueJson) as unknown })),
    }
  }
  // Clocks, resident projections, events, revisions, and local facts above share one
  // D1 batch snapshot; inherited facts come from each immutable Fork checkpoint.
  const leftWorldState = worldStateAtSnapshot(left)
  const rightWorldState = worldStateAtSnapshot(right)
  const factsByKey = (state: typeof leftWorldState) => new Map(state.current.map(f => [`${f.factType}:${f.subjectId}`, f]))
  const leftFacts = factsByKey(leftWorldState)
  const rightFacts = factsByKey(rightWorldState)
  const factDifferences = [...new Set([...leftFacts.keys(), ...rightFacts.keys()])].sort().flatMap(key => {
    const l = leftFacts.get(key)
    const r = rightFacts.get(key)
    if (JSON.stringify(l?.value ?? null) === JSON.stringify(r?.value ?? null)) return []
    return [{ key, left: l ? { value: l.value, factId: l.id, version: l.version, simTime: l.simTime } : null,
      right: r ? { value: r.value, factId: r.id, version: r.version, simTime: r.simTime } : null }]
  })

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
      facts: factDifferences,
      worldModelVersions: { left: leftWorldState.worldModelVersion, right: rightWorldState.worldModelVersion },
      events: {
        shared: leftEvents.events.filter((e) => rightEventIds.has(e.id)),
        leftOnly: leftEvents.events.filter((e) => !rightEventIds.has(e.id)),
        rightOnly: rightEvents.events.filter((e) => !leftEventIds.has(e.id)),
      },
    },
    limitations: [
      'State values are current observations at each timeline’s own simNow; event differences identify records, not causes.',
      ...(left.simNow !== right.simNow ? ['The timelines are at different simulated times; advance them to a shared time before interpreting the differences.'] : []),
      ...(!leftEvents.historyComplete || !rightEvents.historyComplete
        ? ['Legacy fork history lacks an immutable event snapshot; unavailable ancestor events are omitted.'] : []),
      ...(leftWorldState.evidenceStatus === 'legacy' || rightWorldState.evidenceStatus === 'legacy'
        ? ['At least one timeline predates structured facts; missing facts mean unknown, not unchanged.'] : []),
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
