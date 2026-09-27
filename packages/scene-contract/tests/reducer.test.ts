import { describe, expect, it } from 'vitest'
import { applySceneOperations } from '../src/reducer'
import { testTheme } from '../src/themes/test-theme'
import type { SceneDocument } from '../src/types'
const empty = (): SceneDocument => ({ schemaVersion: 1, themeId: testTheme.id, size: { columns: 8, rows: 8 }, version: 0, terrain: [], paths: [], objects: [], lockedObjectIds: [], lockedAreas: [] })
const object = (id: string, x: number) => ({ id, assetId: 'test-building', position: { x, y: 1 }, binding: null, label: null, purpose: null })
describe('scene operation reducer', () => {
  it('applies object, lock, paint and erase operations immutably', () => {
    const base = empty(); const result = applySceneOperations(base, [
      { type: 'add_object', object: object('house', 1) }, { type: 'move_object', objectId: 'house', to: { x: 2, y: 2 } },
      { type: 'update_object', objectId: 'house', label: 'home' }, { type: 'lock_object', objectId: 'house', locked: true },
      { type: 'paint_cells', category: 'road', assetId: 'test-road', cells: [{ x: 0, y: 0 }, { x: 0, y: 0 }] },
      { type: 'erase_cells', category: 'road', cells: [{ x: 0, y: 0 }] },
    ], testTheme)
    expect(base.objects).toHaveLength(0); expect(result.document.objects[0]?.position).toEqual({ x: 2, y: 2 }); expect(result.document.lockedObjectIds).toEqual(['house']); expect(result.document.paths).toHaveLength(0)
    expect(result.changes).toEqual({ added: ['house'], moved: ['house'], updated: ['house'], removed: [] })
  })
  it('rejects operations atomically when locked or invalid', () => {
    const base = empty(); base.objects = [object('house', 1)]; base.lockedObjectIds = ['house']
    expect(() => applySceneOperations(base, [{ type: 'move_object', objectId: 'house', to: { x: 4, y: 4 } }], testTheme)).toThrow('对象已锁定')
    expect(base.objects[0]?.position).toEqual({ x: 1, y: 1 })
    const area = empty(); area.lockedAreas = [{ x: 4, y: 4, width: 2, height: 2 }]
    expect(() => applySceneOperations(area, [{ type: 'add_object', object: { ...object('near-lock', 3), position: { x: 4, y: 4 } } }], testTheme)).toThrow('锁定区域')
    expect(() => applySceneOperations(empty(), [{ type: 'lock_area', area: { x: 4, y: 4, width: 2, height: 2 } }, { type: 'add_object', object: { ...object('cross-lock', 3), position: { x: 4, y: 4 } } }], testTheme)).toThrow('锁定区域')
  })
  it('supports test theme across all categories without reducer changes', () => {
    const base = empty(); const doc = applySceneOperations(base, [{ type: 'add_object', object: { ...object('decor', 0), assetId: 'test-decoration' } }], testTheme).document
    expect(doc.objects[0]?.assetId).toBe('test-decoration')
  })
})
