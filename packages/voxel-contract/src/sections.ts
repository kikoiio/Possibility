import type { ChunkSection, SectionKey, VoxelCoord, VoxelDocument, VoxelSize } from './types'

export const SECTION_SIZE = 16
export const SECTION_VOLUME = SECTION_SIZE * SECTION_SIZE * SECTION_SIZE // 4096
export const AIR = 'air'

// ── 节键编解码 ────────────────────────────────
export function keyOfSection(cx: number, cy: number, cz: number): SectionKey {
  return `${cx},${cy},${cz}`
}

export function parseSectionKey(key: SectionKey): { cx: number; cy: number; cz: number } {
  const [cx, cy, cz] = key.split(',').map(Number)
  return { cx, cy, cz }
}

// ── 坐标 → 节 / 节内索引换算 ──────────────────
export function sectionCoordOf(at: VoxelCoord): { cx: number; cy: number; cz: number } {
  return {
    cx: Math.floor(at.x / SECTION_SIZE),
    cy: Math.floor(at.y / SECTION_SIZE),
    cz: Math.floor(at.z / SECTION_SIZE),
  }
}

export function sectionKeyOf(at: VoxelCoord): SectionKey {
  const { cx, cy, cz } = sectionCoordOf(at)
  return keyOfSection(cx, cy, cz)
}

/** 节内局部坐标（0..15） */
export function localCoordOf(at: VoxelCoord): VoxelCoord {
  return {
    x: ((at.x % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE,
    y: ((at.y % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE,
    z: ((at.z % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE,
  }
}

/** 节内索引：y 主序（4096 个调色板索引） */
export function localIndex(lx: number, ly: number, lz: number): number {
  return ly * SECTION_SIZE * SECTION_SIZE + lz * SECTION_SIZE + lx
}

export function localIndexOf(at: VoxelCoord): number {
  const { x, y, z } = localCoordOf(at)
  return localIndex(x, y, z)
}

// ── 节创建与克隆 ──────────────────────────────
export function createSection(): ChunkSection {
  return { palette: [AIR], indices: new Uint16Array(SECTION_VOLUME), nonAirCount: 0 }
}

export function cloneSection(section: ChunkSection): ChunkSection {
  return { palette: [...section.palette], indices: new Uint16Array(section.indices), nonAirCount: section.nonAirCount }
}

// ── 节内读写：调色板去重、索引写入、nonAirCount 维护 ──
export function getBlockInSection(section: ChunkSection, index: number): string {
  return section.palette[section.indices[index]] ?? AIR
}

/** 返回调色板索引；不存在则追加 */
function paletteIndex(section: ChunkSection, block: string): number {
  const existing = section.palette.indexOf(block)
  if (existing >= 0) return existing
  section.palette.push(block)
  return section.palette.length - 1
}

export function setBlockInSection(section: ChunkSection, index: number, block: string): void {
  const before = getBlockInSection(section, index)
  if (before === block) return
  const wasAir = before === AIR
  const isAir = block === AIR
  section.indices[index] = paletteIndex(section, block)
  if (wasAir && !isAir) section.nonAirCount += 1
  else if (!wasAir && isAir) section.nonAirCount -= 1
}

// ── 边界与尺寸 ────────────────────────────────
export function inBounds(size: VoxelSize, at: VoxelCoord): boolean {
  return at.x >= 0 && at.x < size.width
      && at.y >= 0 && at.y < size.height
      && at.z >= 0 && at.z < size.depth
}

export function createEmptyWorld(size: VoxelSize, theme: string, id = 'world'): VoxelDocument {
  return {
    version: 1, id, theme, size,
    sections: {}, objects: [], objectCells: [],
    locations: [], spaceEntries: [], lockedObjectIds: [],
  }
}

// ── 世界级读取：越界返回 'air' ────────────────
export function getBlock(doc: VoxelDocument, at: VoxelCoord): string {
  if (!inBounds(doc.size, at)) return AIR
  const section = doc.sections[sectionKeyOf(at)]
  if (!section) return AIR
  return getBlockInSection(section, localIndexOf(at))
}

/**
 * 世界级写入（就地修改，供 applyEdits 内部使用）。
 * 返回受影响节键集合：目标节本身；若格子在节边界上，
 * 邻接节的面剔除、AO 角点与采样光照可能变化，一并返回（F4）。
 *
 * 边界轴按笛卡尔积展开，而不是只返回面邻居：一个节边界角点的
 * AO 样本可以同时落在相邻 x/y/z 节，因此还需要通知边、角邻居。
 */
export function setBlockMut(doc: VoxelDocument, at: VoxelCoord, block: string): SectionKey[] {
  if (!inBounds(doc.size, at)) return []
  const key = sectionKeyOf(at)
  let section = doc.sections[key]
  if (!section) {
    if (block === AIR) return []
    section = createSection()
    doc.sections[key] = section
  }
  setBlockInSection(section, localIndexOf(at), block)
  if (section.nonAirCount === 0) delete doc.sections[key]

  const affected = new Set<SectionKey>([key])
  const { cx, cy, cz } = sectionCoordOf(at)
  const local = localCoordOf(at)
  const axisOffsets = (coordinate: number, size: number): number[] => {
    if (coordinate === 0) return [-1, 0]
    if (coordinate === size - 1) return [0, 1]
    return [0]
  }
  const xOffsets = axisOffsets(local.x, SECTION_SIZE)
  const yOffsets = axisOffsets(local.y, SECTION_SIZE)
  const zOffsets = axisOffsets(local.z, SECTION_SIZE)
  for (const dx of xOffsets) {
    for (const dy of yOffsets) {
      for (const dz of zOffsets) {
        if (dx === 0 && dy === 0 && dz === 0) continue
        const nx = at.x + dx, ny = at.y + dy, nz = at.z + dz
        if (nx < 0 || nx >= doc.size.width || ny < 0 || ny >= doc.size.height || nz < 0 || nz >= doc.size.depth) continue
        affected.add(keyOfSection(cx + dx, cy + dy, cz + dz))
      }
    }
  }
  return [...affected]
}
