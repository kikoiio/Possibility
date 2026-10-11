import { describe, expect, it } from 'vitest'
import type { SerializedVoxelDocument, SerializedVoxelSpaces, VoxelObject } from '@possibility/voxel-contract'
import type { WorldReadModel } from '../types'
import { projectVoxelSpaceScene } from '../voxel-scene-projection'

function object(id: string, objectType: string, x: number, z: number): VoxelObject {
  return { id, objectType, anchor: { x, y: 1, z }, rotation: 0 }
}

function doc(overrides: Partial<SerializedVoxelDocument> = {}): SerializedVoxelDocument {
  return {
    format: 'voxel-document',
    version: 1,
    id: 'scene-1',
    theme: 'mist-manor',
    size: { width: 12, height: 8, depth: 12 },
    sections: {},
    objects: [],
    objectCells: [],
    locations: [],
    spaceEntries: [],
    lockedObjectIds: [],
    ...overrides,
  }
}

function manorExterior(): SerializedVoxelDocument {
  return doc({
    objects: [
      object('obj-main-house', 'manor-main-house', 3, 2),
      object('obj-tree-1', 'tree', 9, 6),
    ],
    objectCells: [
      { objectId: 'obj-main-house', cells: [{ x: 3, y: 1, z: 2 }, { x: 4, y: 1, z: 2 }, { x: 5, y: 1, z: 2 }, { x: 3, y: 1, z: 3 }, { x: 4, y: 1, z: 3 }, { x: 5, y: 1, z: 3 }] },
      { objectId: 'obj-tree-1', cells: [{ x: 9, y: 1, z: 6 }] },
    ],
    locations: [
      { name: '大厅', objectId: 'obj-main-house' },
      { name: '后山散步道', objectId: 'obj-tree-1' },
    ],
    spaceEntries: [
      { spaceId: 'main-house-interior', label: '进入主楼 →', at: { x: 5, y: 1, z: 3 } },
    ],
  })
}

function manorSpaces(): SerializedVoxelSpaces {
  return {
    format: 'voxel-spaces',
    version: 1,
    defaultSpaceId: 'exterior',
    spaces: [
      { id: 'exterior', name: '外景', document: manorExterior() },
      {
        id: 'main-house-interior',
        name: '主楼内厅',
        document: doc({
          id: 'scene-1',
          size: { width: 6, height: 5, depth: 6 },
          objects: [object('obj-bookshelf', 'bookshelf', 1, 1)],
          objectCells: [{ objectId: 'obj-bookshelf', cells: [{ x: 1, y: 1, z: 1 }] }],
          spaceEntries: [{ spaceId: 'exterior', label: '回到庭院 →', at: { x: 2, y: 1, z: 3 } }],
        }),
      },
    ],
  }
}

function world(locations: readonly string[] = ['大厅', '后山散步道'], residents: WorldReadModel['residents'] = [
  { personId: 'p1', name: '千鹤', locationName: '大厅', activity: null },
]): WorldReadModel {
  return {
    scope: { source: 'account', worldId: 'w1', timelineId: 'main', sceneId: 'scene-1', sceneVersion: 2 },
    worldName: '雾影庄',
    simNow: '2026-10-07T12:00:00Z',
    timeZone: 'Asia/Shanghai',
    stateVersion: 5,
    locations: locations.map(name => ({ name, description: `${name}的描述` })),
    residents,
    environment: [{ id: 'f1', locationName: null, condition: 'weather', value: 'rain', simTime: '2026-10-07T12:00:00Z', version: 1 }],
  }
}

const baseInput = {
  spaceId: 'exterior',
  world: world(),
  sceneId: 'scene-1',
  sceneVersion: 2,
}

describe('voxel scene projection bridge', () => {
  it('projects a real exterior document into a scene bound to the API scene identity', () => {
    const result = projectVoxelSpaceScene({ ...baseInput, envelope: manorExterior() })
    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}: ${result.reason}`)
    const { scene, presentation } = result
    expect(scene.id).toBe('scene-1')
    expect(scene.version).toBe(2)
    expect(scene.defaultSpaceId).toBe('exterior')
    expect(scene.assetManifest['main-house']).toBeDefined()
    const space = scene.spaces[0]
    expect(space.id).toBe('exterior')
    expect(space.bounds).toEqual({ width: 12, depth: 12 })
    // 主楼是建筑；树是阻挡装饰。物件列来自文档 objectCells 投影。
    expect(scene.buildings.map(building => building.id)).toEqual(['obj-main-house'])
    expect(space.staticObjects.map(item => item.id)).toContain('obj-tree-1')
    // 单空间信封没有可进入的室内空间：入口登记为 null，大厅按外景锚点呈现。
    expect(scene.buildings[0].interiorSpaceId).toBeNull()
    const hall = scene.locationBindings.find(binding => binding.sourceLocationName === '大厅')
    expect(hall?.representation).toMatchObject({ kind: 'outdoor', spaceId: 'exterior', anchor: { x: 3, z: 2 } })
    const hill = scene.locationBindings.find(binding => binding.sourceLocationName === '后山散步道')
    expect(hill?.representation).toMatchObject({ kind: 'outdoor', spaceId: 'exterior', anchor: { x: 9, z: 6 } })
    expect(hill?.representation.kind === 'outdoor' && hill.representation.residentSlots.length).toBeGreaterThan(0)
    // 表现与场景、读模型同源：同一 scope、同一空间、同一模拟时刻。
    expect(presentation.scope).toEqual(world().scope)
    expect(presentation.spaceId).toBe('exterior')
    expect(presentation.simNow).toBe('2026-10-07T12:00:00Z')
    expect(presentation.timeZone).toBe('Asia/Shanghai')
    expect(presentation.environment?.weather).toBe('rain')
    expect(presentation.objects.some(item => item.kind === 'building')).toBe(true)
    expect(presentation.objects.some(item => item.kind === 'decoration')).toBe(true)
  })

  it('registers real interiors and an interior hall binding when the envelope carries both spaces', () => {
    const result = projectVoxelSpaceScene({ ...baseInput, envelope: manorSpaces() })
    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}: ${result.reason}`)
    const { scene } = result
    expect(scene.buildings[0]).toMatchObject({
      id: 'obj-main-house', assetId: 'main-house', interiorSpaceId: 'main-house-interior',
      locationKeys: ['大厅'],
    })
    const hall = scene.locationBindings.find(binding => binding.sourceLocationName === '大厅')
    expect(hall?.representation).toMatchObject({
      kind: 'interior', spaceId: 'main-house-interior', entryBuildingId: 'obj-main-house',
    })
    // 可用空间描述保留两个空间，供选择器与替代入口使用。
    expect(scene.spaces).toHaveLength(1)
    expect(scene.spaces[0].id).toBe('exterior')
  })

  it('projects an interior space with walkable cells and a back-entry anchor for its location', () => {
    const result = projectVoxelSpaceScene({ ...baseInput, spaceId: 'main-house-interior', envelope: manorSpaces() })
    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}: ${result.reason}`)
    const { scene } = result
    const space = scene.spaces[0]
    expect(space.id).toBe('main-house-interior')
    expect(space.kind).toBe('interior')
    expect(space.bounds).toEqual({ width: 6, depth: 6 })
    // 室内外圈按墙体处理，不可行走。
    expect(space.walkableCells.some(cell => cell.x === 0 || cell.z === 0 || cell.x === 5 || cell.z === 5)).toBe(false)
    expect(space.walkableCells).toContainEqual({ x: 2, z: 3 })
    // 大厅的室内锚点取内厅指回外景的入口位置。
    const hall = scene.locationBindings.find(binding => binding.sourceLocationName === '大厅')
    expect(hall?.representation).toMatchObject({ kind: 'interior', spaceId: 'main-house-interior', anchor: { x: 2, z: 3 } })
    // 登记的室内家具按锚点各渲染一个实例（bookshelf → hall-table）。
    expect(space.staticObjects).toEqual([
      { id: 'obj-bookshelf', assetId: 'hall-table', origin: { x: 1, z: 1 }, blocksMovement: true },
    ])
  })

  it('rejects documents whose theme is not in the 2D registry', () => {
    const result = projectVoxelSpaceScene({
      ...baseInput,
      envelope: doc({ theme: 'cyber-city', objects: [object('x', 'neon-tower', 1, 1)] }),
    })
    expect(result).toMatchObject({ kind: 'unsupported', code: 'theme-unsupported' })
    expect('reason' in result && result.reason).not.toContain('雾影庄')
  })

  it('reports locations as unrepresented when their carrier is missing, and fails honestly when none resolve', () => {
    const partial = projectVoxelSpaceScene({
      ...baseInput,
      envelope: manorExterior(),
      world: world(['大厅', '不存在的地点'], []),
    })
    if (partial.kind !== 'ok') throw new Error('expected ok')
    const missing = partial.scene.locationBindings.find(binding => binding.sourceLocationName === '不存在的地点')
    expect(missing?.representation).toEqual({ kind: 'unrepresented', buildingId: null })

    const none = projectVoxelSpaceScene({
      ...baseInput,
      envelope: manorExterior(),
      world: world(['幽灵地点'], []),
    })
    expect(none).toMatchObject({ kind: 'unsupported', code: 'locations-unprojectable' })
  })

  it('returns unsupported when the space leaves no walkable cells', () => {
    const walled = doc({
      size: { width: 2, height: 2, depth: 2 },
      objects: [object('obj-block-1', 'manor-main-house', 0, 0), object('obj-block-2', 'manor-main-house', 1, 1)],
      objectCells: [
        { objectId: 'obj-block-1', cells: [{ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 1 }] },
        { objectId: 'obj-block-2', cells: [{ x: 1, y: 1, z: 1 }] },
      ],
      locations: [],
    })
    const result = projectVoxelSpaceScene({ ...baseInput, envelope: walled })
    expect(result).toMatchObject({ kind: 'unsupported', code: 'space-unreadable' })
  })

  it('is deterministic: the same document and snapshot produce identical output', () => {
    const envelope = manorSpaces()
    const first = projectVoxelSpaceScene({ ...baseInput, envelope })
    const second = projectVoxelSpaceScene({ ...baseInput, envelope })
    expect(second).toEqual(first)
  })
})
