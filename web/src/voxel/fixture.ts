import {
  applyEdits, clampTerrainParams, createEmptyWorld, generateTerrain, getBlock, writeTerrainCells,
  type EditOperation, type VoxelDocument,
} from '@possibility/voxel-contract'

/** 开发/测试共用的雾影庄外景 fixture：主楼、温室、庭院、池塘、小径、树与灯笼 */
export function buildFixtureWorld(): VoxelDocument {
  const size = { width: 48, height: 24, depth: 48 }
  const ops: EditOperation[] = [
    // 地面：草地 + 局部山石
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 47, y: 0, z: 47 }, block: 'grass' },
    { kind: 'fill', from: { x: 36, y: 1, z: 0 }, to: { x: 47, y: 2, z: 10 }, block: 'stone' },
    // 石板小径：院门 → 主楼
    { kind: 'fill', from: { x: 22, y: 1, z: 30 }, to: { x: 24, y: 1, z: 40 }, block: 'cobble' },
    { kind: 'fill', from: { x: 10, y: 1, z: 34 }, to: { x: 21, y: 1, z: 36 }, block: 'cobble' },
    // 池塘（挖掉草，放水和碎石底）
    { kind: 'fill', from: { x: 32, y: 1, z: 30 }, to: { x: 38, y: 1, z: 36 }, block: 'air' },
    { kind: 'fill', from: { x: 32, y: 1, z: 30 }, to: { x: 38, y: 1, z: 36 }, block: 'water' },
    // 主楼（锁定，绑定"主楼"地点）
    { kind: 'place-object', objectType: 'manor-main-house', anchor: { x: 20, y: 1, z: 18 }, rotation: 0, objectId: 'house', label: '雾影庄主楼' },
    // 温室
    { kind: 'place-object', objectType: 'manor-greenhouse', anchor: { x: 6, y: 1, z: 10 }, rotation: 0, objectId: 'greenhouse', label: '温室' },
    // 庭院布置
    { kind: 'place-object', objectType: 'stone-lantern', anchor: { x: 20, y: 2, z: 33 }, rotation: 0, objectId: 'lantern-a' },
    { kind: 'place-object', objectType: 'stone-lantern', anchor: { x: 26, y: 2, z: 33 }, rotation: 0, objectId: 'lantern-b' },
    { kind: 'place-object', objectType: 'tree', anchor: { x: 8, y: 1, z: 28 }, rotation: 0, objectId: 'tree-a' },
    { kind: 'place-object', objectType: 'tree', anchor: { x: 40, y: 1, z: 20 }, rotation: 90, objectId: 'tree-b' },
    { kind: 'place-object', objectType: 'flower-bed', anchor: { x: 14, y: 2, z: 32 }, rotation: 0, objectId: 'flowers' },
    { kind: 'place-object', objectType: 'well', anchor: { x: 30, y: 1, z: 14 }, rotation: 0, objectId: 'well' },
    { kind: 'place-object', objectType: 'fence-run', anchor: { x: 4, y: 1, z: 22 }, rotation: 90, objectId: 'fence-a' },
  ]
  const base = createEmptyWorld(size, 'mist-manor', 'fixture-mist-manor')
  const result = applyEdits(base, ops)
  return {
    ...result.document,
    locations: [
      { name: '主楼', objectId: 'house' },
      { name: '温室', objectId: 'greenhouse' },
      { name: '庭院', objectId: 'lantern-a' },
    ],
    spaceEntries: [
      { spaceId: 'main-hall', label: '进入主楼 →', at: { x: 23, y: 1, z: 24 } },
    ],
    lockedObjectIds: ['house'],
  }
}

/** 柱顶高度：从世界顶部向下第一个非空格 */
function columnTop(doc: VoxelDocument, x: number, z: number): number {
  for (let y = doc.size.height - 1; y >= 0; y--) {
    if (getBlock(doc, { x, y, z }) !== 'air') return y
  }
  return 0
}

/**
 * S3b 参数化地形 + 风格包 fixture:起伏 + 河流 + 植被,dusk-warm 风格,
 * 主楼与石灯笼落在地形之上(e2e 探针与 walkthrough 用)。
 */
export function buildTerrainFixtureWorld(): VoxelDocument {
  const size = { width: 48, height: 24, depth: 48 }
  const { params, clamps } = clampTerrainParams({
    seed: 20260929,
    elevation: { amplitude: 5, scale: 24 },
    river: { enabled: true, width: 2 },
    lakes: { enabled: false },
    vegetation: { density: 0.05, trees: true, flowers: true, bushes: true },
  }, size)
  const generated = generateTerrain(size, params)
  const terrainDoc = {
    ...writeTerrainCells(createEmptyWorld(size, 'mist-manor', 'fixture-terrain'), generated.cells).document,
    ...(generated.assetPlacements.length > 0 ? { assetPlacements: generated.assetPlacements } : {}),
  }
  const result = applyEdits(terrainDoc, [
    { kind: 'place-object', objectType: 'manor-main-house', anchor: { x: 8, y: columnTop(terrainDoc, 8, 8) + 1, z: 8 }, rotation: 0, objectId: 'house', label: '地形主楼' },
    { kind: 'place-object', objectType: 'stone-lantern', anchor: { x: 16, y: columnTop(terrainDoc, 16, 12) + 1, z: 12 }, rotation: 0, objectId: 'lantern-a' },
  ])
  return {
    ...result.document,
    terrain: { params, clamps },
    style: { preset: 'dusk-warm', tweaks: { exposure: 0.05 } },
    locations: [{ name: '主楼', objectId: 'house' }],
    lockedObjectIds: ['house'],
  }
}
