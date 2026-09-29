import {
  applyEdits, createEmptyWorld,
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
