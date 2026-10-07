import { describe, expect, it } from 'vitest'
import type { PaneId, PresentationKind } from './presentation-types'
import {
  readPresentationRoute,
  updatePanePresentation,
  updatePaneTimeline,
  updateRightPaneTarget,
} from './presentation-route'

describe('presentation route decoding', () => {
  it('keeps the path world and defaults a single pane to 3D without inventing a timeline', () => {
    expect(readPresentationRoute('path-world', new URLSearchParams('worldId=ignored'))).toEqual({
      left: { worldId: 'path-world', presentation: 'voxel3d' }, right: null,
    })
  })

  it('uses a browser preference for each pane independently and accepts a missing preference', () => {
    const query = new URLSearchParams('timeline=main&right=fork')
    expect(readPresentationRoute('world-a', query, 'native2d')).toEqual({
      left: { worldId: 'world-a', timelineId: 'main', presentation: 'native2d' },
      right: { worldId: 'world-a', timelineId: 'fork', presentation: 'native2d' },
    })
    expect(readPresentationRoute('world-a', query, null).left.presentation).toBe('voxel3d')
  })

  it.each([
    ['native2d', 'native2d'], ['voxel3d', 'voxel3d'],
    ['native2d', 'voxel3d'], ['voxel3d', 'native2d'],
  ] satisfies [PresentationKind, PresentationKind][])('decodes %s/%s for same and different worlds', (left, right) => {
    for (const rightWorld of ['world-a', 'world-b']) {
      const query = new URLSearchParams({
        mode: 'possibility', timeline: 'main', rightWorld, right: 'fork',
        presentation: left, rightPresentation: right,
      })
      expect(readPresentationRoute('world-a', query, 'native2d')).toEqual({
        left: { worldId: 'world-a', timelineId: 'main', presentation: left },
        right: { worldId: rightWorld, timelineId: 'fork', presentation: right },
      })
    }
  })

  it('accepts legacy right links, including comparing the same timeline', () => {
    expect(readPresentationRoute('world-a', new URLSearchParams('timeline=main&right=main'))).toEqual({
      left: { worldId: 'world-a', timelineId: 'main', presentation: 'voxel3d' },
      right: { worldId: 'world-a', timelineId: 'main', presentation: 'voxel3d' },
    })
  })

  it('allows a right world without a selected timeline', () => {
    expect(readPresentationRoute('world-a', new URLSearchParams('rightWorld=world-b'))).toEqual({
      left: { worldId: 'world-a', presentation: 'voxel3d' },
      right: { worldId: 'world-b', presentation: 'voxel3d' },
    })
  })

  it.each(['', 'rightPresentation=native2d', 'right=&rightWorld=', 'right=+&rightWorld=%20%20'])
    ('does not open a right pane without a target: %s', input => {
      expect(readPresentationRoute('world-a', new URLSearchParams(input)).right).toBeNull()
    })

  it.each(['2d', '3d', 'NATIVE2D', ' native2d ', ''])
    ('falls back independently for invalid presentation values: %s', invalid => {
      const query = new URLSearchParams({ right: 'fork', presentation: invalid, rightPresentation: 'voxel3d' })
      const route = readPresentationRoute('world-a', query, 'native2d')
      expect(route.left.presentation).toBe('native2d')
      expect(route.right?.presentation).toBe('voxel3d')
      query.set('presentation', 'voxel3d')
      query.set('rightPresentation', invalid)
      const reversed = readPresentationRoute('world-a', query, 'native2d')
      expect(reversed.left.presentation).toBe('voxel3d')
      expect(reversed.right?.presentation).toBe('native2d')
      expect(readPresentationRoute('world-a', query).right?.presentation).toBe('voxel3d')
    })

  it('does not copy an explicit left presentation into a missing right presentation', () => {
    const route = readPresentationRoute('world-a', new URLSearchParams('presentation=native2d&right=fork'))
    expect(route.left.presentation).toBe('native2d')
    expect(route.right?.presentation).toBe('voxel3d')
  })

  it('treats blank timeline/world query values as absent', () => {
    const route = readPresentationRoute('world-a', new URLSearchParams('timeline=+&rightWorld=+&right=fork'))
    expect(route.left.timelineId).toBeUndefined()
    expect(route.right?.worldId).toBe('world-a')
  })

  it('preserves decoded opaque IDs and does not mutate query while reading', () => {
    const query = new URLSearchParams({
      timeline: '分支 &/?=🙂', rightWorld: 'world /?&', right: ' +special ', mode: 'possibility',
    })
    const original = query.toString()
    const route = readPresentationRoute('世界/🙂', query)
    expect(route.left.worldId).toBe('世界/🙂')
    expect(route.left.timelineId).toBe('分支 &/?=🙂')
    expect(route.right?.worldId).toBe('world /?&')
    expect(route.right?.timelineId).toBe(' +special ')
    expect(query.toString()).toBe(original)
  })
})

describe('presentation route updates', () => {
  const initial = () => new URLSearchParams(
    'mode=possibility&timeline=main&rightWorld=world-b&right=fork'
    + '&presentation=voxel3d&rightPresentation=native2d&unknown=one&unknown=two&empty=',
  )

  it.each(['single', 'left', 'right'] satisfies PaneId[])
    ('changes only %s presentation and preserves caller and repeated unknown parameters', paneId => {
      const query = initial()
      const original = query.toString()
      const next = updatePanePresentation(query, paneId, paneId === 'right' ? 'voxel3d' : 'native2d')
      const expected = initial()
      expected.set(paneId === 'right' ? 'rightPresentation' : 'presentation', paneId === 'right' ? 'voxel3d' : 'native2d')
      expect(next).not.toBe(query)
      expect([...next]).toEqual([...expected])
      expect(next.getAll('unknown')).toEqual(['one', 'two'])
      expect(query.toString()).toBe(original)
    })

  it.each(['single', 'left', 'right'] satisfies PaneId[])
    ('updates or clears only %s timeline while preserving mode and both presentations', paneId => {
      for (const timelineId of ['新分支/?&', null, '', '   ']) {
        const query = initial()
        const original = query.toString()
        const next = updatePaneTimeline(query, paneId, timelineId)
        const expected = initial()
        const key = paneId === 'right' ? 'right' : 'timeline'
        if (timelineId?.trim()) expected.set(key, timelineId)
        else expected.delete(key)
        expect([...next]).toEqual([...expected])
        expect(query.toString()).toBe(original)
      }
    })

  it('replaces a right target and round-trips reserved characters without changing the left pane', () => {
    const query = initial()
    const original = query.toString()
    const target = { worldId: '世界/?&=🙂', timelineId: 'fork +/?&', presentation: 'voxel3d' } as const
    const next = updateRightPaneTarget(query, target)
    const route = readPresentationRoute('world-a', new URLSearchParams(next.toString()))
    expect(route.right).toEqual(target)
    expect(route.left).toEqual(readPresentationRoute('world-a', query).left)
    expect(next.get('mode')).toBe('possibility')
    expect(next.getAll('unknown')).toEqual(['one', 'two'])
    expect(query.toString()).toBe(original)
  })

  it('removes an old right timeline when replacing it with a world default timeline', () => {
    const next = updateRightPaneTarget(initial(), { worldId: 'world-c', presentation: 'native2d' })
    expect(next.has('right')).toBe(false)
    expect(readPresentationRoute('world-a', next).right).toEqual({ worldId: 'world-c', presentation: 'native2d' })
  })

  it('closes the right pane by removing all right keys and preserves everything else', () => {
    const query = initial()
    const original = query.toString()
    const next = updateRightPaneTarget(query, null)
    const expected = initial()
    for (const key of ['rightWorld', 'right', 'rightPresentation']) expected.delete(key)
    expect([...next]).toEqual([...expected])
    expect(readPresentationRoute('world-a', next).right).toBeNull()
    expect(query.toString()).toBe(original)
  })

  it('changing an orphan right presentation does not invent a target', () => {
    const next = updatePanePresentation(new URLSearchParams(), 'right', 'native2d')
    expect(readPresentationRoute('world-a', next).right).toBeNull()
  })
})
