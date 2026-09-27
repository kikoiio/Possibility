import { findAsset } from './catalog'
import { rectWithin } from './coordinates'
import type { GridPoint, SceneDocument, SceneThemeManifest, SceneValidationIssue, SceneValidationResult } from './types'

const key = (p: GridPoint) => `${p.x},${p.y}`
export function validateScene(document: SceneDocument, theme: SceneThemeManifest, maxObjects = 500): SceneValidationResult {
  const issues: SceneValidationIssue[] = []
  const issue = (code: string, path: string, message: string) => issues.push({ code, path, message })
  if (document.schemaVersion !== 1) issue('unsupported_schema', 'schemaVersion', '不支持的场景版本')
  if (document.themeId !== theme.id) issue('theme_mismatch', 'themeId', '场景主题与素材主题不一致')
  if (!Number.isInteger(document.size.columns) || !Number.isInteger(document.size.rows) || document.size.columns < 1 || document.size.rows < 1) issue('invalid_size', 'size', '画布尺寸必须为正整数')
  if (!Number.isInteger(document.version) || document.version < 0) issue('invalid_version', 'version', '场景版本必须为非负整数')
  if (document.objects.length > maxObjects) issue('object_limit', 'objects', `对象数量超过上限 ${maxObjects}`)
  const occupied = new Map<string, string>()
  const ids = new Set<string>()
  for (const [i, tile] of document.terrain.entries()) {
    const asset = findAsset(theme, tile.assetId)
    if (!asset || asset.category !== 'terrain') issue('invalid_terrain_asset', `terrain[${i}].assetId`, '地形必须引用地形资产')
    if (tile.x < 0 || tile.y < 0 || tile.x >= document.size.columns || tile.y >= document.size.rows) issue('out_of_bounds', `terrain[${i}]`, '地形单元超出画布')
  }
  const terrainKeys = document.terrain.map(key)
  if (new Set(terrainKeys).size !== terrainKeys.length) issue('duplicate_terrain', 'terrain', '地形单元不能重复')
  for (const [i, path] of document.paths.entries()) {
    const asset = findAsset(theme, path.assetId)
    if (!asset || asset.category !== path.category) issue('invalid_path_asset', `paths[${i}].assetId`, '路径类别与资产不匹配')
    if (new Set(path.cells.map(key)).size !== path.cells.length) issue('duplicate_path_cell', `paths[${i}].cells`, '路径单元不能重复')
    path.cells.forEach((p, j) => { if (p.x < 0 || p.y < 0 || p.x >= document.size.columns || p.y >= document.size.rows) issue('out_of_bounds', `paths[${i}].cells[${j}]`, '路径单元超出画布') })
  }
  for (const [i, object] of document.objects.entries()) {
    const path = `objects[${i}]`
    if (ids.has(object.id)) issue('duplicate_object_id', `${path}.id`, '对象 ID 不能重复')
    ids.add(object.id)
    const asset = findAsset(theme, object.assetId)
    if (!asset || !asset.capabilities.placeable) { issue('invalid_object_asset', `${path}.assetId`, '对象必须引用可放置资产'); continue }
    const rect = { ...object.position, ...asset.footprint }
    if (!rectWithin(rect, document.size)) issue('out_of_bounds', `${path}.position`, '对象占地超出画布')
    for (const p of Array.from({ length: asset.footprint.width * asset.footprint.height }, (_, n) => ({ x: rect.x + n % asset.footprint.width, y: rect.y + Math.floor(n / asset.footprint.width) }))) {
      const cell = key(p); const previous = occupied.get(cell)
      if (previous) issue('collision', `${path}.position`, `与对象 ${previous} 占地重叠`)
      else occupied.set(cell, object.id)
    }
    if (object.binding?.kind === 'person' && !asset.capabilities.semanticPerson) issue('invalid_binding', `${path}.binding`, '该资产不能绑定人物')
    if (object.binding && object.binding.kind !== 'person' && !asset.capabilities.semanticLocation) issue('invalid_binding', `${path}.binding`, '该资产不能绑定地点')
  }
  for (const id of document.lockedObjectIds) if (!ids.has(id)) issue('unknown_lock', 'lockedObjectIds', `锁定对象不存在：${id}`)
  for (const [i, area] of document.lockedAreas.entries()) if (!rectWithin(area, document.size)) issue('invalid_locked_area', `lockedAreas[${i}]`, '锁定区域超出画布')
  return { ok: issues.length === 0, issues }
}
