import { describe, expect, it } from 'vitest'
import { validateScene } from '../src/validation'
import { testTheme } from '../src/themes/test-theme'
import type { SceneDocument } from '../src/types'

const scene = (): SceneDocument => ({ schemaVersion: 1, themeId: testTheme.id, size: { columns: 8, rows: 8 }, version: 0, terrain: [{ x: 0, y: 0, assetId: 'test-terrain' }], paths: [], objects: [], lockedObjectIds: [], lockedAreas: [] })
describe('scene validation', () => {
  it('accepts a valid document', () => { expect(validateScene(scene(), testTheme).ok).toBe(true) })
  it('reports boundary, asset, collision, binding, lock, and size failures with paths', () => {
    const doc = scene(); doc.terrain.push({ x: 8, y: 0, assetId: 'unknown' }); doc.objects = [
      { id: 'a', assetId: 'test-building', position: { x: 1, y: 1 }, binding: { kind: 'person', personId: 'p' }, label: null, purpose: null },
      { id: 'b', assetId: 'test-decoration', position: { x: 1, y: 1 }, binding: null, label: null, purpose: null },
    ]; doc.lockedObjectIds = ['absent']; doc.lockedAreas = [{ x: 7, y: 7, width: 2, height: 2 }]
    const result = validateScene(doc, testTheme, 1)
    expect(result.ok).toBe(false)
    for (const code of ['invalid_terrain_asset','out_of_bounds','object_limit','collision','invalid_binding','unknown_lock','invalid_locked_area']) expect(result.issues.some(i => i.code === code && i.path)).toBe(true)
  })
  it('reports malformed path cells instead of throwing', () => {
    const doc = scene() as unknown as { paths: Array<{ assetId: string; category: 'road'; cells?: unknown }> }
    doc.paths.push({ assetId: 'test-road', category: 'road' })
    const result = validateScene(doc as unknown as SceneDocument, testTheme)
    expect(result.ok).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'invalid_path_cells', path: 'paths[0].cells' }))
  })
  it('rejects missing object IDs before hashing or persistence', () => {
    const doc = scene()
    doc.objects = [{ id: '', assetId: 'test-building', position: { x: 1, y: 1 }, binding: null, label: null, purpose: null }]
    const result = validateScene(doc, testTheme)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'invalid_object_id', path: 'objects[0].id' }))
  })
})
