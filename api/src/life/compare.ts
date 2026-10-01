import { Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { ancestorCutoffs, readForkSnapshot, selectVisibleEvents, type Timeline } from '../agent/visibility'
import { hydrateTimelines } from './snapshot-store'
import { createDb, type Db } from '../db/client'
import { events, personStates, timelines, universeEvidence, universeRevisions, worldFacts, worlds } from '../db/schema'
import type { Env } from '../index'
import { publicUniverseEvidence } from '../world-state/evidence-status'

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

export async function compareTimelines(db: Db, worldId: string, leftId: string, rightId: string, at?: string) {
  // One read transaction keeps state, clocks, and event evidence on the same database snapshot.
  const [worldTimelinesRaw, states, eventRows, revisions, factRows, evidenceRows] = await db.batch([
    db.select().from(timelines).where(eq(timelines.worldId, worldId)),
    db.select().from(personStates).where(inArray(personStates.timelineId,
      db.select({ id: timelines.id }).from(timelines).where(and(eq(timelines.worldId, worldId), inArray(timelines.id, [leftId, rightId]))))),
    db.select().from(events).where(inArray(events.timelineId,
      db.select({ id: timelines.id }).from(timelines).where(eq(timelines.worldId, worldId)))),
    db.select().from(universeRevisions).where(inArray(universeRevisions.timelineId,
      db.select({ id: timelines.id }).from(timelines).where(and(eq(timelines.worldId, worldId), inArray(timelines.id, [leftId, rightId]))))),
    db.select().from(worldFacts).where(inArray(worldFacts.timelineId,
      db.select({ id: timelines.id }).from(timelines).where(and(eq(timelines.worldId, worldId), inArray(timelines.id, [leftId, rightId]))))),
    db.select().from(universeEvidence).where(inArray(universeEvidence.timelineId, [leftId, rightId])),
  ])
  const worldTimelines = await hydrateTimelines(db, worldTimelinesRaw)
  const left = worldTimelines.find((t) => t.id === leftId)
  const right = worldTimelines.find((t) => t.id === rightId)
  if (!left || !right) return null

  const worldStateAtSnapshot = (timeline: Timeline) => {
    const revision = revisions.find(item => item.timelineId === timeline.id)
    const inherited = readForkSnapshot(timeline)?.worldFacts ?? []
    const local = factRows.filter(fact => fact.timelineId === timeline.id)
    const current = new Map<string, (typeof local)[number] | (typeof inherited)[number]>()
    if (at) {
      // S1 对齐截断:每 key 取 simTime ≤ T 的最大 version(继承在先,本地同版优先)
      for (const fact of [...inherited, ...local]) {
        if (fact.simTime > at) continue
        const key = `${fact.factType}:${fact.subjectId}`
        const prev = current.get(key)
        if (!prev || fact.version >= prev.version) current.set(key, fact)
      }
    } else {
      for (const fact of [...inherited, ...local]) current.set(`${fact.factType}:${fact.subjectId}`, fact)
    }
    return {
      worldModelVersion: revision?.worldModelVersion ?? null,
      evidenceStatus: !revision || (timeline.parentTimelineId && readForkSnapshot(timeline)?.sourceStateVersion == null)
        ? 'legacy' as const : 'structured' as const,
      evidence: publicUniverseEvidence(evidenceRows.find(row => row.timelineId === timeline.id)),
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
  // S1 对齐截断:simTime 模式下三组事件均截到 ≤ T(visibility 水位不动)
  const leftVisible = at ? leftEvents.events.filter((e) => e.simTime <= at) : leftEvents.events
  const rightVisible = at ? rightEvents.events.filter((e) => e.simTime <= at) : rightEvents.events
  const leftEventIds = new Set(leftVisible.map((e) => e.id))
  const rightEventIds = new Set(rightVisible.map((e) => e.id))
  const sharedEvents = leftVisible.filter((e) => rightEventIds.has(e.id))
  const leftOnlyEvents = leftVisible.filter((e) => !rightEventIds.has(e.id))
  const rightOnlyEvents = rightVisible.filter((e) => !leftEventIds.has(e.id))
  // 首个分歧:两组独有事件中 simTime 最早者;同时刻取左线(确定性)
  const firstDivergence = [
    ...leftOnlyEvents.map((e) => ({ simTime: e.simTime, eventId: e.id, side: 'left' as const })),
    ...rightOnlyEvents.map((e) => ({ simTime: e.simTime, eventId: e.id, side: 'right' as const })),
  ].sort((a, b) => a.simTime.localeCompare(b.simTime) || a.side.localeCompare(b.side))[0] ?? null
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
    evidence: t.id === left.id ? leftWorldState.evidence : rightWorldState.evidence,
  })
  return {
    worldId,
    interpretation: 'observed_differences_not_causal_claims' as const,
    timeAlignment: left.simNow === right.simNow ? 'same_sim_time' as const : 'different_sim_times' as const,
    // S1:对齐时刻回显(null = 未传 simTime)与首个分歧事件
    alignedAt: at ?? null,
    firstDivergence,
    left: timelineEvidence(left, leftEvents.historyComplete),
    right: timelineEvidence(right, rightEvents.historyComplete),
    sharedForkOrigin: sharedForkOrigin(left, right, worldTimelines),
    differences: {
      states: stateDifferences,
      facts: factDifferences,
      worldModelVersions: { left: leftWorldState.worldModelVersion, right: rightWorldState.worldModelVersion },
      events: {
        shared: sharedEvents,
        leftOnly: leftOnlyEvents,
        rightOnly: rightOnlyEvents,
      },
    },
    limitations: [
      'State values are current observations at each timeline’s own simNow; event differences identify records, not causes.',
      ...(at ? ['Person states have no history table; state differences above are current values, not values reconstructed at the aligned simTime.'] : []),
      ...(left.simNow !== right.simNow ? ['The timelines are at different simulated times; advance them to a shared time before interpreting the differences.'] : []),
      ...(!leftEvents.historyComplete || !rightEvents.historyComplete
        ? ['Legacy fork history lacks an immutable event snapshot; unavailable ancestor events are omitted.'] : []),
      ...(leftWorldState.evidence.level !== 'complete' || rightWorldState.evidence.level !== 'complete'
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
  // S1:可选对齐时刻(ISO),归一化后按 simTime ≤ T 截断事件与事实
  const simTimeRaw = c.req.query('simTime')?.trim()
  let at: string | undefined
  if (simTimeRaw) {
    if (!Number.isFinite(Date.parse(simTimeRaw))) return c.json({ error: 'simTime 须为合法 ISO 时间' }, 400)
    at = new Date(simTimeRaw).toISOString()
  }
  const comparison = await compareTimelines(db, world.id, left, right, at)
  if (!comparison) return c.json({ error: '时间线不存在' }, 404)
  return c.json(comparison)
})
