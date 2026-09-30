// ── 资产目录契约(S2a 模块 A)────────────────────
// 全局统一资产库的类型单点:引擎(web engine/assets.ts)、入库脚本(scripts/asset-import.ts)、
// 测试三方共享。清单落盘为 web/public/voxel-assets/library/manifest.json,
// 运行时引擎 fetch、脚本直读文件,格式以此处为准。
// id 前缀约束(veg-/bld-/dec-)由入库脚本强制,此处只做纯形状校验。

import type { AssetPlacement, VoxelCoord, VoxelDocument } from './types'

export type AssetCategory = 'vegetation' | 'building' | 'decoration'

export const ASSET_CATEGORIES: AssetCategory[] = ['vegetation', 'building', 'decoration']

export interface AssetEntry {
  id: string // 唯一,kebab-case,如 'veg-tree-a' / 'bld-hut-a'
  category: AssetCategory
  url: string // GLB 地址,如 '/voxel-assets/library/models/veg-tree-a.glb'
  footprint: [number, number] // 占地 [w, d],体素格,正整数
  height: number // 高度,体素格,正数
  thumbnail: string // 缩略图地址,如 '/voxel-assets/library/thumbnails/veg-tree-a.png'
  sway: number // 摇摆振幅(弧度),0=静止;仅 vegetation 允许 >0
}

export interface AssetManifest {
  version: 2
  assets: Record<string, AssetEntry> // 键即 id
}

/** 入库品质上限(scripts/lib/glb-inspect.ts 对照) */
export const ASSET_LIMITS = {
  maxTriangles: 5000,
  maxMaterials: 8,
} as const

export const ASSET_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface AssetIssue {
  id?: string // 出问题条目的 id(清单级错误缺省)
  message: string
}

export type AssetManifestValidation =
  | { ok: true; manifest: AssetManifest }
  | { ok: false; issues: AssetIssue[] }

/** 校验清单形状;ok=true 时 manifest 为已收窄类型,issues 指明条目 */
export function validateAssetManifest(raw: unknown): AssetManifestValidation {
  const issues: AssetIssue[] = []
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>

  if (src.version !== 2) {
    issues.push({ message: `version 应为 2,实际 ${JSON.stringify(src.version)}` })
  }

  const assetsSrc = (typeof src.assets === 'object' && src.assets !== null ? src.assets : null) as Record<string, unknown> | null
  if (assetsSrc === null) {
    issues.push({ message: 'assets 缺失或不是对象' })
    return { ok: false, issues }
  }

  const assets: Record<string, AssetEntry> = {}
  for (const [key, value] of Object.entries(assetsSrc)) {
    const entryIssues: AssetIssue[] = []
    const fail = (message: string) => entryIssues.push({ id: key, message })
    const e = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>

    if (typeof e.id !== 'string' || !ASSET_ID_PATTERN.test(e.id)) {
      fail(`id 缺失或不符 kebab-case:${JSON.stringify(e.id)}`)
    } else if (e.id !== key) {
      fail(`条目 id '${e.id}' 与键 '${key}' 不一致`)
    }
    if (!ASSET_CATEGORIES.includes(e.category as AssetCategory)) {
      fail(`category 非法:${JSON.stringify(e.category)}`)
    }
    if (typeof e.url !== 'string' || e.url.length === 0) fail('url 缺失或为空')
    if (typeof e.thumbnail !== 'string' || e.thumbnail.length === 0) fail('thumbnail 缺失或为空')

    const fp = e.footprint
    if (
      !Array.isArray(fp) || fp.length !== 2 ||
      !fp.every((n) => Number.isInteger(n) && (n as number) >= 1)
    ) {
      fail(`footprint 应为两个正整数:${JSON.stringify(fp)}`)
    }
    if (typeof e.height !== 'number' || !Number.isFinite(e.height) || e.height <= 0) {
      fail(`height 应为正数:${JSON.stringify(e.height)}`)
    }
    if (typeof e.sway !== 'number' || !Number.isFinite(e.sway) || e.sway < 0) {
      fail(`sway 应为非负有限数:${JSON.stringify(e.sway)}`)
    } else if (e.sway > 0 && e.category !== 'vegetation') {
      fail('sway>0 仅允许 vegetation 类别')
    }

    if (entryIssues.length > 0) {
      issues.push(...entryIssues)
    } else {
      assets[key] = e as unknown as AssetEntry
    }
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, manifest: { version: 2, assets } }
}

// ── S2b 摆放占地与身份(F4)──────────────────────

/**
 * 摆放占据的格集合:footprint 按 rotation 旋转(奇数旋转 w/d 互换)后平移到 anchor,
 * y 取 [anchor.y, anchor.y + ceil(height)) 全柱。校验(validation.ts)与 UI 占地指示共用。
 */
export function assetFootprintCells(entry: AssetEntry, anchor: VoxelCoord, rotation: 0 | 1 | 2 | 3): VoxelCoord[] {
  const [w, d] = rotation % 2 === 0 ? entry.footprint : [entry.footprint[1], entry.footprint[0]]
  const rows = Math.max(1, Math.ceil(entry.height))
  const cells: VoxelCoord[] = []
  for (let dy = 0; dy < rows; dy++) {
    for (let dz = 0; dz < d; dz++) {
      for (let dx = 0; dx < w; dx++) {
        cells.push({ x: anchor.x + dx, y: anchor.y + dy, z: anchor.z + dz })
      }
    }
  }
  return cells
}

/** 摆放缺省 id 的确定性派生:同 (assetId, anchor, seed, 序号) 必得同 id */
function derivedPlacementId(placement: AssetPlacement, index: number): string {
  let x = (placement.seed | 0) ^ Math.imul(placement.anchor[0] + 0x9e37, 0x45d9f3b)
    ^ Math.imul(placement.anchor[2] + 0x51a7, 0x45d9f3b) ^ Math.imul(placement.anchor[1] + 1, 0x27d4eb2d)
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  return `ast-${index}-${((x ^ (x >>> 16)) >>> 0).toString(36)}`
}

/**
 * 幂等补齐摆放 id(S2b):有 id 原样保留,无 id 派生确定性 id;
 * 无需改动时返回原文档引用。旧存档(地形植被无 id)在加载边界调用,零迁移。
 */
export function ensureAssetPlacementIds(doc: VoxelDocument): VoxelDocument {
  if (!doc.assetPlacements || doc.assetPlacements.every((p) => typeof p.id === 'string' && p.id.length > 0)) return doc
  return {
    ...doc,
    // 键序对齐 deserialize/place-asset 的 id 在前——哈希/contentHash 对键序敏感
    assetPlacements: doc.assetPlacements.map((p, index) => (
      typeof p.id === 'string' && p.id.length > 0 ? p : { id: derivedPlacementId(p, index), ...p }
    )),
  }
}
