/**
 * A1 P27：演示场景新初始化有效副本制备脚本。
 *
 * 从原始 mist-manor-voxel-spaces.json（保留为"原始失败 fixture"，绝不改动）出发：
 *   1. 应用一处显式策展几何修订（见 CURATED_GEOMETRY_FIX，证据随输出打印）；
 *   2. 走真实 decode → validateSceneEnvelope → repairSceneCompatibility 修复链；
 *   3. 修复候选再次完整校验，必须 valid 才写出 mist-manor-voxel-spaces.validated.json；
 *      失败不产出有效副本（P27：失败不给有效副本）。
 *
 * 为什么需要第 1 步：原始包的主楼 interior 书架（hall-bookshelf）存在一个
 * 可达的 1 格净空腔体（walk-clearance，15,2,12），repairSceneCompatibility 按设计
 * 只移动/移除装饰资产，不能改写几何；该腔体位于书架自身 footprint 内，
 * 填充为书架同款木板对外观与行走均无影响。
 *
 * 用法：npx tsx scripts/prepare-demo-scene.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  decodeSceneCompatibility,
  isSerializedVoxelSpaces,
  repairSceneCompatibility,
  sceneBudget,
  validateSceneEnvelope,
  type SceneValidationContext,
  type SceneWorkControl,
  type StoredSceneDocument,
} from '@possibility/voxel-contract'
import { deriveSceneBindings } from '../api/src/scenes/compatibility/context'
import { libraryManifest } from '../api/src/voxel/library-manifest'

const here = dirname(fileURLToPath(import.meta.url))
const ORIGINAL_PATH = join(here, '../api/src/demo/mist-manor-voxel-spaces.json')
const VALIDATED_PATH = join(here, '../api/src/demo/mist-manor-voxel-spaces.validated.json')

/** 演示世界地点集（与 api/src/dev/seed-demo.ts 的 LOCATIONS 同名绑定口径） */
const DEMO_LOCATION_NAMES = ['大厅', '书房', '餐厅', '图书室', '温室花房', '门房小屋', '后山散步道']

/**
 * 策展几何修订：填补主楼 interior 书架（hall-bookshelf）footprint 内的
 * 1 格净空腔体 (15,2,12)，消除 walk-clearance。仅此一处；其余修复全部交给
 * repairSceneCompatibility 的真实算法完成。
 */
const CURATED_GEOMETRY_FIX = {
  spaceId: 'main-house-interior',
  section: '0,0,0',
  local: { x: 15, y: 2, z: 12 },
  block: 'wood-plank',
  ownerObjectId: 'hall-bookshelf',
  reason: '书架内部 1 格腔体紧邻可达通道触发 walk-clearance；填为书架同材质木板，不改变外观轮廓与通行',
} as const

async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

interface RawSection { palette: string[]; indices: string }
interface RawObjectCells { objectId: string; cells: Array<{ x: number; y: number; z: number }> }
interface RawSpaceDocument { sections: Record<string, RawSection>; objectCells: RawObjectCells[] }
interface RawSpace { id: string; document: RawSpaceDocument }
type RawSpaces = { spaces: RawSpace[] }

function applyCuratedGeometryFix(raw: unknown): void {
  const bundle = raw as RawSpaces
  const space = bundle.spaces.find(entry => entry.id === CURATED_GEOMETRY_FIX.spaceId)
  if (!space) throw new Error(`策展修订目标空间不存在：${CURATED_GEOMETRY_FIX.spaceId}`)
  const section = space.document.sections[CURATED_GEOMETRY_FIX.section]
  if (!section) throw new Error(`策展修订目标分段不存在：${CURATED_GEOMETRY_FIX.section}`)
  const paletteIndex = section.palette.indexOf(CURATED_GEOMETRY_FIX.block)
  if (paletteIndex < 0) throw new Error(`分段调色板缺少 ${CURATED_GEOMETRY_FIX.block}`)
  const bytes = Buffer.from(section.indices, 'base64')
  const view = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
  const { x, y, z } = CURATED_GEOMETRY_FIX.local
  const offset = y * 256 + z * 16 + x
  if (section.palette[view[offset]!] !== 'air') throw new Error(`策展修订目标格 (${x},${y},${z}) 已不是空气，原始包可能已变化`)
  view[offset] = paletteIndex
  section.indices = Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64')
  const cells = space.document.objectCells.find(entry => entry.objectId === CURATED_GEOMETRY_FIX.ownerObjectId)
  if (!cells) throw new Error(`策展修订归属物体不存在：${CURATED_GEOMETRY_FIX.ownerObjectId}`)
  if (!cells.cells.some(cell => cell.x === x && cell.y === y && cell.z === z)) cells.cells.push({ x, y, z })
}

async function main(): Promise<void> {
  const originalText = readFileSync(ORIGINAL_PATH, 'utf8')
  const originalHash = await hashText(originalText)
  const raw = JSON.parse(originalText) as unknown
  applyCuratedGeometryFix(raw)

  const decoded = decodeSceneCompatibility(raw)
  if (decoded.status !== 'ready') {
    console.error(`原始包解码失败：${decoded.status}`, decoded.issues)
    throw new Error('原始包解码失败')
  }

  const assets = libraryManifest()
  if (!assets) throw new Error('资产清单不可用')
  // 新初始化时尚无已存储场景：绑定按候选文档 + 演示世界地点集派生（与 loadWorldSceneBindings 同一纯函数）
  const bindings = deriveSceneBindings({
    document: raw as StoredSceneDocument,
    personIds: [],
    locations: DEMO_LOCATION_NAMES.map(name => ({ name })),
  })
  const assetManifestHash = await hashText(JSON.stringify(assets))
  const templateCatalogHash = await hashText(JSON.stringify('mist-manor-template-catalog-v1'))
  const bindingHash = await hashText(JSON.stringify(bindings))
  const context: SceneValidationContext = {
    rulesVersion: 'voxel-scene-validation-v1',
    assets,
    bindings,
    assetManifestHash,
    templateCatalogHash,
    bindingHash,
    contextFingerprint: await hashText(JSON.stringify({ rulesVersion: 'voxel-scene-validation-v1', assetManifestHash, templateCatalogHash, bindingHash })),
  }
  // 修复预算：副本制备是离线一次性操作，允许更多趟次/变更名额；运行时路径仍用默认预算
  const budget = sceneBudget({ maxRepairPasses: 16, maxRepairChanges: 512 })
  const control: SceneWorkControl = {
    signal: new AbortController().signal,
    nowMs: () => Date.now(),
    yieldControl: async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)) },
  }

  const before = await validateSceneEnvelope(decoded.envelope, context, budget, control, 'existing')
  console.log(`策展修订后校验：${before.status}（${before.issueCount} 项问题）`)
  for (const issue of before.issues) console.log(`  - [${issue.code}] ${issue.spaceId ?? '-'} ${issue.summary}`)

  const repair = await repairSceneCompatibility(decoded.envelope, context, budget, control)
  console.log(`真实修复链：${repair.status}（${repair.changes.length} 项变化）`)
  for (const change of repair.changes) console.log(`  * [${change.kind}] ${change.spaceId} ${change.summary}`)
  if (repair.status !== 'ready') {
    console.error('修复未能在预算内得到有效候选，不产出有效副本。剩余问题：')
    for (const issue of repair.report.issues) console.error(`  ! [${issue.code}] ${issue.spaceId ?? '-'} ${issue.summary}`)
    throw new Error('修复未得到有效候选')
  }

  // 有效副本再次完整校验：解码 → 全量校验必须 valid
  const recheck = decodeSceneCompatibility(repair.candidate)
  if (recheck.status !== 'ready') throw new Error('有效副本无法解码，不产出')
  const recheckBindings = deriveSceneBindings({
    document: repair.candidate,
    personIds: [],
    locations: DEMO_LOCATION_NAMES.map(name => ({ name })),
  })
  const finalReport = await validateSceneEnvelope(recheck.envelope, { ...context, bindings: recheckBindings }, budget, control, 'existing')
  if (finalReport.status !== 'valid') {
    console.error(`有效副本复验未通过：${finalReport.status}（${finalReport.issueCount} 项问题），不产出。`)
    for (const issue of finalReport.issues) console.error(`  ! [${issue.code}] ${issue.spaceId ?? '-'} ${issue.summary}`)
    throw new Error('有效副本复验未通过')
  }
  if (!isSerializedVoxelSpaces(repair.candidate)) throw new Error('有效副本不是多空间体素包，不产出')

  // 原始文件哈希核对：制备过程绝不改动原始失败 fixture
  if (await hashText(readFileSync(ORIGINAL_PATH, 'utf8')) !== originalHash) {
    throw new Error('原始 mist-manor-voxel-spaces.json 在制备过程中被改动，中止')
  }

  const validatedText = JSON.stringify(repair.candidate)
  writeFileSync(VALIDATED_PATH, validatedText)
  console.log('')
  console.log('有效副本已写出：api/src/demo/mist-manor-voxel-spaces.validated.json')
  console.log(`来源证据：原始 sha256=${originalHash}（未改动）`)
  console.log(`策展几何修订：${CURATED_GEOMETRY_FIX.spaceId} (${CURATED_GEOMETRY_FIX.local.x},${CURATED_GEOMETRY_FIX.local.y},${CURATED_GEOMETRY_FIX.local.z}) → ${CURATED_GEOMETRY_FIX.block}；${CURATED_GEOMETRY_FIX.reason}`)
  console.log(`修复变化 ${repair.changes.length} 项（含摆放稳定标识分配与装饰资产移动/移除）`)
  console.log(`副本 sha256=${await hashText(validatedText)}；最终校验 valid（0 项问题，计数精确）`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? `制备失败：${error.message}` : error)
  process.exitCode = 1
}
