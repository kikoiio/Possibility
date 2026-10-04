import { describe, expect, it } from 'vitest'
import type { BuildingDefinition, GridPoint, SceneDefinition, SpaceDefinition } from '../types'
import { ASSET_MANIFEST, BUILDING_ENTRY_OFFSETS, HALL_FLOOR_GRID } from '../assets'
import { FIXTURE_LOCATION_NAMES, FIXTURE_SCENE_ID, FIXTURE_SCENE_VERSION } from '../fixtures'
import {
  EXTERIOR_SPACE_ID,
  HALL_SPACE_ID,
  LOCATION_KEYS,
  MIST_MANOR_SCENE,
  MIST_MANOR_SCENE_ID,
  MIST_MANOR_SCENE_VERSION,
  createMistManorScene,
} from '../scene'

const scene = MIST_MANOR_SCENE

function key(p: GridPoint): string {
  return `${p.x},${p.z}`
}

function spaceOf(target: SceneDefinition, spaceId: string): SpaceDefinition {
  const space = target.spaces.find((s) => s.id === spaceId)
  if (!space) throw new Error(`测试场景缺少空间 ${spaceId}`)
  return space
}

function walkableKeys(space: SpaceDefinition): Set<string> {
  return new Set(space.walkableCells.map(key))
}

/** 空间内全部阻挡物件（blocksMovement）占用的绝对格子。 */
function blockedKeys(space: SpaceDefinition): Set<string> {
  const cells = new Set<string>()
  for (const obj of space.staticObjects) {
    if (!obj.blocksMovement) continue
    const asset = ASSET_MANIFEST[obj.assetId]
    for (const offset of asset.footprint) {
      cells.add(key({ x: obj.origin.x + offset.x, z: obj.origin.z + offset.z }))
    }
  }
  return cells
}

/** 建筑按初始原点占用的绝对格子。 */
function buildingCells(building: BuildingDefinition): GridPoint[] {
  const asset = ASSET_MANIFEST[building.assetId]
  return asset.footprint.map((offset) => ({
    x: building.initialOrigin.x + offset.x,
    z: building.initialOrigin.z + offset.z,
  }))
}

function buildingEntry(building: BuildingDefinition): GridPoint {
  return {
    x: building.initialOrigin.x + building.entryOffset.x,
    z: building.initialOrigin.z + building.entryOffset.z,
  }
}

function exteriorSpace(): SpaceDefinition {
  return spaceOf(scene, EXTERIOR_SPACE_ID)
}

function hallSpace(): SpaceDefinition {
  return spaceOf(scene, HALL_SPACE_ID)
}

function binding(locationKey: string) {
  const found = scene.locationBindings.find((b) => b.locationKey === locationKey)
  if (!found) throw new Error(`测试场景缺少地点绑定 ${locationKey}`)
  return found
}

describe('T28 素材契约汇合', () => {
  it('清单包含 24 个真实文件 URL，分层尺寸与脚点一致', () => {
    const layers = Object.values(ASSET_MANIFEST).flatMap((asset) => asset.layers)
    expect(layers).toHaveLength(24)
    expect(new Set(layers.map((layer) => layer.url)).size).toBe(24)
    for (const asset of Object.values(ASSET_MANIFEST)) {
      const first = asset.layers[0]
      expect(first).toBeDefined()
      for (const layer of asset.layers) {
        expect(layer.url.startsWith('/native2d/mist-manor/')).toBe(true)
        expect(layer.pixelWidth).toBe(first.pixelWidth)
        expect(layer.pixelHeight).toBe(first.pixelHeight)
        expect(layer.anchorPx).toEqual(first.anchorPx)
      }
    }
  })
})

describe('场景身份与空间', () => {
  it('场景 id/version 与 fixtures 对齐，defaultSpaceId 指向外景', () => {
    expect(scene.id).toBe(MIST_MANOR_SCENE_ID)
    expect(scene.id).toBe(FIXTURE_SCENE_ID)
    expect(scene.version).toBe(MIST_MANOR_SCENE_VERSION)
    expect(scene.version).toBe(FIXTURE_SCENE_VERSION)
    const defaultSpace = spaceOf(scene, scene.defaultSpaceId)
    expect(defaultSpace.kind).toBe('exterior')
    expect(defaultSpace.id).toBe(EXTERIOR_SPACE_ID)
  })

  it('恰好两个空间：外景（含 connectivityRoot）与 6×5 大厅内景', () => {
    expect(scene.spaces).toHaveLength(2)
    expect(exteriorSpace().kind).toBe('exterior')
    expect(exteriorSpace().connectivityRoot).not.toBeNull()
    const hall = hallSpace()
    expect(hall.kind).toBe('interior')
    expect(hall.bounds).toEqual({ width: HALL_FLOOR_GRID.width, depth: HALL_FLOOR_GRID.depth })
    expect(hall.connectivityRoot).toBeNull()
  })

  it('工厂每次返回全新数组与对象，内容与冻结常量一致', () => {
    const fresh = createMistManorScene()
    expect(fresh).toEqual(scene)
    expect(fresh).not.toBe(scene)
    expect(fresh.spaces).not.toBe(scene.spaces)
    expect(fresh.buildings).not.toBe(scene.buildings)
    expect(fresh.locationBindings).not.toBe(scene.locationBindings)
    expect(fresh.spaces[0].walkableCells).not.toBe(scene.spaces[0].walkableCells)
  })
})

describe('建筑定义', () => {
  it('恰好三栋建筑且 id 唯一', () => {
    expect(scene.buildings.map((b) => b.id)).toEqual(['main-house', 'greenhouse', 'gatehouse'])
    expect(new Set(scene.buildings.map((b) => b.id)).size).toBe(scene.buildings.length)
  })

  it('entryOffset 采用 assets.ts 冻结的 BUILDING_ENTRY_OFFSETS', () => {
    for (const building of scene.buildings) {
      expect(building.entryOffset).toEqual(BUILDING_ENTRY_OFFSETS[building.id])
    }
  })

  it('主楼 interiorSpaceId 指向大厅，温室与门房无内景', () => {
    const mainHouse = scene.buildings.find((b) => b.id === 'main-house')
    expect(mainHouse?.interiorSpaceId).toBe(HALL_SPACE_ID)
    for (const id of ['greenhouse', 'gatehouse']) {
      expect(scene.buildings.find((b) => b.id === id)?.interiorSpaceId).toBeNull()
    }
    for (const building of scene.buildings) {
      expect(building.spaceId).toBe(EXTERIOR_SPACE_ID)
    }
  })
})

describe('地点绑定', () => {
  it('大厅为 interior 绑定主楼，entryBuildingId 与 main-house.interiorSpaceId 互指一致', () => {
    const hall = binding(LOCATION_KEYS.hall)
    expect(hall.sourceLocationName).toBe(FIXTURE_LOCATION_NAMES.hall)
    expect(hall.representation.kind).toBe('interior')
    const rep = hall.representation
    if (rep.kind !== 'interior') return
    expect(rep.spaceId).toBe(HALL_SPACE_ID)
    expect(rep.entryBuildingId).toBe('main-house')
    const mainHouse = scene.buildings.find((b) => b.id === rep.entryBuildingId)
    expect(mainHouse?.interiorSpaceId).toBe(rep.spaceId)
    expect(rep.residentSlots.length).toBeGreaterThan(0)
  })

  it('书房/餐厅/图书室绑定主楼且为 unrepresented', () => {
    const cases = [
      [LOCATION_KEYS.study, FIXTURE_LOCATION_NAMES.study],
      [LOCATION_KEYS.dining, FIXTURE_LOCATION_NAMES.diningRoom],
      [LOCATION_KEYS.library, FIXTURE_LOCATION_NAMES.library],
    ] as const
    for (const [locationKey, sourceName] of cases) {
      const item = binding(locationKey)
      expect(item.sourceLocationName).toBe(sourceName)
      expect(item.representation).toEqual({ kind: 'unrepresented', buildingId: 'main-house' })
    }
  })

  it('温室花房/门房小屋绑定各自建筑且为 unrepresented', () => {
    expect(binding(LOCATION_KEYS.greenhouseRoom).sourceLocationName).toBe(
      FIXTURE_LOCATION_NAMES.greenhouse,
    )
    expect(binding(LOCATION_KEYS.greenhouseRoom).representation).toEqual({
      kind: 'unrepresented',
      buildingId: 'greenhouse',
    })
    expect(binding(LOCATION_KEYS.gatehouseRoom).sourceLocationName).toBe(
      FIXTURE_LOCATION_NAMES.gatehouse,
    )
    expect(binding(LOCATION_KEYS.gatehouseRoom).representation).toEqual({
      kind: 'unrepresented',
      buildingId: 'gatehouse',
    })
  })

  it('后山散步道为 outdoor：外景锚点与示意站位', () => {
    const hill = binding(LOCATION_KEYS.hillPath)
    expect(hill.sourceLocationName).toBe(FIXTURE_LOCATION_NAMES.backHillTrail)
    expect(hill.representation.kind).toBe('outdoor')
    if (hill.representation.kind !== 'outdoor') return
    expect(hill.representation.spaceId).toBe(EXTERIOR_SPACE_ID)
    expect(hill.representation.residentSlots.length).toBeGreaterThan(0)
  })

  it('sourceLocationName 与 fixtures 的七个真实地点名一一对应', () => {
    const expected = new Set(Object.values(FIXTURE_LOCATION_NAMES))
    const actual = scene.locationBindings.map((b) => b.sourceLocationName)
    expect(new Set(actual)).toEqual(expected)
    expect(actual).toHaveLength(expected.size)
  })

  it('建筑的 locationKeys 与地点绑定互相覆盖、无孤儿引用', () => {
    const boundKeys = new Set(scene.locationBindings.map((b) => b.locationKey))
    for (const building of scene.buildings) {
      for (const locationKey of building.locationKeys) {
        expect(boundKeys.has(locationKey)).toBe(true)
      }
    }
    const referencedByBuildings = new Set(scene.buildings.flatMap((b) => b.locationKeys))
    for (const item of scene.locationBindings) {
      if (item.representation.kind === 'outdoor') continue // 后山散步道为纯外景地点，不属于任何建筑
      expect(referencedByBuildings.has(item.locationKey)).toBe(true)
    }
  })
})

describe('唯一性与素材引用', () => {
  it('空间、建筑、静态物件与地点键全部唯一', () => {
    expect(new Set(scene.spaces.map((s) => s.id)).size).toBe(scene.spaces.length)
    expect(new Set(scene.buildings.map((b) => b.id)).size).toBe(scene.buildings.length)
    expect(new Set(scene.locationBindings.map((b) => b.locationKey)).size).toBe(
      scene.locationBindings.length,
    )
    const staticIds = scene.spaces.flatMap((s) => s.staticObjects.map((o) => o.id))
    expect(new Set(staticIds).size).toBe(staticIds.length)
  })

  it('全部素材引用存在于 ASSET_MANIFEST，场景清单即冻结清单', () => {
    expect(scene.assetManifest).toBe(ASSET_MANIFEST)
    for (const building of scene.buildings) {
      expect(ASSET_MANIFEST[building.assetId]).toBeDefined()
    }
    for (const space of scene.spaces) {
      for (const obj of space.staticObjects) {
        expect(ASSET_MANIFEST[obj.assetId]).toBeDefined()
      }
    }
  })

  it('外景包含树/灌木阻挡、水岸装饰与道路视觉格', () => {
    const exterior = exteriorSpace()
    const blocking = exterior.staticObjects.filter((o) => o.blocksMovement)
    expect(blocking.some((o) => o.assetId === 'tree')).toBe(true)
    expect(blocking.some((o) => o.assetId === 'shrub')).toBe(true)
    expect(exterior.staticObjects.some((o) => o.assetId === 'shore')).toBe(true)
    expect(exterior.staticObjects.some((o) => o.assetId === 'path')).toBe(true)
    // 道路视觉格覆盖三个建筑入口与后山锚点（path 对齐可通行区域）。
    const pathKeys = new Set(
      exterior.staticObjects.filter((o) => o.assetId === 'path').map((o) => key(o.origin)),
    )
    for (const building of scene.buildings) {
      expect(pathKeys.has(key(buildingEntry(building)))).toBe(true)
    }
    const hill = binding(LOCATION_KEYS.hillPath)
    if (hill.representation.kind === 'outdoor') {
      expect(pathKeys.has(key(hill.representation.anchor))).toBe(true)
    }
  })

  it('大厅包含地面/墙体/家具且墙体与家具阻挡', () => {
    const hall = hallSpace()
    const byAsset = (assetId: string) => hall.staticObjects.filter((o) => o.assetId === assetId)
    expect(byAsset('hall-floor')).toHaveLength(1)
    expect(byAsset('hall-floor')[0].blocksMovement).toBe(false)
    expect(byAsset('hall-wall')).toHaveLength(1)
    expect(byAsset('hall-wall')[0].blocksMovement).toBe(true)
    for (const assetId of ['hall-table', 'hall-chair', 'hall-lamp']) {
      expect(byAsset(assetId).length).toBeGreaterThan(0)
      expect(byAsset(assetId).every((o) => o.blocksMovement)).toBe(true)
    }
  })
})

describe('初始布局合法性', () => {
  const exterior = exteriorSpace()
  const walkable = walkableKeys(exterior)
  const blocked = blockedKeys(exterior)
  const footprintByBuilding = new Map(scene.buildings.map((b) => [b.id, buildingCells(b)]))
  const allFootprintCells = [...footprintByBuilding.values()].flat().map(key)

  it('三栋建筑占地全部在界内且落在可通行格子上', () => {
    for (const building of scene.buildings) {
      const cells = footprintByBuilding.get(building.id) ?? []
      expect(cells.length).toBeGreaterThan(0)
      for (const cell of cells) {
        expect(cell.x).toBeGreaterThanOrEqual(0)
        expect(cell.z).toBeGreaterThanOrEqual(0)
        expect(cell.x).toBeLessThan(exterior.bounds.width)
        expect(cell.z).toBeLessThan(exterior.bounds.depth)
        expect(walkable.has(key(cell))).toBe(true)
      }
    }
  })

  it('建筑之间互不重叠，且不覆盖阻挡物件', () => {
    const seen = new Set<string>()
    for (const building of scene.buildings) {
      for (const cell of footprintByBuilding.get(building.id) ?? []) {
        const cellKeyValue = key(cell)
        expect(seen.has(cellKeyValue)).toBe(false)
        seen.add(cellKeyValue)
        expect(blocked.has(cellKeyValue)).toBe(false)
      }
    }
  })

  it('入口格子在 walkableCells 内、不被阻挡、不被任何建筑占地覆盖', () => {
    for (const building of scene.buildings) {
      const entry = buildingEntry(building)
      expect(walkable.has(key(entry))).toBe(true)
      expect(blocked.has(key(entry))).toBe(false)
      expect(allFootprintCells).not.toContain(key(entry))
    }
  })

  it('锚点与示意站位在合法地面且不被初始布局覆盖', () => {
    for (const item of scene.locationBindings) {
      const rep = item.representation
      if (rep.kind !== 'outdoor' && rep.kind !== 'interior') continue
      const space = spaceOf(scene, rep.spaceId)
      const spaceWalkable = walkableKeys(space)
      const spaceBlocked = blockedKeys(space)
      const points = [rep.anchor, ...rep.residentSlots]
      for (const point of points) {
        expect(spaceWalkable.has(key(point))).toBe(true)
        expect(spaceBlocked.has(key(point))).toBe(false)
        if (rep.kind === 'outdoor') {
          expect(allFootprintCells).not.toContain(key(point))
        }
      }
    }
  })

  it('connectivityRoot 可通行：在 walkableCells 内、不被阻挡、不被建筑覆盖', () => {
    const root = exterior.connectivityRoot
    if (!root) throw new Error('外景缺少 connectivityRoot')
    expect(walkable.has(key(root))).toBe(true)
    expect(blocked.has(key(root))).toBe(false)
    expect(allFootprintCells).not.toContain(key(root))
  })

  it('初始布局下全部建筑入口与后山锚点/站位自 connectivityRoot 连通（四方向 BFS）', () => {
    const root = exterior.connectivityRoot
    if (!root) throw new Error('外景缺少 connectivityRoot')
    const free = new Set(
      [...walkable].filter((cell) => !blocked.has(cell) && !allFootprintCells.includes(cell)),
    )
    const visited = new Set<string>([key(root)])
    const queue: GridPoint[] = [root]
    while (queue.length > 0) {
      const current = queue.shift() as GridPoint
      for (const next of [
        { x: current.x + 1, z: current.z },
        { x: current.x - 1, z: current.z },
        { x: current.x, z: current.z + 1 },
        { x: current.x, z: current.z - 1 },
      ]) {
        const nextKey = key(next)
        if (free.has(nextKey) && !visited.has(nextKey)) {
          visited.add(nextKey)
          queue.push(next)
        }
      }
    }
    for (const building of scene.buildings) {
      expect(visited.has(key(buildingEntry(building)))).toBe(true)
    }
    const hill = binding(LOCATION_KEYS.hillPath)
    if (hill.representation.kind !== 'outdoor') throw new Error('后山散步道应为 outdoor')
    expect(visited.has(key(hill.representation.anchor))).toBe(true)
    for (const slot of hill.representation.residentSlots) {
      expect(visited.has(key(slot))).toBe(true)
    }
  })

  it('场景存在可被建筑移动堵死的窄路与可绕行的宽路（连通校验有意义）', () => {
    // 窄路：主街 x=8 与 z=12 横路交口一带——后山锚点方向在初始布局下唯一通道上的格子。
    const hill = binding(LOCATION_KEYS.hillPath)
    if (hill.representation.kind !== 'outdoor') throw new Error('后山散步道应为 outdoor')
    // 主楼东侧 x=8 树墙与主楼之间的 x=7 窄路格子可通行。
    expect(walkable.has(key({ x: 7, z: 3 }))).toBe(true)
    expect(blocked.has(key({ x: 8, z: 3 }))).toBe(true)
    // 宽路：z=6 整行与 z=13 整行开放，可绕行。
    for (const x of [2, 7, 9, 12, 14]) {
      expect(walkable.has(key({ x, z: 6 }))).toBe(true)
      expect(blocked.has(key({ x, z: 6 }))).toBe(false)
      expect(walkable.has(key({ x, z: 13 }))).toBe(true)
      expect(blocked.has(key({ x, z: 13 }))).toBe(false)
    }
  })
})
