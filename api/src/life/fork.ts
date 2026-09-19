import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import type { Db } from '../db/client'
import { commitments, events, memories, personStates, schedules, timelines, worldPersons } from '../db/schema'
import { ancestorCutoffs, selectVisibleEvents, selectVisibleMemories, type ForkSnapshot } from '../agent/visibility'
import type { ForkScenario } from '../agent/types'

/** Read a consistent source snapshot, then atomically persist the child and all copied rows. */
export async function forkTimeline(db: Db, worldId: string, sourceId: string, scenario: ForkScenario | null = null) {
  const worldTimelineIds = db.select({ id: timelines.id }).from(timelines).where(eq(timelines.worldId, worldId))
  const [worldTimelines, states, scheduleRows, memoryRows, eventRows, commitmentRows] = await db.batch([
    db.select().from(timelines).where(eq(timelines.worldId, worldId)),
    db.select().from(personStates).where(eq(personStates.timelineId, sourceId)),
    db.select().from(schedules).where(eq(schedules.timelineId, sourceId)),
    db.select().from(memories).where(and(
      inArray(memories.personId, db.select({ id: worldPersons.personId }).from(worldPersons).where(eq(worldPersons.worldId, worldId))),
      or(isNull(memories.timelineId), inArray(memories.timelineId, worldTimelineIds)),
    )),
    db.select().from(events).where(inArray(events.timelineId, worldTimelineIds)),
    db.select().from(commitments).where(and(eq(commitments.worldId, worldId), eq(commitments.timelineId, sourceId))),
  ])
  const source = worldTimelines.find((t) => t.id === sourceId)
  if (!source || source.status !== 'active') throw new Error('只能分叉活跃时间线')
  if (worldTimelines.filter((t) => t.status === 'active').length >= 3) throw new Error('活跃时间线已达上限（3 条）')
  // A historical scenario is not a historical state snapshot; never relabel today's state as the past.
  if (scenario && Date.parse(scenario.startTime) !== Date.parse(source.simNow)) {
    throw new Error('历史状态快照不可用，请以当前时间线时间创建分叉')
  }
  const now = new Date().toISOString()
  const forkId = crypto.randomUUID()
  const inherited = selectVisibleEvents(eventRows, source, worldTimelines)
  const cutoffs = ancestorCutoffs(source, worldTimelines)
  const copiedSchedules = scheduleRows.filter((s) => s.worldDate >= source.simNow.slice(0, 10))
  const snapshot: ForkSnapshot = {
    version: 1, sourceTimelineId: source.id, sourceSimTime: source.simNow, capturedAt: now,
    ancestorCutoffs: [{ timelineId: source.id, realTime: now, simTime: source.simNow }, ...cutoffs],
    states, schedules: copiedSchedules, commitments: commitmentRows,
    memories: [...new Set([...states.map((s) => s.personId), ...memoryRows.map((m) => m.personId)])]
      .flatMap((personId) => selectVisibleMemories(memoryRows, personId, source, worldTimelines)),
    events: inherited.events, historyComplete: inherited.historyComplete,
  }
  const insertTimeline = db.insert(timelines).values({
    id: forkId, worldId, parentTimelineId: source.id,
    forkScenarioJson: scenario ? JSON.stringify(scenario) : null,
    forkSnapshotJson: JSON.stringify(snapshot), simNow: source.simNow, createdAt: now,
    status: 'active', ancestorIdsJson: JSON.stringify([...cutoffs.map((a) => a.timelineId).reverse(), source.id]),
    lastRealTickAt: now,
  })
  await db.batch([
    insertTimeline,
    ...states.map((s) => db.insert(personStates).values({
      ...s, timelineId: forkId, currentDialogueId: null, updatedRealAt: now,
    })),
    ...copiedSchedules.map((s) => db.insert(schedules).values({ ...s, timelineId: forkId })),
    ...commitmentRows.filter((c) => c.status === 'proposed' || c.status === 'accepted')
      .map((c) => db.insert(commitments).values({ ...c, id: crypto.randomUUID(), timelineId: forkId })),
  ])
  return { id: forkId, simNow: source.simNow, snapshot }
}
