import type { AssetCategory, SceneAssetDefinition, SceneThemeManifest, SceneValidationIssue } from './types'

export function validateThemeManifest(theme: SceneThemeManifest): SceneValidationIssue[] {
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
    if (asset.footprint.width < 1 || asset.footprint.height < 1) issues.push({ code: 'invalid_footprint', path: `${path}.footprint`, message: '占地必须为正整数' })
  }
  if (theme.schemaVersion !== 1) issues.push({ code: 'unsupported_schema', path: 'schemaVersion', message: '不支持该主题清单版本' })
  return issues
}
export function findAsset(theme: SceneThemeManifest, id: string): SceneAssetDefinition | undefined { return theme.assets.find(a => a.id === id) }
export function assetsByCategory(theme: SceneThemeManifest, category: AssetCategory): SceneAssetDefinition[] { return theme.assets.filter(a => a.category === category) }
export function compactCatalogForPrompt(theme: SceneThemeManifest): string {
  return theme.assets.map(a => `${a.id}|${a.category}|${a.footprint.width}x${a.footprint.height}|${a.tags.join(',')}`).join('\n')
}
