import type { commitments, events, memories, personStates, schedules, timelines } from '../db/schema'

export type Timeline = typeof timelines.$inferSelect
type Memory = typeof memories.$inferSelect
export type Event = typeof events.$inferSelect

export interface AncestorCutoff {
  timelineId: string
  realTime: string
  simTime: string | null
}

/** Immutable evidence captured from the source, before the child starts running. */
export interface ForkSnapshot {
  version: 1
  sourceTimelineId: string
  sourceSimTime: string
  capturedAt: string
  ancestorCutoffs: AncestorCutoff[]
  states: (typeof personStates.$inferSelect)[]
  schedules: (typeof schedules.$inferSelect)[]
  memories: Memory[]
  events: Event[]
  commitments: (typeof commitments.$inferSelect)[]
  historyComplete: boolean
}

export function readForkSnapshot(timeline: Timeline): ForkSnapshot | null {
  const raw = timeline.forkSnapshotJson
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as ForkSnapshot
    return value.version === 1 && value.sourceTimelineId === timeline.parentTimelineId
      && typeof value.sourceSimTime === 'string' && typeof value.capturedAt === 'string'
      && Array.isArray(value.ancestorCutoffs) && Array.isArray(value.states)
      && Array.isArray(value.schedules) && Array.isArray(value.memories) && Array.isArray(value.events)
      ? value : null
  } catch {
    return null
  }
}

function legacySimCutoff(child: Timeline): string | null {
  try {
    const start = JSON.parse(child.forkScenarioJson || 'null')?.startTime
    return typeof start === 'string' && Number.isFinite(Date.parse(start))
      ? new Date(start).toISOString() : null
  } catch {
    return null
  }
}

/** Walk actual parent links in this world; never trust a cached ancestor ID list. */
export function ancestorCutoffs(timeline: Timeline, worldTimelines: Timeline[]): AncestorCutoff[] {
  const byId = new Map(worldTimelines.filter((t) => t.worldId === timeline.worldId).map((t) => [t.id, t]))
  const cutoffs: AncestorCutoff[] = []
  const seen = new Set([timeline.id])
  let child = timeline
  let realTime = timeline.createdAt
  while (child.parentTimelineId && !seen.has(child.parentTimelineId)) {
    const parent = byId.get(child.parentTimelineId)
    if (!parent) break
    seen.add(parent.id)
    const snapshot = readForkSnapshot(child)
    realTime = [realTime, snapshot?.capturedAt ?? child.createdAt].sort()[0]
    cutoffs.push({ timelineId: parent.id, realTime, simTime: snapshot?.sourceSimTime ?? legacySimCutoff(child) })
    child = parent
  }
  return cutoffs
}

export function selectVisibleMemories(rows: Memory[], personId: string, timeline: Timeline, worldTimelines: Timeline[]): Memory[] {
  const own = rows.filter((m) => m.personId === personId && (m.timelineId === timeline.id
    || (!timeline.parentTimelineId && m.timelineId === null)))
  const snapshot = readForkSnapshot(timeline)
  if (snapshot) {
    return [...snapshot.memories.filter((m) => m.personId === personId), ...own]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }
  const cutoffs = ancestorCutoffs(timeline, worldTimelines)
  const main = worldTimelines.find((t) => t.worldId === timeline.worldId && !t.parentTimelineId)
  const inherited = rows.filter((m) => {
    if (m.personId !== personId) return false
    const cutoff = cutoffs.find((a) => a.timelineId === (m.timelineId ?? main?.id))
    return cutoff !== undefined && m.createdAt <= cutoff.realTime
  })
  return [...inherited, ...own].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

export function selectVisibleEvents(rows: Event[], timeline: Timeline, worldTimelines: Timeline[]) {
  const snapshot = readForkSnapshot(timeline)
  const cutoffs = ancestorCutoffs(timeline, worldTimelines)
  const inherited = snapshot?.events ?? rows.filter((event) => {
    const cutoff = cutoffs.find((a) => a.timelineId === event.timelineId)
    // Old world forks did not persist their source sim time. Do not invent historical evidence.
    return cutoff?.simTime != null && event.simTime <= cutoff.simTime
  })
  const own = rows.filter((e) => e.timelineId === timeline.id && e.simTime <= timeline.simNow)
  return {
    events: [...inherited, ...own].sort((a, b) => a.simTime.localeCompare(b.simTime) || a.id.localeCompare(b.id)),
    historyComplete: snapshot?.historyComplete ?? (!timeline.parentTimelineId
      || (cutoffs.length > 0 && cutoffs.every((a) => a.simTime !== null))),
  }
}
