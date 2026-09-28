import { findAnyAsset, findAsset } from './catalog'
import { rectWithin } from './coordinates'
import type { GridPoint, SceneDocument, SceneDocumentAny, SceneDocumentV2, SceneThemeManifest, SceneThemeManifestV2, SceneValidationIssue, SceneValidationResult } from './types'
import { validateSceneConnectivity } from './connectivity'

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
    if (!Array.isArray(path.cells)) { issue('invalid_path_cells', `paths[${i}].cells`, '路径单元必须是格子数组'); continue }
    if (new Set(path.cells.map(key)).size !== path.cells.length) issue('duplicate_path_cell', `paths[${i}].cells`, '路径单元不能重复')
    path.cells.forEach((p, j) => { if (p.x < 0 || p.y < 0 || p.x >= document.size.columns || p.y >= document.size.rows) issue('out_of_bounds', `paths[${i}].cells[${j}]`, '路径单元超出画布') })
  }
  for (const [i, object] of document.objects.entries()) {
    const path = `objects[${i}]`
    if (typeof object.id !== 'string' || !object.id.trim()) { issue('invalid_object_id', `${path}.id`, '对象必须有非空 ID'); continue }
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

/** Validate v1 without changing its historic behavior, and validate v2 multi-space documents. */
export function validateSceneDocument(document: SceneDocumentAny, theme: SceneThemeManifest | SceneThemeManifestV2, maxObjects = 500): SceneValidationResult {
  if (document.schemaVersion === 1) {
    if (theme.schemaVersion === 1) return validateScene(document as SceneDocument, theme, maxObjects)
    return { ok: false, issues: [{ code: 'theme_schema_mismatch', path: 'theme.schemaVersion', message: 'v1 场景需要 v1 主题兼容清单' }] }
  }
  const scene = document as SceneDocumentV2
  const issues: SceneValidationIssue[] = []
  const issue = (code: string, path: string, message: string) => issues.push({ code, path, message })
  if (scene.themeId !== theme.id) issue('theme_mismatch', 'themeId', '场景主题与素材主题不一致')
  if (!Number.isInteger(scene.version) || scene.version < 0) issue('invalid_version', 'version', '场景版本必须为非负整数')
  const spaceIds = new Set<string>()
  const globalObjectIds = new Set<string>()
  let objectCount = 0
  for (const [si, space] of scene.spaces.entries()) {
    const base = `spaces[${si}]`
    if (!space.id || spaceIds.has(space.id)) issue('duplicate_space_id', `${base}.id`, '空间 ID 必须唯一且非空')
    spaceIds.add(space.id)
    if (!Number.isInteger(space.size.columns) || !Number.isInteger(space.size.rows) || space.size.columns < 1 || space.size.rows < 1) issue('invalid_size', `${base}.size`, '空间尺寸必须为正整数')
    const seen = new Set<string>()
    for (const [ti, tile] of space.surface.entries()) {
      const asset = findAnyAsset(theme, tile.assetId)
      const expected = theme.schemaVersion === 2 ? 'surface' : 'terrain'
      if (!asset || asset.category !== expected) issue('invalid_surface_asset', `${base}.surface[${ti}].assetId`, '地表单元必须引用地表资产')
      if (tile.x < 0 || tile.y < 0 || tile.x >= space.size.columns || tile.y >= space.size.rows) issue('out_of_bounds', `${base}.surface[${ti}]`, '地表单元超出空间')
    }
    for (const [pi, path] of space.paths.entries()) {
      const asset = findAnyAsset(theme, path.assetId)
      if (!asset || (theme.schemaVersion === 2 ? asset.category !== 'path' : asset.category !== path.category)) issue('invalid_path_asset', `${base}.paths[${pi}].assetId`, '路径引用了不匹配的资产')
      for (const [ci, cell] of path.cells.entries()) if (cell.x < 0 || cell.y < 0 || cell.x >= space.size.columns || cell.y >= space.size.rows) issue('out_of_bounds', `${base}.paths[${pi}].cells[${ci}]`, '路径单元超出空间')
    }
    for (const [oi, object] of [...space.structures, ...space.objects].entries()) {
      objectCount++
      const asset = findAnyAsset(theme, object.assetId)
      if (!asset) issue('invalid_object_asset', `${base}.objects[${oi}].assetId`, '对象引用了未知资产')
      if (!object.id || seen.has(object.id)) issue('duplicate_object_id', `${base}.objects[${oi}].id`, '空间内对象 ID 必须唯一且非空')
      if (object.id && globalObjectIds.has(object.id)) issue('duplicate_object_id', `${base}.objects[${oi}].id`, '对象 ID 必须在整个场景中唯一')
      seen.add(object.id)
      if (object.id) globalObjectIds.add(object.id)
      if (!Number.isFinite(object.position.x) || !Number.isFinite(object.position.y) || object.position.x < 0 || object.position.y < 0 || object.position.x >= space.size.columns || object.position.y >= space.size.rows) issue('out_of_bounds', `${base}.objects[${oi}].position`, '对象地面锚点超出空间')
      if (asset && 'geometry' in asset) {
        if (!asset.geometry.footprintCells.length) issue('missing_footprint', `${base}.objects[${oi}].assetId`, '资产必须声明至少一个占地格')
        for (const [fi, cell] of asset.geometry.footprintCells.entries()) if (object.position.x + cell.x < 0 || object.position.y + cell.y < 0 || object.position.x + cell.x >= space.size.columns || object.position.y + cell.y >= space.size.rows) issue('out_of_bounds', `${base}.objects[${oi}].footprint[${fi}]`, '对象占地超出空间')
      }
      if (object.binding?.kind === 'person' && asset && !asset.capabilities.semanticPerson) issue('invalid_binding', `${base}.objects[${oi}].binding`, '该资产不能绑定人物')
      if (object.binding && object.binding.kind !== 'person' && asset && !asset.capabilities.semanticLocation) issue('invalid_binding', `${base}.objects[${oi}].binding`, '该资产不能绑定地点')
    }
    for (const [ri, region] of space.regions.entries()) {
      if (!region.id || !region.locationName || region.cells.length === 0) issue('invalid_region', `${base}.regions[${ri}]`, '區域必须有 ID、地点名称和覆盖格')
      for (const [ci, cell] of region.cells.entries()) if (cell.x < 0 || cell.y < 0 || cell.x >= space.size.columns || cell.y >= space.size.rows) issue('out_of_bounds', `${base}.regions[${ri}].cells[${ci}]`, '区域覆盖格超出空间')
      for (const [name, p] of [['entryPoint', region.entryPoint], ['interactionPoint', region.interactionPoint]] as const) {
        if (p.x < 0 || p.y < 0 || p.x >= space.size.columns || p.y >= space.size.rows) issue('out_of_bounds', `${base}.regions[${ri}].${name}`, '区域入口超出空间')
      }
    }
    for (const [listName, cells] of [['walkableCells', space.navigation.walkableCells], ['blockedCells', space.navigation.blockedCells], ['entrances', space.navigation.entrances]] as const) {
      for (const [ci, cell] of cells.entries()) if (cell.x < 0 || cell.y < 0 || cell.x >= space.size.columns || cell.y >= space.size.rows) issue('out_of_bounds', `${base}.navigation.${listName}[${ci}]`, '导航格超出空间')
    }
  }
  if (!spaceIds.has(scene.defaultSpaceId)) issue('unknown_default_space', 'defaultSpaceId', '默认空间不存在')
  if (objectCount > maxObjects) issue('object_limit', 'spaces', `对象数量超过上限 ${maxObjects}`)
  scene.portals.forEach((portal, i) => {
    for (const side of ['from', 'to'] as const) {
      const end = portal[side]
      if (!spaceIds.has(end.spaceId)) issue('unknown_portal_space', `portals[${i}].${side}.spaceId`, 'Portal 引用了不存在的空间')
      else {
        const space = scene.spaces.find(value => value.id === end.spaceId)!
        if (end.position.x < 0 || end.position.y < 0 || end.position.x >= space.size.columns || end.position.y >= space.size.rows) issue('out_of_bounds', `portals[${i}].${side}.position`, 'Portal 位置超出空间')
      }
    }
  })
  scene.lockedAreas.forEach((area, i) => {
    const space = scene.spaces.find(value => value.id === area.spaceId)
    if (!space || !rectWithin(area, space.size)) issue('invalid_locked_area', `lockedAreas[${i}]`, '锁定区域超出空间或空间不存在')
  })
  issues.push(...validateSceneConnectivity(scene, theme))
  return { ok: issues.length === 0, issues }
}
