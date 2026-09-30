// S2b:api 侧资产清单的打包副本消费口。
// workers 运行时无文件系统,无法读 web/public 落盘清单;
// scripts/asset-import.ts 入库时双写本目录副本,此处直接 import 打包进 bundle。
import { validateAssetManifest, type AssetManifest } from '@possibility/voxel-contract'
import raw from './library-manifest.json'

let cached: AssetManifest | null = null

/** 全局资产库清单(打包副本);副本损坏时返回 null,调用方降级为形状校验 */
export function libraryManifest(): AssetManifest | null {
  if (cached) return cached
  const parsed = validateAssetManifest(raw)
  if (!parsed.ok) return null
  cached = parsed.manifest
  return cached
}
