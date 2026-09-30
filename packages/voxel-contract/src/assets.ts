// ── 资产目录契约(S2a 模块 A)────────────────────
// 全局统一资产库的类型单点:引擎(web engine/assets.ts)、入库脚本(scripts/asset-import.ts)、
// 测试三方共享。清单落盘为 web/public/voxel-assets/library/manifest.json,
// 运行时引擎 fetch、脚本直读文件,格式以此处为准。
// id 前缀约束(veg-/bld-/dec-)由入库脚本强制,此处只做纯形状校验。

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
