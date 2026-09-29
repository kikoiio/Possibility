/**
 * T12 图集校验：web/public/voxel-assets/mist-manor/atlas.{json,png}
 * 与 packages/voxel-contract 的 mist-manor 方块注册表一一对应。
 * 用法：`node --import tsx scripts/validate-voxel-atlas.ts`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mistManorBlocks } from '../packages/voxel-contract/src/themes/mist-manor'

interface AtlasJson { width: number; height: number; frames: Record<string, { x: number; y: number; w: number; h: number }> }

const assetDir = resolve('web/public/voxel-assets/mist-manor')
const atlas = JSON.parse(readFileSync(resolve(assetDir, 'atlas.json'), 'utf8')) as AtlasJson
const png = readFileSync(resolve(assetDir, 'atlas.png'))

const errors: string[] = []

// 1. 注册表纹理帧名 ↔ 图集帧
const required = new Set<string>()
for (const block of mistManorBlocks) {
  required.add(block.textures.top)
  required.add(block.textures.side)
  if (block.textures.bottom) required.add(block.textures.bottom)
}
for (const name of required) if (!atlas.frames[name]) errors.push(`注册表帧缺失：${name}`)
for (const name of Object.keys(atlas.frames)) if (!required.has(name)) errors.push(`图集多余帧（注册表未引用）：${name}`)

// 2. 帧几何：在图集边界内、正尺寸、互不重叠
const cells = new Set<string>()
for (const [name, f] of Object.entries(atlas.frames)) {
  if (f.w <= 0 || f.h <= 0) errors.push(`${name} 尺寸非法 ${f.w}×${f.h}`)
  if (f.x < 0 || f.y < 0 || f.x + f.w > atlas.width || f.y + f.h > atlas.height) errors.push(`${name} 越界 (${f.x},${f.y} ${f.w}×${f.h} / ${atlas.width}×${atlas.height})`)
  const key = `${f.x},${f.y},${f.w},${f.h}`
  if (cells.has(key)) errors.push(`${name} 帧重叠 ${key}`)
  cells.add(key)
}

// 3. PNG 尺寸与帧表一致（读 IHDR；手工解码 BE32 避免 Buffer 类型差异）
const be32 = (b: Uint8Array, o: number) => ((b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]) >>> 0
if (be32(png, 0) !== 0x89504e47) errors.push('atlas.png 不是有效 PNG')
const pngW = be32(png, 16), pngH = be32(png, 20)
if (pngW !== atlas.width || pngH !== atlas.height) errors.push(`PNG 尺寸 ${pngW}×${pngH} 与帧表 ${atlas.width}×${atlas.height} 不符`)

if (errors.length > 0) {
  console.error(`[atlas-validate] ${errors.length} 个问题：`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(`[atlas-validate] 通过：${required.size} 帧与注册表一致，几何与 PNG 尺寸合法。`)
