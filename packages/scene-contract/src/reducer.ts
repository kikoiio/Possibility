import { findAsset } from './catalog'
import { rectWithin } from './coordinates'
import { validateScene } from './validation'
import { normalizeSceneDocument } from './normalize'
import type { GridPoint, SceneChangeSet, SceneDocument, SceneDocumentV2, SceneOperation, ScenePreviewResult, SceneThemeManifest } from './types'

const cellKey = (p: GridPoint) => `${p.x},${p.y}`
const lockedAt = (doc: SceneDocument, p: GridPoint) => doc.lockedAreas.some(a => p.x >= a.x && p.y >= a.y && p.x < a.x + a.width && p.y < a.y + a.height)
const footprintLocked = (doc: SceneDocument, assetId: string, position: GridPoint, theme: SceneThemeManifest) => {
  const footprint = findAsset(theme, assetId)?.footprint ?? { width: 1, height: 1 }
  for (let y = 0; y < footprint.height; y++) for (let x = 0; x < footprint.width; x++) if (lockedAt(doc, { x: position.x + x, y: position.y + y })) return true
  return false
}
export function applySceneOperations(base: SceneDocument, operations: SceneOperation[], theme: SceneThemeManifest): ScenePreviewResult {
  let doc: SceneDocument = structuredClone(base)
  const changes: SceneChangeSet = { added: [], moved: [], updated: [], removed: [] }
  for (const op of operations) {
    if (op.type === 'add_object') {
      if (doc.objects.some(o => o.id === op.object.id)) throw new Error(`对象已存在：${op.object.id}`)
      if (footprintLocked(doc, op.object.assetId, op.object.position, theme)) throw new Error('不能在锁定区域内放置对象')
      doc.objects.push(structuredClone(op.object)); changes.added.push(op.object.id); continue
    }
    if (op.type === 'paint_cells') {
      const cells = [...new Map(op.cells.map(p => [cellKey(p), p])).values()]
      if (cells.some(p => lockedAt(doc, p))) throw new Error('笔画经过锁定区域')
      if (op.category === 'terrain') {
        const map = new Map(doc.terrain.map(t => [cellKey(t), t]))
        cells.forEach(p => map.set(cellKey(p), { ...p, assetId: op.assetId }))
        doc.terrain = [...map.values()]
      } else {
        const id = `path-${crypto.randomUUID()}`
        doc.paths.push({ id, category: op.category, assetId: op.assetId, cells })
      }
      continue
    }
    if (op.type === 'erase_cells') {
      const keys = new Set(op.cells.map(cellKey))
      if (op.cells.some(p => lockedAt(doc, p))) throw new Error('不能擦除锁定区域')
      doc.paths = doc.paths.map(path => ({ ...path, cells: path.cells.filter(p => !keys.has(cellKey(p))) })).filter(path => path.cells.length)
      continue
    }
    if (op.type === 'lock_area' || op.type === 'unlock_area') {
      if (!rectWithin(op.area, doc.size)) throw new Error('锁定区域超出画布')
      if (op.type === 'lock_area') doc.lockedAreas.push({ ...op.area })
      else doc.lockedAreas = doc.lockedAreas.filter(a => JSON.stringify(a) !== JSON.stringify(op.area))
      continue
    }
    const index = doc.objects.findIndex(o => o.id === op.objectId)
    if (index < 0) throw new Error(`对象不存在：${op.objectId}`)
    const object = doc.objects[index]!
    if (doc.lockedObjectIds.includes(object.id) && op.type !== 'lock_object') throw new Error('对象已锁定')
    if (footprintLocked(doc, object.assetId, object.position, theme) && op.type !== 'lock_object') throw new Error('对象位于锁定区域')
    if (op.type === 'move_object') {
      if (footprintLocked(doc, object.assetId, op.to, theme)) throw new Error('不能移动到锁定区域')
      object.position = { ...op.to }; changes.moved.push(object.id)
    }
    else if (op.type === 'remove_object') { doc.objects.splice(index, 1); doc.lockedObjectIds = doc.lockedObjectIds.filter(id => id !== object.id); changes.removed.push(object.id) }
    else if (op.type === 'replace_asset') { object.assetId = op.assetId; changes.updated.push(object.id) }
    else if (op.type === 'update_object') { if ('label' in op) object.label = op.label ?? null; if ('purpose' in op) object.purpose = op.purpose ?? null; changes.updated.push(object.id) }
    else if (op.type === 'lock_object') doc.lockedObjectIds = op.locked ? [...new Set([...doc.lockedObjectIds, object.id])] : doc.lockedObjectIds.filter(id => id !== object.id)
  }
  const result = validateScene(doc, theme)
  if (!result.ok) throw new Error(result.issues.map(i => `${i.path}: ${i.message}`).join('; '))
  return { document: doc, changes }
}

/** Apply an operation to one v2 space while preserving every other space verbatim. */
export function applySceneOperationsInSpace(base: SceneDocumentV2, spaceId: string, operations: SceneOperation[], theme: SceneThemeManifest) {
  const document = normalizeSceneDocument(base)
  const space = document.spaces.find(candidate => candidate.id === spaceId)
  if (!space) throw new Error(`空间不存在：${spaceId}`)
  const legacy: SceneDocument = {
    schemaVersion: 1, themeId: document.themeId, size: structuredClone(space.size), version: document.version,
    terrain: structuredClone(space.surface), paths: structuredClone(space.paths), objects: structuredClone(space.objects),
    lockedObjectIds: document.lockedObjectIds.filter(id => space.objects.some(object => object.id === id)),
    lockedAreas: document.lockedAreas.filter(area => area.spaceId === spaceId).map(({ spaceId: _spaceId, ...area }) => area),
  }
  const result = applySceneOperations(legacy, operations, theme)
  const next = structuredClone(document)
  const target = next.spaces.find(candidate => candidate.id === spaceId)!
  target.surface = result.document.terrain
  target.paths = result.document.paths
  target.objects = result.document.objects
  next.lockedObjectIds = [...next.lockedObjectIds.filter(id => !space.objects.some(object => object.id === id)), ...result.document.lockedObjectIds]
  next.lockedAreas = [...next.lockedAreas.filter(area => area.spaceId !== spaceId), ...result.document.lockedAreas.map(area => ({ ...area, spaceId }))]
  return { document: next, changes: result.changes }
}
