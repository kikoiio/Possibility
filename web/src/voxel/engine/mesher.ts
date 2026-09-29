import {
  parseSectionKey, SECTION_SIZE,
  type BlockRegistry, type SectionKey,
} from '@possibility/voxel-contract'
import type { TextureAtlas } from './atlas'
import type { LightingEngine } from './lighting'
import type { WorldModel } from './world-model'

export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  colors: Float32Array
  /** 顶点摇摆权重（植被摇摆着色器用；底角 0、顶角 1） */
  sway: Float32Array
  /** 流体标记（水面 UV 扰动着色器用） */
  water: Float32Array
  indices: Uint32Array
  faceCount: number
}

/** 参与植被摇摆的方块 */
const SWAY_BLOCKS = new Set(['leaves', 'flower', 'bush'])

export interface SectionGeometry {
  key: SectionKey
  opaque: MeshData
  translucent: MeshData
}

/** 面朝向 → 烘焙明暗系数（昼夜方向光由此进入顶点色） */
export interface BakeEnvironment {
  faceShade: { px: number; nx: number; py: number; ny: number; pz: number; nz: number }
  skyTint: [number, number, number]
  blockTint: [number, number, number]
}

export const DEFAULT_BAKE_ENV: BakeEnvironment = {
  faceShade: { px: 0.82, nx: 0.78, py: 1.0, ny: 0.5, pz: 0.86, nz: 0.72 },
  skyTint: [1, 1, 1],
  blockTint: [1, 0.82, 0.55],
}

type FaceDir = keyof BakeEnvironment['faceShade']

// 经典体素面表（CCW 正面朝外），与索引 (0,1,2, 2,1,3) 配套
const FACES: Array<{ dir: FaceDir; offset: [number, number, number]; corners: Array<[number, number, number]> }> = [
  { dir: 'nx', offset: [-1, 0, 0], corners: [[0, 1, 0], [0, 0, 0], [0, 1, 1], [0, 0, 1]] },
  { dir: 'px', offset: [1, 0, 0], corners: [[1, 1, 1], [1, 0, 1], [1, 1, 0], [1, 0, 0]] },
  { dir: 'ny', offset: [0, -1, 0], corners: [[1, 0, 1], [0, 0, 1], [1, 0, 0], [0, 0, 0]] },
  { dir: 'py', offset: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [0, 1, 0], [1, 1, 0]] },
  { dir: 'nz', offset: [0, 0, -1], corners: [[1, 1, 0], [0, 1, 0], [1, 0, 0], [0, 0, 0]] },
  { dir: 'pz', offset: [0, 0, 1], corners: [[0, 1, 1], [1, 1, 1], [0, 0, 1], [1, 0, 1]] },
]

const FACE_UVS: Array<[number, number]> = [[0, 1], [0, 0], [1, 1], [1, 0]]

function emptyMesh(): MeshData {
  return {
    positions: new Float32Array(0), normals: new Float32Array(0), uvs: new Float32Array(0),
    colors: new Float32Array(0), sway: new Float32Array(0), water: new Float32Array(0),
    indices: new Uint32Array(0), faceCount: 0,
  }
}

class MeshBuilder {
  positions: number[] = []
  normals: number[] = []
  uvs: number[] = []
  colors: number[] = []
  sway: number[] = []
  water: number[] = []
  indices: number[] = []
  faceCount = 0

  build(): MeshData {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      colors: new Float32Array(this.colors),
      sway: new Float32Array(this.sway),
      water: new Float32Array(this.water),
      indices: new Uint32Array(this.indices),
      faceCount: this.faceCount,
    }
  }
}

/** 把一个节烘焙成几何：六邻居面剔除，顶/侧/底面分别取纹理，光照写入顶点色 */
export class Mesher {
  constructor(
    private world: WorldModel,
    private registry: BlockRegistry,
    private atlas: TextureAtlas,
    private lighting: LightingEngine,
  ) {}

  bakeSection(key: SectionKey, env: BakeEnvironment = DEFAULT_BAKE_ENV): SectionGeometry {
    const section = this.world.doc.sections[key]
    if (!section || section.nonAirCount === 0) return { key, opaque: emptyMesh(), translucent: emptyMesh() }

    const { cx, cy, cz } = parseSectionKey(key)
    const bx = cx * SECTION_SIZE, by = cy * SECTION_SIZE, bz = cz * SECTION_SIZE
    const opaque = new MeshBuilder()
    const translucent = new MeshBuilder()

    for (let ly = 0; ly < SECTION_SIZE; ly++) {
      for (let lz = 0; lz < SECTION_SIZE; lz++) {
        for (let lx = 0; lx < SECTION_SIZE; lx++) {
          const x = bx + lx, y = by + ly, z = bz + lz
          const blockId = this.world.getBlock({ x, y, z })
          if (blockId === 'air') continue
          const type = this.registry.get(blockId)
          if (!type) continue

          for (const face of FACES) {
            const nx = x + face.offset[0], ny = y + face.offset[1], nz = z + face.offset[2]
            const neighborId = this.world.getBlock({ x: nx, y: ny, z: nz })
            const neighbor = this.registry.get(neighborId)
            if (neighbor) {
              if (neighborId === blockId) continue // 同类相邻（水-水内部面）
              if (neighbor.solid && !neighbor.translucent) continue // 被不透明邻居挡住
            }

            const frame = face.dir === 'py' ? type.textures.top
              : face.dir === 'ny' ? (type.textures.bottom ?? type.textures.side)
              : type.textures.side
            const uv = this.atlas.uv(frame)
            const lightAt = { x: nx, y: ny, z: nz }
            const sky01 = this.lighting.getSky(lightAt) / 15
            const block01 = this.lighting.getBlockLight(lightAt) / 15
            const shade = env.faceShade[face.dir]
            const r = shade * Math.min(1, sky01 * env.skyTint[0] + block01 * env.blockTint[0])
            const g = shade * Math.min(1, sky01 * env.skyTint[1] + block01 * env.blockTint[1])
            const b = shade * Math.min(1, sky01 * env.skyTint[2] + block01 * env.blockTint[2])

            const target = type.translucent ? translucent : opaque
            const base = target.positions.length / 3
            const swaying = SWAY_BLOCKS.has(blockId)
            const fluid = type.category === 'fluid'
            for (let c = 0; c < 4; c++) {
              const corner = face.corners[c]
              target.positions.push(x + corner[0], y + corner[1], z + corner[2])
              target.normals.push(face.offset[0], face.offset[1], face.offset[2])
              target.uvs.push(
                FACE_UVS[c][0] === 0 ? uv.u0 : uv.u1,
                FACE_UVS[c][1] === 0 ? uv.v0 : uv.v1,
              )
              target.colors.push(r, g, b)
              target.sway.push(swaying ? corner[1] : 0)
              target.water.push(fluid ? 1 : 0)
            }
            target.indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3)
            target.faceCount += 1
          }
        }
      }
    }
    return { key, opaque: opaque.build(), translucent: translucent.build() }
  }

  bakeAll(env: BakeEnvironment = DEFAULT_BAKE_ENV): SectionGeometry[] {
    return Object.keys(this.world.doc.sections).map((key) => this.bakeSection(key, env))
  }
}
