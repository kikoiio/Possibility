import {
  applyEdits, clampTerrainParams, createEmptyWorld, generateTerrain, getBlock, writeTerrainCells,
  type EditOperation, type VoxelDocument, type WorldEvent,
} from '@possibility/voxel-contract'

/**
 * S3b 事件披露 fixture 的参考「现在」(F3):dev-harness 加载后下发,
 * 四个示例事件的时间窗以此为锚——婚礼/集市窗内,火灾已结束(留痕),花市未开始(隐藏)。
 * e2e 可经探针 setSimNow 覆盖。
 */
export const FIXTURE_SIM_NOW = '2026-10-15T17:00:00Z'

/** 示例事件(覆盖三类型 × 三时间态 × 高低重要度);at 的 y 由调用方按地表定 */
export function fixtureEvents(groundY: (x: number, z: number) => number): WorldEvent[] {
  return [
    {
      id: 'evt-wedding',
      type: 'celebration',
      at: { x: 23, y: groundY(23, 34), z: 34 },   // 庭院石灯笼之间
      importance: 'high',
      timeWindow: { start: '2026-10-15T16:00:00Z', end: '2026-10-15T20:00:00Z' },
      label: '婚礼',
      teaser: '艾拉与芬恩在庭院里交换誓言',
      scene: '灯笼次第亮起,艾拉与芬恩在两盏石灯笼之间交换誓言。居民们围成一圈,花瓣从温室方向一路铺到井边。管家老周悄悄抹了把眼角,转身去厨房端出藏了三天的梅子酒。',
      participants: ['person-ella', 'person-finn'],
    },
    {
      id: 'evt-market',
      type: 'daily',
      at: { x: 30, y: groundY(30, 15), z: 15 },   // 水井旁
      importance: 'low',
      timeWindow: { start: '2026-10-15T14:00:00Z', end: '2026-10-15T18:00:00Z' },
      label: '集市',
      teaser: '井边的傍晚集市快收摊了',
      scene: '水井旁支着三张矮桌,卖花的婆婆开始把剩下的雏菊捆成束。铁匠铺的学徒拎着水壶跑来跑去,讨价还价声渐渐低下去。',
    },
    {
      id: 'evt-fire',
      type: 'turning',
      at: { x: 6, y: groundY(6, 11), z: 11 },     // 温室
      importance: 'high',
      timeWindow: { start: '2026-10-14T10:00:00Z', end: '2026-10-14T12:00:00Z' },
      label: '火灾',
      teaser: '温室昨夜失火,幸好无人受伤',
      scene: '昨夜温室的油灯翻倒,火苗窜上藤架。值夜的芬恩撞开木门,居民们提着井水接力扑救。烧毁了半架葡萄藤,但种子柜完好无损。今天起,温室夜里不再点灯。',
      participants: ['person-finn'],
    },
    {
      id: 'evt-flower-show',
      type: 'daily',
      at: { x: 35, y: groundY(35, 32), z: 32 },   // 池塘边
      importance: 'medium',
      timeWindow: { start: '2026-10-16T09:00:00Z', end: '2026-10-16T11:00:00Z' },
      label: '花展',
      teaser: '池塘边将办一场小型花展',
      scene: '明天清晨,池塘边会摆出各家培育的新品种。卖花婆婆的雏菊、温室抢救回来的葡萄藤插枝,都在参展名单上。',
    },
  ]
}


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
    // S3b:平面 fixture 地表 y=1(图标挂点 +2.5 由披露层加)
    events: fixtureEvents(() => 1),
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
    // S3b:地形 fixture 地表按柱顶取
    events: fixtureEvents((x, z) => columnTop(result.document, x, z)),
  }
}
