import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createPresentationStateStore } from '../../../lib/presentation-state'
import type { SerializedVoxelDocument, VoxelDocument } from '@possibility/voxel-contract'
import type { WorldSnapshot } from '../../../api/types'
import type { WorldReadModel } from '../../../native2d/types'
import type { PanePresentationData, PaneTarget } from './presentation-types'
import type { PresentationLifecycleAdapters } from './PresentationLifecycle'
import ComparisonHost from './ComparisonHost'

const neverMount = async () => { throw new Error('renderer should not mount during server render') }
const adapters: PresentationLifecycleAdapters = {
  native2d: { kind: 'native2d', supports: () => true, mount: neverMount },
  voxel3d: { kind: 'voxel3d', supports: () => true, mount: neverMount },
}
const store = createPresentationStateStore(null)

function paneDataFor(target: PaneTarget, paneId: 'left' | 'right'): PanePresentationData {
  const presentation = target.presentation
  return {
    context: {
      paneId,
      worldId: target.worldId,
      timelineId: target.timelineId ?? 'main',
      spaceId: target.spaceId ?? 'exterior',
      presentation,
      identity: 'readonly',
      capabilities: { observe: true },
      sceneId: 'scene-1',
      sceneVersion: 1,
      stateVersion: 1,
      simNow: '2026-10-07T00:00:00Z',
      timeZone: 'UTC',
      availableSpaces: [
        { id: 'exterior', label: '外景', kind: 'exterior', supportedPresentations: ['voxel3d', 'native2d'] },
        { id: 'main-house-interior', label: '主楼内厅', kind: 'interior', supportedPresentations: ['voxel3d', 'native2d'] },
      ],
    },
    snapshot: { stateVersion: 1 } as unknown as WorldSnapshot,
    sceneDocument: { format: 'voxel-document' } as unknown as SerializedVoxelDocument,
    selectedSpaceDocument: { id: 'scene-1' } as unknown as VoxelDocument,
    worldReadModel: {
      scope: { source: 'public', worldId: target.worldId, timelineId: target.timelineId ?? 'main', sceneId: 'scene-1', sceneVersion: 1 },
      worldName: '世界', simNow: '2026-10-07T00:00:00Z', timeZone: 'UTC', stateVersion: 1, locations: [], residents: [],
    } as unknown as WorldReadModel,
  } as PanePresentationData
}

const loadSession = async (target: PaneTarget) => paneDataFor(target, 'left')

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

  it('does not enable the camera link when pane spaces differ before reads resolve', () => {
    const html = renderToStaticMarkup(createElement(ComparisonHost, {
      left: { worldId: 'world-a', spaceId: 'exterior', presentation: 'voxel3d' },
      right: { worldId: 'world-a', spaceId: 'main-house-interior', presentation: 'voxel3d' },
      loadSession,
      adapters,
      store,
      worlds: [{ id: 'world-a', name: 'A' }],
      onTargetChange: () => {},
    }))
    expect(html).toContain('data-camera-link-compatible="false"')
    expect(html).toContain('disabled')
  })
})
