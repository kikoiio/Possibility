import type { timelines } from '../db/schema'

type Timeline = typeof timelines.$inferSelect

/** Minimal timeline metadata allowed across the resident prompt boundary. */
export type ResidentTimeline = Pick<Timeline, 'id' | 'worldId' | 'parentTimelineId' | 'simNow'>

export function residentTimeline(timeline: Timeline): ResidentTimeline {
  return {
    id: timeline.id,
    worldId: timeline.worldId,
    parentTimelineId: timeline.parentTimelineId,
    simNow: timeline.simNow,
  }
}
