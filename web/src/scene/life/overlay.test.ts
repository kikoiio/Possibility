import { describe, expect, it } from 'vitest'
import { buildSceneOverlay } from './overlay'
import type { WorldSnapshot } from '../../api/types'

describe('scene life overlay', () => {
  it('derives time of day and only maps residents from current location board', () => {
    const snapshot = { simNow: '2026-01-01T19:00:00.000Z', currentTimelineId: 'main', currentFacts: [], locationBoard: [{ location: 'Cafe', persons: [{ id: 'p', name: 'Ada', activity: 'reading' }] }] } as unknown as WorldSnapshot
    const overlay = buildSceneOverlay(snapshot); expect(overlay.timeOfDay).toBe('dusk'); expect(overlay.persons[0]).toMatchObject({ personId: 'p', locationName: 'Cafe', activity: 'reading' })
  })
})
