import { describe, expect, it } from 'vitest'
import { applySceneOperationsInSpace } from '../src/reducer'
import { normalizeSceneDocument } from '../src/normalize'
import { testTheme } from '../src/themes/test-theme'
import type { SceneDocument, SceneDocumentV2 } from '../src/types'

const legacy: SceneDocument = { schemaVersion: 1, themeId: 'test-minimal', size: { columns: 4, rows: 4 }, version: 0, terrain: [], paths: [], objects: [], lockedObjectIds: [], lockedAreas: [] }

describe('legacy scenes in multi-space editing', () => {
  it('applies v2 edits only to the selected space', () => {
    const base = normalizeSceneDocument(legacy)
    const second: SceneDocumentV2['spaces'][number] = { ...structuredClone(base.spaces[0]!), id: 'interior', name: '室内', kind: 'interior' }
    base.spaces.push(second)
    const result = applySceneOperationsInSpace(base, 'interior', [{ type: 'add_object', object: { id: 'table', assetId: 'test-decoration', position: { x: 1, y: 1 }, binding: null, label: null, purpose: null } }], testTheme)
    expect(result.document.spaces.find(space => space.id === 'interior')?.objects).toHaveLength(1)
    expect(result.document.spaces.find(space => space.id === 'exterior')?.objects).toHaveLength(0)
  })
})
