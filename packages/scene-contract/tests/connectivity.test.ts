import { describe, expect, it } from 'vitest'
import { validateSceneConnectivity } from '../src/connectivity'
import { testTheme } from '../src/themes/test-theme'
import type { SceneDocumentV2, SceneThemeManifestV2 } from '../src/types'

const scene: SceneDocumentV2 = {
  schemaVersion: 2, themeId: 'test-minimal', version: 0, defaultSpaceId: 'inside', lockedObjectIds: [], lockedAreas: [], portals: [],
  spaces: [{ id: 'inside', name: '书房', kind: 'interior', size: { columns: 4, rows: 2 }, surface: [], paths: [], structures: [], objects: [], regions: [{ id: 'study', locationName: '书房', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 3, y: 1 }], entryPoint: { x: 3, y: 1 }, interactionPoint: { x: 1, y: 0 } }], navigation: { walkableCells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 3, y: 1 }], blockedCells: [], entrances: [{ x: 0, y: 0 }] } }],
}

describe('scene connectivity validation', () => {
  it('rejects disconnected regions and blocked portal entrances with stable paths', () => {
    const issues = validateSceneConnectivity(scene, testTheme)
    expect(issues.some(issue => issue.code === 'unreachable_region' && issue.path === 'spaces[0].regions[0].entryPoint')).toBe(true)
    const blocked = structuredClone(scene)
    blocked.spaces[0]!.navigation.blockedCells.push({ x: 0, y: 0 })
    blocked.portals.push({ id: 'entry', from: { spaceId: 'inside', position: { x: 0, y: 0 }, facing: 'north-east' }, to: { spaceId: 'unknown', position: { x: 0, y: 0 }, facing: 'south-west' }, transition: 'camera' })
    const codes = validateSceneConnectivity(blocked, testTheme).map(issue => issue.code)
    expect(codes).toContain('blocked_entrance')
    expect(codes).toContain('unknown_portal_space')
  })

  it('rejects adjacent structural modules with incompatible connector types', () => {
    const asset = (id: string, edge: 'east' | 'west', type: string) => ({
      id, themeId: 'modular', category: 'structure' as const, name: id,
      sprite: { sheetId: 'atlas', frame: id, states: { idle: id }, frameSize: { width: 32, height: 24 } }, thumbnail: `/${id}.png`,
      geometry: { footprintCells: [{ x: 0, y: 0 }], groundContactCell: { x: 0, y: 0 }, groundContactPixel: { x: 16, y: 20 }, elevation: 0, visualBounds: { x: 0, y: 0, width: 32, height: 24 }, occlusionBounds: [], sortBias: 0 },
      connectors: [{ edge, type, level: 0 }], navigation: { walkableCells: [], blockedCells: [], entrances: [] },
      capabilities: { placeable: true, semanticLocation: false, semanticPerson: false, enterable: false, interactive: false },
    })
    const theme: SceneThemeManifestV2 = { id: 'modular', name: 'Modular', schemaVersion: 2, tileSize: { width: 64, height: 32 }, sheets: [{ id: 'atlas', src: '/atlas.png' }], assets: [asset('door', 'east', 'door'), asset('wall', 'west', 'wall')] }
    const structureScene: SceneDocumentV2 = {
      schemaVersion: 2, themeId: 'modular', version: 0, defaultSpaceId: 'inside', portals: [], lockedObjectIds: [], lockedAreas: [],
      spaces: [{ id: 'inside', name: '房间', kind: 'interior', size: { columns: 3, rows: 2 }, surface: [], paths: [],
        structures: [
          { id: 'door-1', assetId: 'door', position: { x: 0, y: 0 }, binding: null, label: null, purpose: null },
          { id: 'wall-1', assetId: 'wall', position: { x: 1, y: 0 }, binding: null, label: null, purpose: null },
        ], objects: [], regions: [], navigation: { walkableCells: [], blockedCells: [], entrances: [] } }],
    }
    expect(validateSceneConnectivity(structureScene, theme).some(issue => issue.code === 'incompatible_connector')).toBe(true)
  })
})
