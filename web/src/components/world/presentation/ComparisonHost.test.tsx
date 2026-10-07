import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createPresentationStateStore } from '../../../lib/presentation-state'
import type { PresentationLifecycleAdapters } from './PresentationLifecycle'
import ComparisonHost from './ComparisonHost'

const neverMount = async () => { throw new Error('renderer should not mount during server render') }
const adapters: PresentationLifecycleAdapters = {
  native2d: { kind: 'native2d', mount: neverMount },
  voxel3d: { kind: 'voxel3d', mount: neverMount },
}
const store = createPresentationStateStore({ storage: null })
const loadSession = async (target: { worldId: string; timelineId?: string; presentation: 'native2d' | 'voxel3d' }) => ({
  paneId: 'left' as const,
  worldId: target.worldId,
  timelineId: target.timelineId ?? 'main',
  presentation: target.presentation,
  identity: 'readonly' as const,
  capabilities: { observe: true },
  stateVersion: 1,
  simNow: '2026-10-07T00:00:00Z',
})

describe('ComparisonHost', () => {
  it('renders independent world, timeline, and presentation controls for each pane', () => {
    const html = renderToStaticMarkup(createElement(ComparisonHost, {
      left: { worldId: 'world-a', timelineId: 'timeline-a', presentation: 'voxel3d' },
      right: { worldId: 'world-b', timelineId: 'timeline-b', presentation: 'native2d' },
      loadSession,
      adapters,
      store,
      worlds: [
        { id: 'world-a', name: 'A', timelineIds: ['timeline-a'] },
        { id: 'world-b', name: 'B', timelineIds: ['timeline-b'] },
      ],
      onTargetChange: () => {},
    }))
    expect(html).toContain('comparison-pane-left')
    expect(html).toContain('comparison-pane-right')
    expect(html).toContain('aria-label="left世界"')
    expect(html).toContain('aria-label="right时间线"')
    expect(html).toContain('联动相机')
  })
})
