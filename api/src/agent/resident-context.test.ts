import { describe, expect, it } from 'vitest'
import type { timelines } from '../db/schema'
import { residentTimeline } from './resident-context'

describe('resident timeline projection', () => {
  it('omits the constructor scenario and all non-prompt timeline fields', () => {
    const timeline = residentTimeline({
      id: 'fork', worldId: 'world', parentTimelineId: 'main',
      forkScenarioJson: '{"whatIf":"constructor-only-canary"}', simNow: '2026-10-04T08:00:00.000Z',
      createdAt: '2026-10-04T07:00:00.000Z', status: 'active', ancestorIdsJson: '["main"]',
      lastRealTickAt: null, forkSnapshotJson: '{"private":"snapshot-canary"}',
    } as typeof timelines.$inferSelect)
    expect(timeline).toEqual({ id: 'fork', worldId: 'world', parentTimelineId: 'main', simNow: '2026-10-04T08:00:00.000Z' })
    expect(JSON.stringify(timeline)).not.toContain('canary')
  })
})
