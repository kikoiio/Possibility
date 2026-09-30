import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ── 示范建筑 GLB 生成(S2a 模块 G)────────────────
// bld-hut-a 小屋(footprint 2x2)与 bld-tower-a 塔楼(footprint 1x1),
// CoC 式粗比例剪影:敦实基座 + 夸张屋顶/垛口。多材质(每材质一个 primitive)。
// 产物到 out/voxel-assets/,登记走 scripts/asset-import.ts。

type Box = { cx: number; cy: number; cz: number; sx: number; sy: number; sz: number; mat: number }
type Color = [number, number, number, number]

function pad4(n: number): number { return (n + 3) & ~3 }

function buildMultiMatGlb(generator: string, materials: Color[], boxes: Box[]): Buffer {
  const positions: number[] = []
  const indicesByMat = new Map<number, number[]>()
  for (const b of boxes) {
    const base = positions.length / 3
    for (const [x, y, z] of [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]) positions.push(b.cx + x * b.sx, b.cy + y * b.sy, b.cz + z * b.sz)
    const list = indicesByMat.get(b.mat) ?? []
    for (const f of [[0, 1, 2, 0, 2, 3], [4, 6, 5, 4, 7, 6], [0, 4, 5, 0, 5, 1], [3, 2, 6, 3, 6, 7], [1, 5, 6, 1, 6, 2], [0, 3, 7, 0, 7, 4]]) for (const i of f) list.push(base + i)
    indicesByMat.set(b.mat, list)
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i++) {
    const axis = i % 3
    min[axis] = Math.min(min[axis], positions[i])
    max[axis] = Math.max(max[axis], positions[i])
  }

  // 布局:positions | 每材质一段 indices
  const pos = Buffer.alloc(positions.length * 4); positions.forEach((v, i) => pos.writeFloatLE(v, i * 4))
  const indexChunks: Buffer[] = []
  const primitives: object[] = []
  const accessors: object[] = [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max }]
  const bufferViews: object[] = [{ buffer: 0, byteOffset: 0, byteLength: pos.length, target: 34962 }]
  let offset = pos.length
  for (const mat of [...indicesByMat.keys()].sort((a, b) => a - b)) {
    const list = indicesByMat.get(mat)!
    const buf = Buffer.alloc(list.length * 2); list.forEach((v, i) => buf.writeUInt16LE(v, i * 2))
    const padded = Buffer.alloc(pad4(buf.length)); buf.copy(padded)
    accessors.push({ bufferView: bufferViews.length, componentType: 5123, count: list.length, type: 'SCALAR' })
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target: 34963 })
    primitives.push({ attributes: { POSITION: 0 }, indices: accessors.length - 1, material: mat })
    indexChunks.push(padded)
    offset += padded.length
  }
  const bin = Buffer.concat([pos, ...indexChunks])
  const json = JSON.stringify({
    asset: { version: '2.0', generator }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
    materials: materials.map((baseColorFactor) => ({ pbrMetallicRoughness: { baseColorFactor, metallicFactor: 0, roughnessFactor: 1 } })),
    accessors, bufferViews, buffers: [{ byteLength: bin.length }],
  })
  const j = Buffer.from(json), jp = Buffer.alloc(pad4(j.length), 0x20); j.copy(jp)
  const bp = Buffer.alloc(pad4(bin.length)); bin.copy(bp)
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jp.length + 8 + bp.length, 8)
  const jc = Buffer.alloc(8); jc.writeUInt32LE(jp.length, 0); jc.writeUInt32LE(0x4e4f534a, 4)
  const bc = Buffer.alloc(8); bc.writeUInt32LE(bp.length, 0); bc.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jc, jp, bc, bp])
}

// 材质:0 墙(奶油) 1 屋顶(陶土) 2 木(深棕) 3 石(灰)
const HUT_COLORS: Color[] = [
  [0.87, 0.78, 0.62, 1],
  [0.72, 0.28, 0.18, 1],
  [0.35, 0.22, 0.13, 1],
  [0.55, 0.55, 0.58, 1],
]
// 小屋:敦实墙身 + 三级阶梯大屋顶 + 门 + 窗
const HUT_BOXES: Box[] = [
  { cx: 0, cy: 0.5, cz: 0, sx: 0.8, sy: 0.5, sz: 0.8, mat: 0 },        // 墙身 1.6x1.6
  { cx: 0, cy: 1.12, cz: 0, sx: 0.95, sy: 0.14, sz: 0.95, mat: 1 },     // 屋檐外挑
  { cx: 0, cy: 1.34, cz: 0, sx: 0.62, sy: 0.14, sz: 0.62, mat: 1 },
  { cx: 0, cy: 1.56, cz: 0, sx: 0.32, sy: 0.14, sz: 0.32, mat: 1 },     // 屋顶尖
  { cx: 0, cy: 0.32, cz: 0.78, sx: 0.16, sy: 0.32, sz: 0.04, mat: 2 },  // 门(南面)
  { cx: -0.45, cy: 0.6, cz: 0.78, sx: 0.12, sy: 0.12, sz: 0.04, mat: 2 }, // 窗
  { cx: 0.45, cy: 0.6, cz: 0.78, sx: 0.12, sy: 0.12, sz: 0.04, mat: 2 },
]

const TOWER_COLORS: Color[] = [
  [0.62, 0.60, 0.58, 1],
  [0.30, 0.36, 0.52, 1],
  [0.35, 0.22, 0.13, 1],
  [0.45, 0.45, 0.48, 1],
]
// 塔楼:石基座 + 细长塔身 + 外挑垛口 + 尖顶 + 门 + 窗缝
const TOWER_BOXES: Box[] = [
  { cx: 0, cy: 0.25, cz: 0, sx: 0.48, sy: 0.25, sz: 0.48, mat: 3 },     // 基座
  { cx: 0, cy: 1.55, cz: 0, sx: 0.38, sy: 1.05, sz: 0.38, mat: 0 },     // 塔身
  { cx: 0, cy: 2.68, cz: 0, sx: 0.5, sy: 0.12, sz: 0.5, mat: 3 },       // 垛口外挑
  { cx: 0, cy: 2.92, cz: 0, sx: 0.34, sy: 0.12, sz: 0.34, mat: 1 },     // 顶盖
  { cx: 0, cy: 3.14, cz: 0, sx: 0.18, sy: 0.12, sz: 0.18, mat: 1 },     // 尖顶
  { cx: 0, cy: 0.3, cz: 0.45, sx: 0.12, sy: 0.28, sz: 0.05, mat: 2 },   // 门(南面)
  { cx: 0, cy: 1.9, cz: 0.4, sx: 0.06, sy: 0.16, sz: 0.03, mat: 2 },    // 窗缝
]

const dir = resolve('out/voxel-assets')
mkdirSync(dir, { recursive: true })
writeFileSync(resolve(dir, 'bld-hut-a.glb'), buildMultiMatGlb('possibility-building-generator', HUT_COLORS, HUT_BOXES))
writeFileSync(resolve(dir, 'bld-tower-a.glb'), buildMultiMatGlb('possibility-building-generator', TOWER_COLORS, TOWER_BOXES))
console.log('[building] generated 2 deterministic GLBs →', dir)
