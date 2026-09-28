import type { AssetCategory, SceneAssetDefinition, SceneThemeManifest, SceneThemeManifestV2, SceneValidationIssue } from './types'

export function findAnyAsset(theme: SceneThemeManifest | SceneThemeManifestV2, id: string) {
  return theme.assets.find(asset => asset.id === id)
}

export function validateThemeManifest(theme: SceneThemeManifest | SceneThemeManifestV2): SceneValidationIssue[] {
  const issues: SceneValidationIssue[] = []
  const sheetIds = new Set(theme.sheets.map(s => s.id))
  const ids = new Set<string>()
  for (const [i, asset] of theme.assets.entries()) {
    const path = `assets[${i}]`
    if (ids.has(asset.id)) issues.push({ code: 'duplicate_asset_id', path: `${path}.id`, message: `重复资产 ID：${asset.id}` })
    ids.add(asset.id)
    if (asset.themeId !== theme.id) issues.push({ code: 'theme_mismatch', path: `${path}.themeId`, message: '资产主题与清单不一致' })
    if (!sheetIds.has(asset.sprite.sheetId)) issues.push({ code: 'unknown_sheet', path: `${path}.sprite.sheetId`, message: '图集未在主题中登记' })
    if (!asset.sprite.frame) issues.push({ code: 'missing_frame', path: `${path}.sprite.frame`, message: '资产必须引用图集帧' })
    if (asset.capabilities.placeable && !asset.thumbnail) issues.push({ code: 'missing_thumbnail', path: `${path}.thumbnail`, message: '可放置资产必须引用缩略图' })
    if ('geometry' in asset) {
      if (!asset.sprite.frameSize || asset.sprite.frameSize.width < 1 || asset.sprite.frameSize.height < 1) issues.push({ code: 'invalid_frame_size', path: `${path}.sprite.frameSize`, message: '原始帧尺寸必须为正数' })
      if (!asset.geometry.groundContactCell || !asset.geometry.groundContactPixel) issues.push({ code: 'missing_ground_contact', path: `${path}.geometry`, message: '资产必须声明地面接触点' })
      if (!asset.navigation || !Array.isArray(asset.navigation.entrances)) issues.push({ code: 'missing_navigation', path: `${path}.navigation`, message: '资产必须声明导航信息' })
      if (!asset.sprite.states || !asset.sprite.states[Object.keys(asset.sprite.states)[0]]) issues.push({ code: 'missing_state_frame', path: `${path}.sprite.states`, message: '资产必须声明至少一个有效状态帧' })
    } else if (asset.footprint.width < 1 || asset.footprint.height < 1) issues.push({ code: 'invalid_footprint', path: `${path}.footprint`, message: '占地必须为正整数' })
  }
  if (theme.schemaVersion !== 1 && theme.schemaVersion !== 2) issues.push({ code: 'unsupported_schema', path: 'schemaVersion', message: '不支持该主题清单版本' })
  return issues
}
export function findAsset(theme: SceneThemeManifest, id: string): SceneAssetDefinition | undefined { return theme.assets.find(a => a.id === id) }
export function assetsByCategory(theme: SceneThemeManifest, category: AssetCategory): SceneAssetDefinition[] { return theme.assets.filter(a => a.category === category) }
export function compactCatalogForPrompt(theme: SceneThemeManifest): string {
  return theme.assets.map(a => `${a.id}|${a.category}|${a.footprint.width}x${a.footprint.height}|${a.tags.join(',')}`).join('\n')
}
