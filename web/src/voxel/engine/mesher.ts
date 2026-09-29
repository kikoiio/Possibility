import {
  parseSectionKey, SECTION_SIZE,
  type BlockRegistry, type SectionKey,
} from '@possibility/voxel-contract'
import { DEFAULT_BAKE_ENV } from './palettes/mist-manor'
import type { TextureAtlas } from './atlas'
import type { LightingEngine } from './lighting'
import type { WorldModel } from './world-model'

export { DEFAULT_BAKE_ENV }

export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  colors: Float32Array
  /** 顶点摇摆权重（植被摇摆着色器用；底角 0、顶角 1） */
  sway: Float32Array
  /** 流体标记（水面 UV 扰动着色器用） */
  water: Float32Array
  /** 岸边白沫标记（0/1：仅流体顶面且水平邻接非流体格） */
  foam: Float32Array
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

/** 逐顶点 AO 参数：4 档遮蔽亮度曲线 + 强度（缺省关闭，行为与旧版一致） */
export interface AoParams {
  curve: [number, number, number, number]
  strength: number
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

/** 每个面的两个切向轴（法向轴之外的两个，按 xyz 顺序），AO 采样用 */
const FACE_TANGENTS: Array<[number, number]> = FACES.map((face) => {
  const normalAxis = face.offset.findIndex((v) => v !== 0)
  const tangents = [0, 1, 2].filter((a) => a !== normalAxis)
  return [tangents[0], tangents[1]]
})

function emptyMesh(): MeshData {
  return {
    positions: new Float32Array(0), normals: new Float32Array(0), uvs: new Float32Array(0),
    colors: new Float32Array(0), sway: new Float32Array(0), water: new Float32Array(0),
    foam: new Float32Array(0),
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
  foam: number[] = []
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
      foam: new Float32Array(this.foam),
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

  bakeSection(key: SectionKey, env: BakeEnvironment = DEFAULT_BAKE_ENV, ao?: AoParams): SectionGeometry {
    const section = this.world.doc.sections[key]
    if (!section || section.nonAirCount === 0) return { key, opaque: emptyMesh(), translucent: emptyMesh() }

    const { cx, cy, cz } = parseSectionKey(key)
    const bx = cx * SECTION_SIZE, by = cy * SECTION_SIZE, bz = cz * SECTION_SIZE
    const opaque = new MeshBuilder()
    const translucent = new MeshBuilder()
    const aoEnabled = !!ao && ao.strength > 0

    /** 不透明实体才算遮蔽样本 */
    const occupied = (x: number, y: number, z: number): boolean => {
      const t = this.registry.get(this.world.getBlock({ x, y, z }))
      return !!t && t.solid && !t.translucent
    }

    for (let ly = 0; ly < SECTION_SIZE; ly++) {
      for (let lz = 0; lz < SECTION_SIZE; lz++) {
        for (let lx = 0; lx < SECTION_SIZE; lx++) {
          const x = bx + lx, y = by + ly, z = bz + lz
          const blockId = this.world.getBlock({ x, y, z })
          if (blockId === 'air') continue
          const type = this.registry.get(blockId)
          if (!type) continue

          for (let f = 0; f < FACES.length; f++) {
            const face = FACES[f]
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
            // 界外邻格视为全开天空:世界边缘侧面/顶面不再烤成黑色
            const sky01 = (this.world.inBounds(lightAt) ? this.lighting.getSky(lightAt) : this.lighting.getSkyLevel()) / 15
            const block01 = this.lighting.getBlockLight(lightAt) / 15
            const shade = env.faceShade[face.dir]
            const lightR = Math.min(1, sky01 * env.skyTint[0] + block01 * env.blockTint[0])
            const lightG = Math.min(1, sky01 * env.skyTint[1] + block01 * env.blockTint[1])
            const lightB = Math.min(1, sky01 * env.skyTint[2] + block01 * env.blockTint[2])

            // 逐顶点 AO：每角在邻居格切平面上取两个邻边 + 一个对角样本（读全局坐标，节边界天然正确）
            const aoFactors = [1, 1, 1, 1]
            if (aoEnabled && ao) {
              const [t1, t2] = FACE_TANGENTS[f]
              for (let c = 0; c < 4; c++) {
                const corner = face.corners[c]
                const s1 = corner[t1] === 1 ? 1 : -1
                const s2 = corner[t2] === 1 ? 1 : -1
                const d1: [number, number, number] = [0, 0, 0]
                const d2: [number, number, number] = [0, 0, 0]
                d1[t1] = s1
                d2[t2] = s2
                const side1 = occupied(nx + d1[0], ny + d1[1], nz + d1[2]) ? 1 : 0
                const side2 = occupied(nx + d2[0], ny + d2[1], nz + d2[2]) ? 1 : 0
                const cornerOcc = occupied(nx + d1[0] + d2[0], ny + d1[1] + d2[1], nz + d1[2] + d2[2]) ? 1 : 0
                const level = side1 && side2 ? 0 : 3 - (side1 + side2 + cornerOcc)
                aoFactors[c] = 1 + (ao.curve[level] - 1) * ao.strength
              }
            }

            const target = type.translucent ? translucent : opaque
            const base = target.positions.length / 3
            const swaying = SWAY_BLOCKS.has(blockId)
            const fluid = type.category === 'fluid'
            // 下沉水面（S3a MC 式）：流体顶面角点 y 压到 0.875，与岸边侧面自然衔接
            const sinkTop = fluid && face.dir === 'py'
            // 白沫标记：水格顶面且水平四邻存在非流体格（岸边/桥墩/水缘）；开阔水面天然为 0
            let foam = 0
            if (sinkTop) {
              for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
                const nb = this.registry.get(this.world.getBlock({ x: x + dx, y, z: z + dz }))
                if (!nb || nb.category !== 'fluid') { foam = 1; break }
              }
            }
            for (let c = 0; c < 4; c++) {
              const corner = face.corners[c]
              const aoF = aoFactors[c]
              target.positions.push(x + corner[0], y + (sinkTop ? corner[1] * 0.875 : corner[1]), z + corner[2])
              target.normals.push(face.offset[0], face.offset[1], face.offset[2])
              target.uvs.push(
                FACE_UVS[c][0] === 0 ? uv.u0 : uv.u1,
                FACE_UVS[c][1] === 0 ? uv.v0 : uv.v1,
              )
              target.colors.push(shade * aoF * lightR, shade * aoF * lightG, shade * aoF * lightB)
              target.sway.push(swaying ? corner[1] : 0)
              target.water.push(fluid ? 1 : 0)
              target.foam.push(foam)
            }
            target.indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3)
            target.faceCount += 1
          }
        }
      }
    }
    return { key, opaque: opaque.build(), translucent: translucent.build() }
  }

  bakeAll(env: BakeEnvironment = DEFAULT_BAKE_ENV, ao?: AoParams): SectionGeometry[] {
    return Object.keys(this.world.doc.sections).map((key) => this.bakeSection(key, env, ao))
  }
}
