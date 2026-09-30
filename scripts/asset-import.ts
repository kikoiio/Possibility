// ── 资产入库 CLI(S2a 模块 C)────────────────────
// 统一入库入口:任意来源 GLB 经 校验 → 拷贝 → 缩略图 → 登记 进全局资产库。
// 幂等:同一 id 重复入库 = 覆盖更新;任一步失败回滚,不留半成品。
// 用法:
//   tsx scripts/asset-import.ts --glb <path> --id <id> --category <vegetation|building|decoration>
//                               --footprint WxD --height H [--sway <振幅>]
// 相容规则(spec F2):几何包围盒不得超过声明尺寸 +0.5 格(欠尺寸放行——footprint 是占格语义)。

import { copyFileSync, existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import {
  ASSET_ID_PATTERN, ASSET_LIMITS, validateAssetManifest,
  type AssetCategory, type AssetEntry, type AssetManifest,
} from '@possibility/voxel-contract'
import { inspectGlb } from './lib/glb-inspect'

const LIBRARY_DIR = resolve('web/public/voxel-assets/library')
const MANIFEST_PATH = resolve(LIBRARY_DIR, 'manifest.json')
// S2b:api(workers 无文件系统)经打包副本消费同一清单,入库时同步双写
const API_MANIFEST_PATH = resolve('api/src/voxel/library-manifest.json')
const CATEGORY_PREFIX: Record<AssetCategory, string> = { vegetation: 'veg-', building: 'bld-', decoration: 'dec-' }
const SIZE_TOLERANCE = 0.5

function fail(reason: string): never {
  console.error(`[asset-import] 拒绝:${reason}`)
  process.exit(1)
  // workers-types 下 process.exit 未收窄为 never,显式 throw 保证类型层面不可达
  throw new Error(reason)
}

// ── 参数解析 ──────────────────────────────────
const args = process.argv.slice(2)
const opt = (name: string): string | null => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? (args[i + 1] ?? null) : null
}
const glbPath = opt('glb')
const id = opt('id')
const category = opt('category') as AssetCategory | null
const footprintRaw = opt('footprint')
const heightRaw = opt('height')
const swayRaw = opt('sway')

if (!glbPath || !id || !category || !footprintRaw || !heightRaw) {
  fail('缺少必填参数:--glb --id --category --footprint WxD --height [--sway]')
}
if (!ASSET_ID_PATTERN.test(id)) fail(`id 不符 kebab-case:${id}`)
if (!CATEGORY_PREFIX[category]) fail(`category 非法:${category}`)
if (!id.startsWith(CATEGORY_PREFIX[category])) fail(`id '${id}' 前缀与类别 ${category}(${CATEGORY_PREFIX[category]})不符`)

const fpMatch = /^(\d+)x(\d+)$/.exec(footprintRaw)
if (!fpMatch) fail(`footprint 应为 WxD 格式:${footprintRaw}`)
const footprint: [number, number] = [Number(fpMatch[1]), Number(fpMatch[2])]
const height = Number(heightRaw)
if (!Number.isFinite(height) || height <= 0) fail(`height 应为正数:${heightRaw}`)
const sway = swayRaw === null ? 0 : Number(swayRaw)
if (!Number.isFinite(sway) || sway < 0) fail(`sway 应为非负有限数:${swayRaw}`)
if (category !== 'vegetation' && sway > 0) fail('sway>0 仅允许 vegetation 类别')

// ── 品质校验(模块 B) ─────────────────────────
if (!existsSync(glbPath)) fail(`GLB 文件不存在:${glbPath}`)
let report: ReturnType<typeof inspectGlb>
try {
  report = inspectGlb(glbPath)
} catch (err) {
  fail((err as Error).message)
}
if (report.triangles > ASSET_LIMITS.maxTriangles) fail(`三角形 ${report.triangles} 超上限 ${ASSET_LIMITS.maxTriangles}`)
if (report.materials > ASSET_LIMITS.maxMaterials) fail(`材质 ${report.materials} 超上限 ${ASSET_LIMITS.maxMaterials}`)
const [sx, sy, sz] = report.bounds.size
if (sx > footprint[0] + SIZE_TOLERANCE) fail(`几何宽 ${sx.toFixed(2)} 超声明 footprint ${footprint[0]}+${SIZE_TOLERANCE}`)
if (sz > footprint[1] + SIZE_TOLERANCE) fail(`几何深 ${sz.toFixed(2)} 超声明 footprint ${footprint[1]}+${SIZE_TOLERANCE}`)
if (sy > height + SIZE_TOLERANCE) fail(`几何高 ${sy.toFixed(2)} 超声明 height ${height}+${SIZE_TOLERANCE}`)

// ── 落位(带回滚) ─────────────────────────────
const modelPath = resolve(LIBRARY_DIR, 'models', `${id}.glb`)
const thumbPath = resolve(LIBRARY_DIR, 'thumbnails', `${id}.png`)
const modelBackup = existsSync(modelPath) ? readFileSync(modelPath) : null
const thumbBackup = existsSync(thumbPath) ? readFileSync(thumbPath) : null
const manifestBackup = existsSync(MANIFEST_PATH) ? readFileSync(MANIFEST_PATH, 'utf8') : null

const rollback = () => {
  if (modelBackup) writeFileSync(modelPath, modelBackup); else rmSync(modelPath, { force: true })
  if (thumbBackup) writeFileSync(thumbPath, thumbBackup); else rmSync(thumbPath, { force: true })
  if (manifestBackup) writeFileSync(MANIFEST_PATH, manifestBackup); else rmSync(MANIFEST_PATH, { force: true })
}

try {
  mkdirSync(dirname(modelPath), { recursive: true })
  mkdirSync(dirname(thumbPath), { recursive: true })
  copyFileSync(glbPath, modelPath)
  execFileSync('node', [
    'scripts/asset-thumbnail.mjs',
    '--glb', `/voxel-assets/library/models/${id}.glb`,
    '--out', thumbPath,
  ], { stdio: 'inherit' })

  const manifest: AssetManifest = manifestBackup
    ? (JSON.parse(manifestBackup) as AssetManifest)
    : { version: 2, assets: {} }
  const entry: AssetEntry = {
    id,
    category,
    url: `/voxel-assets/library/models/${id}.glb`,
    footprint,
    height,
    thumbnail: `/voxel-assets/library/thumbnails/${id}.png`,
    sway,
  }
  manifest.assets = { ...manifest.assets, [id]: entry }
  const validation = validateAssetManifest(manifest)
  if (!validation.ok) throw new Error(`登记后清单终检失败:${validation.issues[0]?.message}`)
  writeFileSync(MANIFEST_PATH, JSON.stringify(validation.manifest, null, 2) + '\n')
  writeFileSync(API_MANIFEST_PATH, JSON.stringify(validation.manifest, null, 2) + '\n')
  console.log(`[asset-import] 入库完成:${id}(${category}, ${report.triangles} tris, footprint ${footprint.join('x')}, sway ${sway})`)
} catch (err) {
  rollback()
  fail(`${(err as Error).message}(已回滚)`)
}
