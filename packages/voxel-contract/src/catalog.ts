import type { ObjectTemplate, VoxelCoord } from './types'

// ── 物体模板仓库（F15）─────────────────────────
// 放置时模板方块烙印进网格；objectCells 登记占据格用于选中/移动/锁定。

const cell = (x: number, y: number, z: number, block: string) => ({ offset: { x, y, z } satisfies VoxelCoord, block })

/** 实心长方体模板 */
function box(w: number, h: number, d: number, block: string): Array<{ offset: VoxelCoord; block: string }> {
  const cells: Array<{ offset: VoxelCoord; block: string }> = []
  for (let y = 0; y < h; y++) for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) cells.push(cell(x, y, z, block))
  return cells
}

/** 主楼：木墙 + 瓦顶的小屋（7×5×6 体素级示意模板） */
function manorHouse(): Array<{ offset: VoxelCoord; block: string }> {
  const cells: Array<{ offset: VoxelCoord; block: string }> = []
  const W = 7, D = 6, WALL_H = 3
  for (let y = 0; y < WALL_H; y++) {
    for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
      const edge = x === 0 || x === W - 1 || z === 0 || z === D - 1
      if (!edge) {
        if (y === 0) cells.push(cell(x, y, z, 'tatami'))
        continue
      }
      const isDoor = z === D - 1 && x === Math.floor(W / 2) && y < 2
      if (isDoor) continue
      const isWindow = y === 1 && (x === 0 || x === W - 1 || z === 0) && (x + z) % 2 === 0
      cells.push(cell(x, y, z, isWindow ? 'paper-window' : 'plaster-wall'))
    }
  }
  // 四根角柱
  for (const [x, z] of [[0, 0], [W - 1, 0], [0, D - 1], [W - 1, D - 1]] as const) {
    for (let y = 0; y < WALL_H; y++) cells.push(cell(x, y, z, 'wood-log'))
  }
  // 瓦顶（向内收一层）
  for (let x = -1; x <= W; x++) for (let z = -1; z <= D; z++) cells.push(cell(x, WALL_H, z, 'roof-tile'))
  for (let x = 1; x < W - 1; x++) for (let z = 1; z < D - 1; z++) cells.push(cell(x, WALL_H + 1, z, 'roof-tile'))
  return cells
}

/** 温室：玻璃盒 + 木骨架 */
function greenhouse(): Array<{ offset: VoxelCoord; block: string }> {
  const cells: Array<{ offset: VoxelCoord; block: string }> = []
  const W = 5, D = 4, H = 3
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) cells.push(cell(x, 0, z, 'wood-plank'))
  for (let y = 1; y < H; y++) {
    for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
      const edge = x === 0 || x === W - 1 || z === 0 || z === D - 1
      if (!edge) continue
      const corner = (x === 0 || x === W - 1) && (z === 0 || z === D - 1)
      const isDoor = z === D - 1 && x === Math.floor(W / 2) && y === 1
      if (isDoor) continue
      cells.push(cell(x, y, z, corner ? 'wood-log' : 'glass'))
    }
  }
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) cells.push(cell(x, H, z, 'glass'))
  return cells
}

/** 树：原木干 + 树叶冠 */
function tree(): Array<{ offset: VoxelCoord; block: string }> {
  const cells: Array<{ offset: VoxelCoord; block: string }> = []
  for (let y = 0; y < 3; y++) cells.push(cell(0, y, 0, 'wood-log'))
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
    cells.push(cell(x, 3, z, 'leaves'))
    if (Math.abs(x) + Math.abs(z) <= 1) cells.push(cell(x, 4, z, 'leaves'))
  }
  return cells
}

export const mistManorObjectTemplates: ObjectTemplate[] = [
  { objectType: 'manor-main-house', name: '雾影庄主楼', cells: manorHouse() },
  { objectType: 'manor-greenhouse', name: '温室', cells: greenhouse() },
  { objectType: 'stone-lantern', name: '石灯笼', cells: [cell(0, 0, 0, 'stone'), cell(0, 1, 0, 'lantern')] },
  { objectType: 'tree', name: '山樱', cells: tree() },
  { objectType: 'fence-run', name: '木栅栏段', cells: [cell(0, 0, 0, 'wood-fence'), cell(1, 0, 0, 'wood-fence'), cell(2, 0, 0, 'wood-fence')] },
  { objectType: 'bench', name: '木长凳', cells: [cell(0, 0, 0, 'wood-plank'), cell(1, 0, 0, 'wood-plank')] },
  { objectType: 'well', name: '水井', cells: [...box(2, 1, 2, 'stone'), cell(0, 1, 0, 'wood-log'), cell(1, 1, 0, 'wood-log'), cell(0, 1, 1, 'roof-tile'), cell(1, 1, 1, 'roof-tile')] },
  { objectType: 'flower-bed', name: '花坛', cells: [cell(0, 0, 0, 'flower'), cell(1, 0, 0, 'flower'), cell(0, 0, 1, 'flower'), cell(1, 0, 1, 'flower')] },
]

const templateIndex = new Map(mistManorObjectTemplates.map((t) => [t.objectType, t]))

export function getObjectTemplate(objectType: string): ObjectTemplate | undefined {
  return templateIndex.get(objectType)
}

export function listObjectTemplates(): ObjectTemplate[] {
  return [...mistManorObjectTemplates]
}
