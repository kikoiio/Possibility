import { describe, expect, it } from 'vitest'
import { mistManorTheme, validateSceneDocument, validateThemeManifest } from '@possibility/scene-contract'
import { createMistManorScene } from './mist-manor-scene'

describe('mist manor formal scene', () => {
  it('contains connected exterior and interior spaces with all seven semantic locations', () => {
    const residents = Array.from({ length: 6 }, (_, index) => ({ id: `person-${index}`, name: `resident-${index}` }))
    const scene = createMistManorScene(residents)
    expect(validateThemeManifest(mistManorTheme)).toEqual([])
    const result = validateSceneDocument(scene, mistManorTheme)
    expect(result.issues).toEqual([])
    expect(scene.spaces.map(space => space.id)).toEqual(['exterior', 'main-house-interior'])
    expect(scene.portals).toHaveLength(1)
    expect(new Set(scene.spaces.flatMap(space => space.regions.map(region => region.locationName)))).toEqual(new Set(['大厅', '书房', '餐厅', '图书室', '温室花房', '门房小屋', '后山散步道']))
  })
})
