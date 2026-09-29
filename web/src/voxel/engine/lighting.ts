import {
  parseSectionKey, SECTION_SIZE,
  type BlockRegistry, type SectionKey, type VoxelCoord,
} from '@possibility/voxel-contract'
import type { WorldModel } from './world-model'

export interface LightVolume {
  key: SectionKey
  sky: Uint8Array
  block: Uint8Array
  /** 光照变化波及的全部节（含邻节），调用方据此重烘焙 */
  affectedSections: SectionKey[]
}

interface Region { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }

const NEIGHBORS = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]] as const

/** 泛洪光照：天空光自顶向下 + 方块光扩散，两通道各 0–15 */
export class LightingEngine {
  private sky: Uint8Array
  private block: Uint8Array
  private skyLevel = 15
  /**
   * 衰减缓存：0=不透明（光不穿过），1=空气，2=半透明。
   * 每次 computeAll/computeSection 前按区域构建一次，BFS 内层零函数调用（N2）。
   * y 方向始终缓存到世界顶部（天空光垂直 pass 需要）。
   */
  private attenCache = new Uint8Array(0)
  private attenRegion: Region = { x0: 0, y0: 0, z0: 0, x1: -1, y1: -1, z1: -1 }

  constructor(private world: WorldModel, private registry: BlockRegistry) {
    const { width, height, depth } = world.doc.size
    this.sky = new Uint8Array(width * height * depth)
    this.block = new Uint8Array(width * height * depth)
  }

  getSkyLevel(): number {
    return this.skyLevel
  }

  /** 昼夜驱动：全局天空光等级变化后整体重算 */
  setSkyLevel(level: number): void {
    this.skyLevel = Math.max(0, Math.min(15, Math.round(level)))
    this.computeAll()
  }

  private index(x: number, y: number, z: number): number {
    const { width, depth } = this.world.doc.size
    return (y * depth + z) * width + x
  }

  getSky(at: VoxelCoord): number {
    if (!this.world.inBounds(at)) return 0
    return this.sky[this.index(at.x, at.y, at.z)]
  }

  getBlockLight(at: VoxelCoord): number {
    if (!this.world.inBounds(at)) return 0
    return this.block[this.index(at.x, at.y, at.z)]
  }

  /** 构建区域衰减缓存（y 到世界顶，供天空光垂直 pass） */
  private buildAttenCache(region: Region): void {
    const { height } = this.world.doc.size
    const cached: Region = { ...region, y1: height - 1 }
    const xd = cached.x1 - cached.x0 + 1
    const yd = cached.y1 - cached.y0 + 1
    const zd = cached.z1 - cached.z0 + 1
    if (this.attenCache.length < xd * yd * zd) this.attenCache = new Uint8Array(xd * yd * zd)
    for (let y = cached.y0; y <= cached.y1; y++) {
      for (let z = cached.z0; z <= cached.z1; z++) {
        for (let x = cached.x0; x <= cached.x1; x++) {
          const type = this.registry.get(this.world.getBlock({ x, y, z }))
          this.attenCache[((y - cached.y0) * zd + (z - cached.z0)) * xd + (x - cached.x0)] =
            !type ? 1 : type.solid && !type.translucent ? 0 : type.translucent ? 2 : 1
        }
      }
    }
    this.attenRegion = cached
  }

  /** 缓存衰减值；调用方保证坐标在 buildAttenCache 的覆盖范围内 */
  private attenAt(x: number, y: number, z: number): number {
    const r = this.attenRegion
    const xd = r.x1 - r.x0 + 1
    const zd = r.z1 - r.z0 + 1
    return this.attenCache[((y - r.y0) * zd + (z - r.z0)) * xd + (x - r.x0)]
  }

  /** 全量重算（加载 / 天空光等级变化） */
  computeAll(): void {
    this.sky.fill(0)
    this.block.fill(0)
    const { width, height, depth } = this.world.doc.size
    const region: Region = { x0: 0, y0: 0, z0: 0, x1: width - 1, y1: height - 1, z1: depth - 1 }
    this.buildAttenCache(region)
    this.verticalSkyPass(region)
    this.collectBlockSources(region)
    this.floodChannel(this.sky, region)
    this.floodChannel(this.block, region)
  }

  /** 局部重算：节变更时只重算该节外扩 15 格的区域（光的最大传播距离） */
  computeSection(key: SectionKey): LightVolume {
    const { cx, cy, cz } = parseSectionKey(key)
    const { width, height, depth } = this.world.doc.size
    const region: Region = {
      x0: Math.max(0, cx * SECTION_SIZE - 15),
      y0: Math.max(0, cy * SECTION_SIZE - 15),
      z0: Math.max(0, cz * SECTION_SIZE - 15),
      x1: Math.min(width - 1, (cx + 1) * SECTION_SIZE - 1 + 15),
      y1: Math.min(height - 1, (cy + 1) * SECTION_SIZE - 1 + 15),
      z1: Math.min(depth - 1, (cz + 1) * SECTION_SIZE - 1 + 15),
    }
    const xd = region.x1 - region.x0 + 1
    const yd = region.y1 - region.y0 + 1
    const zd = region.z1 - region.z0 + 1
    this.buildAttenCache(region)
    // 快照旧光照：事后 diff 出真正受波及的节，避免盲目重烘焙整个外扩区（N2）
    const size = xd * yd * zd
    const skyBefore = new Uint8Array(size)
    const blockBefore = new Uint8Array(size)
    const snap = (x: number, y: number, z: number) => ((y - region.y0) * zd + (z - region.z0)) * xd + (x - region.x0)
    for (let y = region.y0; y <= region.y1; y++) {
      for (let z = region.z0; z <= region.z1; z++) {
        for (let x = region.x0; x <= region.x1; x++) {
          const i = this.index(x, y, z)
          const s = snap(x, y, z)
          skyBefore[s] = this.sky[i]
          blockBefore[s] = this.block[i]
          this.sky[i] = 0
          this.block[i] = 0
        }
      }
    }
    this.verticalSkyPass(region)
    this.collectBlockSources(region)
    this.seedFromOutside(this.sky, region)
    this.seedFromOutside(this.block, region)
    this.floodChannel(this.sky, region)
    this.floodChannel(this.block, region)

    // 只有光照实际变化的节才需要重烘焙（编辑节本身几何已变，恒在列）
    const affected = new Set<SectionKey>([key])
    for (let y = region.y0; y <= region.y1; y++) {
      for (let z = region.z0; z <= region.z1; z++) {
        for (let x = region.x0; x <= region.x1; x++) {
          const s = snap(x, y, z)
          const i = this.index(x, y, z)
          if (this.sky[i] === skyBefore[s] && this.block[i] === blockBefore[s]) continue
          // 变化格及其面邻格所在的节：跨节边界的面光照采样也要覆盖
          for (const [dx, dy, dz] of [[0, 0, 0], ...NEIGHBORS]) {
            const nx = x + dx, ny = y + dy, nz = z + dz
            if (nx < 0 || ny < 0 || nz < 0 || nx >= width || ny >= height || nz >= depth) continue
            affected.add(`${Math.floor(nx / SECTION_SIZE)},${Math.floor(ny / SECTION_SIZE)},${Math.floor(nz / SECTION_SIZE)}`)
          }
        }
      }
    }
    return { key, sky: this.extract(key, this.sky), block: this.extract(key, this.block), affectedSections: [...affected] }
  }

  private extract(key: SectionKey, channel: Uint8Array): Uint8Array {
    const { cx, cy, cz } = parseSectionKey(key)
    const out = new Uint8Array(SECTION_SIZE * SECTION_SIZE * SECTION_SIZE)
    for (let ly = 0; ly < SECTION_SIZE; ly++) {
      for (let lz = 0; lz < SECTION_SIZE; lz++) {
        for (let lx = 0; lx < SECTION_SIZE; lx++) {
          out[ly * 256 + lz * 16 + lx] = channel[this.index(cx * 16 + lx, cy * 16 + ly, cz * 16 + lz)]
        }
      }
    }
    return out
  }

  /** 区域内逐列垂直天空光：从世界顶部向下，直到不透明方块 */
  private verticalSkyPass(region: Region): void {
    const { height } = this.world.doc.size
    for (let z = region.z0; z <= region.z1; z++) {
      for (let x = region.x0; x <= region.x1; x++) {
        for (let y = height - 1; y >= region.y0; y--) {
          if (this.attenAt(x, y, z) === 0) break
          this.sky[this.index(x, y, z)] = this.skyLevel
        }
      }
    }
  }

  /** 区域内发光方块写入方块光通道 */
  private collectBlockSources(region: Region): void {
    for (let y = region.y0; y <= region.y1; y++) {
      for (let z = region.z0; z <= region.z1; z++) {
        for (let x = region.x0; x <= region.x1; x++) {
          const emits = this.registry.get(this.world.getBlock({ x, y, z }))?.emitsLight ?? 0
          if (emits > 0) this.block[this.index(x, y, z)] = Math.max(this.block[this.index(x, y, z)], emits)
        }
      }
    }
  }

  /** 区域外紧贴边界的光照值向区域内播种（局部重算的边界条件） */
  private seedFromOutside(channel: Uint8Array, region: Region): void {
    const { width, height, depth } = this.world.doc.size
    const inside = (x: number, y: number, z: number) =>
      x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1 && z >= region.z0 && z <= region.z1
    for (let y = region.y0; y <= region.y1; y++) {
      for (let z = region.z0; z <= region.z1; z++) {
        for (let x = region.x0; x <= region.x1; x++) {
          if (x !== region.x0 && x !== region.x1 && y !== region.y0 && y !== region.y1 && z !== region.z0 && z !== region.z1) continue
          const atten = this.attenAt(x, y, z)
          if (atten === 0) continue
          let best = channel[this.index(x, y, z)]
          for (const [dx, dy, dz] of NEIGHBORS) {
            const nx = x + dx, ny = y + dy, nz = z + dz
            if (nx < 0 || ny < 0 || nz < 0 || nx >= width || ny >= height || nz >= depth) continue
            if (inside(nx, ny, nz)) continue
            const v = channel[this.index(nx, ny, nz)] - atten
            if (v > best) best = v
          }
          if (best > 0) channel[this.index(x, y, z)] = best
        }
      }
    }
  }

  /** BFS 泛洪：region 内所有已有光照的格作为源，只在 region 内传播 */
  private floodChannel(channel: Uint8Array, region: Region): void {
    const { width, height, depth } = this.world.doc.size
    const queue: number[] = []
    for (let y = region.y0; y <= region.y1; y++) {
      for (let z = region.z0; z <= region.z1; z++) {
        for (let x = region.x0; x <= region.x1; x++) {
          const i = this.index(x, y, z)
          if (channel[i] > 1) queue.push(i)
        }
      }
    }
    const inRegion = (x: number, y: number, z: number) =>
      x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1 && z >= region.z0 && z <= region.z1
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head]
      const value = channel[i]
      if (value <= 1) continue
      const x = i % width
      const z = ((i - x) / width) % depth
      const y = (i - x - z * width) / (width * depth)
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = x + dx, ny = y + dy, nz = z + dz
        if (nx < 0 || ny < 0 || nz < 0 || nx >= width || ny >= height || nz >= depth) continue
        if (!inRegion(nx, ny, nz)) continue
        const atten = this.attenAt(nx, ny, nz)
        if (atten === 0) continue
        const ni = this.index(nx, ny, nz)
        const v = value - atten
        if (v > channel[ni]) {
          channel[ni] = v
          queue.push(ni)
        }
      }
    }
  }
}
