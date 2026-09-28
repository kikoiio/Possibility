import { describe, expect, it } from 'vitest'
import { normalizeSceneDocument } from '../src/normalize'
import { validateSceneDocument } from '../src/validation'
import { canonicalScene } from '../src/hashing'
import { testTheme } from '../src/themes/test-theme'
import type { SceneDocument, SceneDocumentV2 } from '../src/types'

const v1: SceneDocument = {
  schemaVersion: 1, themeId: 'test-minimal', size: { columns: 3, rows: 3 }, version: 4,
  terrain: [{ x: 0, y: 0, assetId: 'test-terrain' }], paths: [],
  objects: [{ id: 'house', assetId: 'test-building', position: { x: 1, y: 1 }, binding: null, label: null, purpose: null }],
  lockedObjectIds: ['house'], lockedAreas: [{ x: 0, y: 0, width: 1, height: 1 }],
}

describe('Scene Document v2 compatibility', () => {
  it('normalizes v1 to one exterior space without changing input', () => {
    const before = structuredClone(v1)
    const first = normalizeSceneDocument(v1)
    const second = normalizeSceneDocument(v1)
    expect(first).toEqual(second)
    expect(first.spaces[0]).toMatchObject({ id: 'exterior', kind: 'exterior', objects: v1.objects, surface: v1.terrain })
    expect(first.lockedAreas[0]).toMatchObject({ spaceId: 'exterior' })
    expect(v1).toEqual(before)
  })

  it('validates connected multi-space scenes and reports unknown portal targets', () => {
    const scene: SceneDocumentV2 = {
      schemaVersion: 2, themeId: 'test-minimal', version: 1, defaultSpaceId: 'yard', portals: [], lockedObjectIds: [], lockedAreas: [],
      spaces: [{ id: 'yard', name: '庭院', kind: 'exterior', size: { columns: 3, rows: 3 }, surface: [], paths: [], structures: [], objects: [], regions: [], navigation: { walkableCells: [{ x: 0, y: 0 }, { x: 1, y: 0 }], blockedCells: [], entrances: [{ x: 0, y: 0 }] } }],
    }
    expect(validateSceneDocument(scene, testTheme).ok).toBe(true)
    scene.portals.push({ id: 'bad', from: { spaceId: 'yard', position: { x: 1, y: 0 }, facing: 'north-east' }, to: { spaceId: 'missing', position: { x: 0, y: 0 }, facing: 'south-west' }, transition: 'fade' })
    expect(validateSceneDocument(scene, testTheme).issues.some(issue => issue.code === 'unknown_portal_space')).toBe(true)
  })

  it('hashes v2 documents independently of array order', () => {
    const scene = normalizeSceneDocument(v1)
    const reordered = structuredClone(scene)
    reordered.spaces[0]!.surface.reverse()
    reordered.spaces[0]!.objects.reverse()
    expect(canonicalScene(reordered)).toBe(canonicalScene(scene))
    reordered.spaces.push({ ...structuredClone(scene.spaces[0]!), id: 'interior', kind: 'interior' })
    expect(canonicalScene(reordered)).not.toBe(canonicalScene(scene))
  })
})
