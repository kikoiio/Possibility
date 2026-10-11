import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createPresentationStateStore } from '../../../lib/presentation-state'
import type { PanePresentationData, PresentationLifecycleAdapters } from './presentation-types'
import type { PresentationLifecycleAdapters as LifecycleAdapters } from './PresentationLifecycle'
import PresentationHost from './PresentationHost'

const adapters: LifecycleAdapters = {
  native2d: { kind: 'native2d', supports: () => true, mount: async () => { throw new Error('not mounted in SSR') } },
  voxel3d: { kind: 'voxel3d', supports: () => true, mount: async () => { throw new Error('not mounted in SSR') } },
} satisfies PresentationLifecycleAdapters

const store = createPresentationStateStore(null)

function data(presentation: 'native2d' | 'voxel3d'): PanePresentationData {
  return {
    context: {
      paneId: 'single', worldId: 'world-a', timelineId: 'main', spaceId: 'exterior',
      presentation, identity: 'owner', capabilities: {},
      sceneId: 'scene-1', sceneVersion: 1, stateVersion: 1,
      simNow: '2026-10-07T00:00:00Z', timeZone: 'UTC', availableSpaces: [],
    },
    snapshot: {} as never,
    sceneDocument: {} as never,
    selectedSpaceDocument: {} as never,
    worldReadModel: {} as never,
  } as PanePresentationData
}

describe('PresentationHost SSR', () => {
  it('renders a host container tagged with the pane and presentation', () => {
    const html = renderToStaticMarkup(createElement(PresentationHost, {
      data: data('voxel3d'),
      adapters,
      store,
    }))
    expect(html).toContain('data-testid="presentation-host-single"')
    expect(html).toContain('data-presentation="voxel3d"')
  })
})
