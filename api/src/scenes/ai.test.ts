import { describe, expect, it } from 'vitest'
import { contemporaryTheme, validateScene, type SceneDocument } from '@possibility/scene-contract'
import { resolveObjectOverlaps } from './ai'
import { ensureSceneObjectIds, ensureScenePathIds } from './normalize'

describe('scene draft placement repair', () => {
  it('assigns stable unique IDs when a provider omits or repeats object IDs', () => {
    const scene: SceneDocument = {
      schemaVersion: 1, themeId: contemporaryTheme.id, size: { columns: 12, rows: 10 }, version: 0,
      terrain: [], paths: [], lockedObjectIds: [], lockedAreas: [],
      objects: [
        { id: '', assetId: 'home-small', position: { x: 0, y: 0 }, binding: null, label: null, purpose: null },
        { id: 'same', assetId: 'cafe-corner', position: { x: 4, y: 0 }, binding: null, label: null, purpose: null },
        { id: 'same', assetId: 'person-ada', position: { x: 8, y: 0 }, binding: null, label: null, purpose: null },
      ],
    }
    expect(ensureSceneObjectIds(scene)).toHaveLength(2)
    expect(scene.objects.map(object => object.id)).toEqual(['scene-object-1', 'same', 'scene-object-3'])
  })

  it('assigns stable IDs to paths before canonical hashing', () => {
    const scene: SceneDocument = {
      schemaVersion: 1, themeId: contemporaryTheme.id, size: { columns: 12, rows: 10 }, version: 0,
      terrain: [], objects: [], lockedObjectIds: [], lockedAreas: [],
      paths: [
        { id: '', category: 'road', assetId: 'road-straight', cells: [{ x: 0, y: 0 }] },
        { id: '', category: 'water', assetId: 'water-inner', cells: [{ x: 1, y: 0 }] },
      ],
    }
    expect(ensureScenePathIds(scene)).toHaveLength(2)
    expect(scene.paths.map(path => path.id)).toEqual(['scene-path-1', 'scene-path-2'])
  })

  it('moves colliding objects to nearby free cells while preserving location anchors', () => {
    const scene: SceneDocument = {
      schemaVersion: 1,
      themeId: contemporaryTheme.id,
      size: { columns: 12, rows: 10 },
      version: 0,
      terrain: [],
      paths: [],
      objects: [
        { id: 'loc-home', assetId: 'home-small', position: { x: 0, y: 0 }, binding: { kind: 'location', locationName: '住宅' }, label: null, purpose: null },
        { id: 'loc-cafe', assetId: 'cafe-corner', position: { x: 0, y: 0 }, binding: { kind: 'location', locationName: '咖啡馆' }, label: null, purpose: null },
        { id: 'resident', assetId: 'person-ada', position: { x: 0, y: 0 }, binding: { kind: 'person', personId: 'person-1' }, label: null, purpose: null },
      ],
      lockedObjectIds: [],
      lockedAreas: [],
    }
    const warnings = resolveObjectOverlaps(scene)
    expect(warnings).toHaveLength(2)
    expect(scene.objects[0].position).toEqual({ x: 0, y: 0 })
    expect(validateScene(scene, contemporaryTheme).ok).toBe(true)
  })
})
