// ── GLB 轻量解析器(S2a 模块 B)──────────────────
// 只读 GLB 二进制头 + JSON chunk,统计三角形/材质/包围盒,
// 不引入 three.js Node 端。解析失败即抛错——天然覆盖"损坏 GLB"负例。
// 局限:bounds 不含节点变换(本仓库资产生成器产扁平场景,外部资产入库时按容差放行)。

import { readFileSync } from 'node:fs'

export interface GlbReport {
  triangles: number // Σ primitives indices.count/3(无 indices 按 POSITION.count/3)
  materials: number // JSON materials 数组长度
  bounds: { size: [number, number, number] } // 全体 POSITION accessor min/max 合成
}

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a

interface GltfAccessor { count?: number; min?: number[]; max?: number[] }
interface GltfPrimitive { attributes?: Record<string, number>; indices?: number }
interface GltfJson {
  meshes?: { primitives?: GltfPrimitive[] }[]
  materials?: unknown[]
  accessors?: GltfAccessor[]
}

function fail(reason: string): never {
  throw new Error(`GLB 解析失败:${reason}`)
}

export function inspectGlb(filePath: string): GlbReport {
  const buf = readFileSync(filePath)
  // 用 DataView/TextDecoder 而非 Buffer 方法:api tsconfig 同时引入 workers-types,
  // Buffer 的具体类型签名在其下解析不稳定
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const u32 = (offset: number) => view.getUint32(offset, true)
  if (buf.length < 20) fail(`文件过小(${buf.length} 字节)`)
  if (u32(0) !== GLB_MAGIC) fail('magic 不是 GLB')
  if (u32(4) !== 2) fail(`glTF 版本应为 2,实际 ${u32(4)}`)
  const declared = u32(8)
  if (declared !== buf.length) fail(`声明长度 ${declared} 与实际 ${buf.length} 不符(文件可能截断)`)

  const jsonLen = u32(12)
  if (u32(16) !== CHUNK_JSON) fail('首个 chunk 不是 JSON')
  if (20 + jsonLen > buf.length) fail('JSON chunk 越界(文件可能截断)')
  let json: GltfJson
  try {
    // JSON chunk 按规范以空格补齐,宽容起见同时剥掉 NUL
    const text = new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)).replace(/[\0 ]+$/, '')
    json = JSON.parse(text) as GltfJson
  } catch {
    fail('JSON chunk 不是合法 JSON')
  }

  const accessors = json.accessors ?? []
  const accessor = (i: number, what: string): GltfAccessor => {
    const a = accessors[i]
    if (!a || typeof a.count !== 'number') fail(`${what} 引用的 accessor[${i}] 缺失或缺 count`)
    return a
  }

  let triangles = 0
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  let sawPrimitive = false
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      sawPrimitive = true
      const posIndex = prim.attributes?.POSITION
      if (posIndex === undefined) fail('primitive 缺 POSITION 属性')
      const pos = accessor(posIndex, 'POSITION')
      triangles += Math.floor(
        (prim.indices !== undefined ? accessor(prim.indices, 'indices').count! : pos.count!) / 3,
      )
      if (Array.isArray(pos.min) && Array.isArray(pos.max) && pos.min.length === 3 && pos.max.length === 3) {
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], pos.min[axis]!)
          max[axis] = Math.max(max[axis], pos.max[axis]!)
        }
      }
    }
  }
  if (!sawPrimitive) fail('没有任何 mesh primitive')

  const size: [number, number, number] = [0, 0, 0]
  for (let axis = 0; axis < 3; axis++) {
    size[axis] = Number.isFinite(min[axis]) && Number.isFinite(max[axis]) ? max[axis] - min[axis] : 0
  }

  return { triangles, materials: (json.materials ?? []).length, bounds: { size } }
}
