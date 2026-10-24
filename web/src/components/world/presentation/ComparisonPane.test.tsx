import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SerializedVoxelDocument, VoxelDocument } from '@wispiva/voxel-contract'
import type { WorldSnapshot } from '../../../api/types'
import type { WorldReadModel } from '../../../native2d/types'
import type { PaneTarget, PaneUnsupported, PaneWorldData, SpaceDescriptor, WorldPresentationContext } from './presentation-types'
import ComparisonPane, { paneLoadStateFrom } from './ComparisonPane'

function context(overrides: Partial<WorldPresentationContext> = {}): WorldPresentationContext {
  return {
    paneId: 'single', worldId: 'world-a', timelineId: 'main', spaceId: 'exterior',
    presentation: 'voxel3d', identity: 'owner', capabilities: { observe: true },
    sceneId: 'scene-1', sceneVersion: 1, stateVersion: 1,
    simNow: '2026-10-07T00:00:00Z', timeZone: 'UTC', availableSpaces: [],
    ...overrides,
  }
}

function data(contextOverrides: Partial<WorldPresentationContext> = {}): PaneWorldData {
  return {
    context: context(contextOverrides),
    snapshot: { stateVersion: 1 } as unknown as WorldSnapshot,
    sceneDocument: { format: 'voxel-document' } as unknown as SerializedVoxelDocument,
    selectedSpaceDocument: { id: 'scene-1' } as unknown as VoxelDocument,
    worldReadModel: {} as unknown as WorldReadModel,
  }
}

const target: PaneTarget = { worldId: 'world-a', timelineId: 'main', spaceId: 'exterior', presentation: 'voxel3d' }

describe('pane load state mapping', () => {
  it('passes unsupported results through with code and alternatives', () => {
    const unsupported: PaneUnsupported = {
      kind: 'unsupported', code: 'space-missing', reason: '所选空间不存在。',
      alternatives: [{ id: 'exterior', label: '外景', kind: 'exterior', supportedPresentations: ['voxel3d'] }],
    }
    expect(paneLoadStateFrom(unsupported, target, 'left')).toEqual({
      kind: 'unsupported', code: 'space-missing', reason: '所选空间不存在。',
      alternatives: [{ id: 'exterior', label: '外景', kind: 'exterior', supportedPresentations: ['voxel3d'] }],
    })
  })

  it('accepts a result whose concrete fields match the target and stamps the pane id', () => {
    const state = paneLoadStateFrom(data(), target, 'left')
    expect(state.kind).toBe('ready')
    if (state.kind === 'ready') {
      expect(state.data.context.paneId).toBe('left')
      expect(state.data.context.worldId).toBe('world-a')
      expect(state.data.context.spaceId).toBe('exterior')
    }
  })

  it.each([
    ['world', data({ worldId: 'world-b' })],
    ['timeline', data({ timelineId: 'fork' })],
    ['space', data({ spaceId: 'main-house-interior' })],
    ['presentation', data({ presentation: 'native2d' })],
  ])('rejects a mismatched %s echo instead of rendering mixed data', (_field, mismatched) => {
    expect(paneLoadStateFrom(mismatched, target, 'single')).toEqual({
      kind: 'error', message: '读取结果与当前视口目标不匹配。', retryable: false,
    })
  })

  it('keeps the read data detached from later caller mutations', () => {
    const loaded = data()
    const state = paneLoadStateFrom(loaded, target, 'right')
    ;(loaded.context.capabilities as Record<string, boolean>).observe = false
    ;(loaded.context.availableSpaces as SpaceDescriptor[]).push({ id: 'x', label: 'x', kind: 'unknown', supportedPresentations: [] })
    if (state.kind === 'ready') {
      expect(state.data.context.capabilities.observe).toBe(true)
      expect(state.data.context.availableSpaces).toHaveLength(0)
    }
  })
})

describe('ComparisonPane SSR', () => {
  it('renders the loading state and never mounts a renderer during server render', () => {
    const html = renderToStaticMarkup(createElement(ComparisonPane, {
      paneId: 'single',
      target,
      loadSession: async () => data(),
      children: state => createElement('div', { 'data-state': state.kind }),
    }))
    expect(html).toContain('data-state="loading"')
  })
})
