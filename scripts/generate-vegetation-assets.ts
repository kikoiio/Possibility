import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ── 植被 GLB 生成(S2a T7 改造)──────────────────
// 只产 GLB 到 out/voxel-assets/,登记统一走 scripts/asset-import.ts(不再自写 manifest)。
// 几何与 4 个 id 保持不变;accessor min/max 改为按实际顶点计算
// (旧版硬编码 [-1,-1,-1]/[1,2,1],会让入库脚本的包围盒相容校验误判)。

export type AssetSpec = { assetId: string; color: [number, number, number, number]; shape: 'tree' | 'flower' | 'grass' | 'bush' }
const ASSETS: AssetSpec[] = [
  { assetId: 'veg-tree-a', color: [0.18, 0.42, 0.16, 1], shape: 'tree' },
  { assetId: 'veg-flower-a', color: [0.82, 0.28, 0.42, 1], shape: 'flower' },
  { assetId: 'veg-grass-a', color: [0.32, 0.62, 0.18, 1], shape: 'grass' },
  { assetId: 'veg-bush-a', color: [0.12, 0.34, 0.12, 1], shape: 'bush' },
]

function pad4(n: number): number { return (n + 3) & ~3 }

export function buildBoxGlb(spec: AssetSpec, addShape: (addBox: (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) => void) => void): Buffer {
  const positions: number[] = [], indices: number[] = []
  const addBox = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) => {
    const base = positions.length / 3
    for (const [x, y, z] of [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]) positions.push(cx + x * sx, cy + y * sy, cz + z * sz)
    for (const f of [[0, 1, 2, 0, 2, 3], [4, 6, 5, 4, 7, 6], [0, 4, 5, 0, 5, 1], [3, 2, 6, 3, 6, 7], [1, 5, 6, 1, 6, 2], [0, 3, 7, 0, 7, 4]]) for (const i of f) indices.push(base + i)
  }
  addShape(addBox)
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i++) {
    const axis = i % 3
    min[axis] = Math.min(min[axis], positions[i])
    max[axis] = Math.max(max[axis], positions[i])
  }
  const pos = Buffer.alloc(positions.length * 4); positions.forEach((v, i) => pos.writeFloatLE(v, i * 4))
  const idx = Buffer.alloc(indices.length * 2); indices.forEach((v, i) => idx.writeUInt16LE(v, i * 2))
  const bin = Buffer.concat([pos, idx])
  const json = JSON.stringify({ asset: { version: '2.0', generator: 'possibility-asset-generator' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: spec.color, metallicFactor: 0, roughnessFactor: 1 } }], accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max }, { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length, target: 34962 }, { buffer: 0, byteOffset: pos.length, byteLength: idx.length, target: 34963 }], buffers: [{ byteLength: bin.length }] })
  const j = Buffer.from(json), jp = Buffer.alloc(pad4(j.length), 0x20); j.copy(jp)
  const bp = Buffer.alloc(pad4(bin.length)); bin.copy(bp)
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jp.length + 8 + bp.length, 8)
  const jc = Buffer.alloc(8); jc.writeUInt32LE(jp.length, 0); jc.writeUInt32LE(0x4e4f534a, 4)
  const bc = Buffer.alloc(8); bc.writeUInt32LE(bp.length, 0); bc.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jc, jp, bc, bp])
}

const SHAPES: Record<AssetSpec['shape'], (addBox: (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) => void) => void> = {
  tree: (addBox) => { addBox(0, 0.55, 0, 0.12, 0.55, 0.12); addBox(0, 1.3, 0, 0.62, 0.62, 0.62) },
  flower: (addBox) => { addBox(0, 0.35, 0, 0.035, 0.35, 0.035); addBox(0, 0.72, 0, 0.16, 0.06, 0.16) },
  grass: (addBox) => { addBox(0, 0.28, 0, 0.22, 0.28, 0.08); addBox(0, 0.35, 0, 0.08, 0.35, 0.22) },
  bush: (addBox) => { addBox(0, 0.45, 0, 0.6, 0.45, 0.6) },
}

const dir = resolve('out/voxel-assets')
mkdirSync(dir, { recursive: true })
for (const spec of ASSETS) writeFileSync(resolve(dir, `${spec.assetId}.glb`), buildBoxGlb(spec, SHAPES[spec.shape]))
console.log(`[vegetation] generated ${ASSETS.length} deterministic GLBs → ${dir}`)
