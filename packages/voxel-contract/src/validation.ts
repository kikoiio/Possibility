import { getObjectTemplate } from './catalog'
import { rotatedOffsets } from './edits'
import { assetFootprintCells, type AssetManifest } from './assets'
import { createBlockRegistry } from './registry'
import { getBlock, inBounds, parseSectionKey } from './sections'
import { AIR, SECTION_SIZE } from './sections'
import { STYLE_PRESETS } from './style'
import type {
  AssetPlacement, BlockRegistry, EditOperation, ValidationIssue, Validator, VoxelCoord, VoxelDocument,
} from './types'

/** 物体模板在某锚点与旋转下的占据格（与世界坐标） */
export function objectFootprint(objectType: string, anchor: VoxelCoord, rotation: 0 | 90 | 180 | 270): VoxelCoord[] {
  const template = getObjectTemplate(objectType)
  if (!template) return []
  return rotatedOffsets(template.cells.map((c) => c.offset), rotation)
    .map((o) => ({ x: anchor.x + o.x, y: anchor.y + o.y, z: anchor.z + o.z }))
}

const cellKey = (at: VoxelCoord) => `${at.x},${at.y},${at.z}`
const placementAnchor = (p: AssetPlacement): VoxelCoord => ({ x: p.anchor[0], y: p.anchor[1], z: p.anchor[2] })

/** 物体是否有支撑：底层格至少一格立在地面或实体方块上 */
function objectIsFloating(doc: VoxelDocument, registry: BlockRegistry, cells: VoxelCoord[]): boolean {
  if (cells.length === 0) return false
  const minY = Math.min(...cells.map((c) => c.y))
  const base = cells.filter((c) => c.y === minY)
  const own = new Set(cells.map(cellKey))
  return !base.some((c) => {
    if (c.y === 0) return true
    const below = { x: c.x, y: c.y - 1, z: c.z }
    if (own.has(cellKey(below))) return false
    const block = registry.get(getBlock(doc, below))
    return !!block?.solid
  })
}

/** S2b 摆放形状校验（无清单时的兜底）：anchor 三整数、rotation 0..3、seed 有限 */
function placementShapeIssue(placement: AssetPlacement, label: string): ValidationIssue | null {
  if (!Array.isArray(placement.anchor) || placement.anchor.length !== 3 || !placement.anchor.every((v) => Number.isInteger(v))) {
    return { code: 'invalid-meta', message: `asset placement '${label}': anchor must be three integers` }
  }
  if (placement.rotation !== 0 && placement.rotation !== 1 && placement.rotation !== 2 && placement.rotation !== 3) {
    return { code: 'invalid-meta', message: `asset placement '${label}': rotation must be 0..3` }
  }
  if (typeof placement.seed !== 'number' || !Number.isFinite(placement.seed)) {
    return { code: 'invalid-meta', message: `asset placement '${label}': seed must be finite` }
  }
  return null
}

/**
 * S2b 单条摆放的规则校验（需清单）：assetId 存在、footprint 不越界、
 * 不与其他摆放/物体重叠、不悬空。selfRef 为移动中的自身（豁免重叠）。
 */
function checkAssetPlacement(
  doc: VoxelDocument, registry: BlockRegistry, assets: AssetManifest,
  assetId: string, anchor: VoxelCoord, rotation: 0 | 1 | 2 | 3,
  selfRef: AssetPlacement | undefined, issues: ValidationIssue[],
): void {
  const shape = placementShapeIssue({ assetId, anchor: [anchor.x, anchor.y, anchor.z], rotation, seed: 0 }, assetId)
  if (shape) {
    issues.push({ ...shape, at: anchor })
    return
  }
  const entry = assets.assets[assetId]
  if (!entry) {
    issues.push({ code: 'unknown-asset', message: `unknown asset '${assetId}'`, at: anchor })
    return
  }
  const cells = assetFootprintCells(entry, anchor, rotation)
  for (const at of cells) {
    if (!inBounds(doc.size, at)) {
      issues.push({ code: 'out-of-bounds', message: `asset '${assetId}' would lie outside world bounds`, at })
      return
    }
  }
  const own = new Set(cells.map(cellKey))
  for (const other of doc.assetPlacements ?? []) {
    if (other === selfRef) continue
    const otherEntry = assets.assets[other.assetId]
    if (!otherEntry) continue // 他人 assetId 的存在性由文档级校验另行报告
    if (assetFootprintCells(otherEntry, placementAnchor(other), other.rotation).some((c) => own.has(cellKey(c)))) {
      issues.push({ code: 'asset-overlap', message: `asset '${assetId}' would overlap placement '${other.id ?? other.assetId}'`, at: anchor })
      return
    }
  }
  for (const objectCells of doc.objectCells) {
    if (objectCells.cells.some((c) => own.has(cellKey(c)))) {
      issues.push({ code: 'asset-overlap', message: `asset '${assetId}' would overlap object '${objectCells.objectId}'`, at: anchor })
      return
    }
  }
  if (objectIsFloating(doc, registry, cells)) {
    issues.push({ code: 'asset-overlap', message: `asset '${assetId}' has no support beneath`, at: anchor })
  }
}

export function validateDocument(doc: VoxelDocument, registry?: BlockRegistry, assets?: AssetManifest): ValidationIssue[] {
  const reg = registry ?? createBlockRegistry(doc.theme)
  const issues: ValidationIssue[] = []
  const maxCx = Math.ceil(doc.size.width / SECTION_SIZE)
  const maxCy = Math.ceil(doc.size.height / SECTION_SIZE)
  const maxCz = Math.ceil(doc.size.depth / SECTION_SIZE)

  // 节数据：节键越界、未知方块
  for (const [key, section] of Object.entries(doc.sections)) {
    const { cx, cy, cz } = parseSectionKey(key)
    if (cx < 0 || cy < 0 || cz < 0 || cx >= maxCx || cy >= maxCy || cz >= maxCz) {
      issues.push({ code: 'out-of-bounds', message: `section ${key} lies outside world size ${doc.size.width}×${doc.size.height}×${doc.size.depth}` })
    }
    for (const id of section.palette) {
      if (id !== AIR && !reg.get(id)) {
        issues.push({ code: 'unknown-block', message: `section ${key} palette references unknown block '${id}'` })
      }
    }
  }

  // 物体：格子越界、悬空、重叠
  const occupied = new Map<string, string>() // cellKey -> objectId
  for (const entry of doc.objectCells) {
    const object = doc.objects.find((o) => o.id === entry.objectId)
    for (const at of entry.cells) {
      if (!inBounds(doc.size, at)) {
        issues.push({ code: 'out-of-bounds', message: `object ${entry.objectId} occupies cell outside world bounds`, at })
      }
      const holder = occupied.get(cellKey(at))
      if (holder && holder !== entry.objectId) {
        issues.push({ code: 'object-overlap', message: `objects '${holder}' and '${entry.objectId}' overlap`, at })
      } else {
        occupied.set(cellKey(at), entry.objectId)
      }
    }
    if (object && objectIsFloating(doc, reg, entry.cells)) {
      issues.push({ code: 'floating-object', message: `object '${entry.objectId}' (${object.objectType}) has no support beneath`, at: object.anchor })
    }
  }

  // 地点绑定：必须指向存在的物体
  for (const location of doc.locations) {
    if (!doc.objects.some((o) => o.id === location.objectId)) {
      issues.push({ code: 'location-unbound', message: `location '${location.name}' binds to missing object '${location.objectId}'` })
    }
  }

  // S3b 元数据(F6):形状轻校验,违规走既有重试管线
  if (doc.terrain) {
    if (!Number.isInteger(doc.terrain.params?.seed)) {
      issues.push({ code: 'invalid-meta', message: 'terrain.params.seed must be an integer' })
    }
    if (!Array.isArray(doc.terrain.clamps)) {
      issues.push({ code: 'invalid-meta', message: 'terrain.clamps must be an array' })
    }
  }
  if (doc.style && !STYLE_PRESETS.some((p) => p.id === doc.style!.preset)) {
    issues.push({ code: 'invalid-meta', message: `unknown style preset '${doc.style.preset}'` })
  }

  // S2b 资产摆放(F4):形状必查;传清单时补存在性/越界/互撞/压物体/悬空
  if (doc.assetPlacements) {
    const occupiedAssets = new Map<string, string>() // cellKey -> placement 标签
    doc.assetPlacements.forEach((placement, index) => {
      const label = placement.id ?? `#${index}`
      const shape = placementShapeIssue(placement, label)
      if (shape) {
        issues.push(shape)
        return
      }
      if (!assets) return
      const entry = assets.assets[placement.assetId]
      if (!entry) {
        issues.push({ code: 'unknown-asset', message: `asset placement '${label}' references unknown asset '${placement.assetId}'`, at: placementAnchor(placement) })
        return
      }
      const cells = assetFootprintCells(entry, placementAnchor(placement), placement.rotation)
      for (const at of cells) {
        if (!inBounds(doc.size, at)) {
          issues.push({ code: 'out-of-bounds', message: `asset placement '${label}' occupies cell outside world bounds`, at })
          return
        }
      }
      for (const at of cells) {
        const holder = occupiedAssets.get(cellKey(at))
        if (holder) {
          issues.push({ code: 'asset-overlap', message: `asset placements '${holder}' and '${label}' overlap`, at })
          return
        }
      }
      for (const at of cells) occupiedAssets.set(cellKey(at), label)
      const own = new Set(cells.map(cellKey))
      for (const objectCells of doc.objectCells) {
        if (objectCells.cells.some((c) => own.has(cellKey(c)))) {
          issues.push({ code: 'asset-overlap', message: `asset placement '${label}' overlaps object '${objectCells.objectId}'`, at: placementAnchor(placement) })
          return
        }
      }
      if (objectIsFloating(doc, reg, cells)) {
        issues.push({ code: 'asset-overlap', message: `asset placement '${label}' (${placement.assetId}) has no support beneath`, at: placementAnchor(placement) })
      }
    })
  }
  return issues
}

export function validateEdit(doc: VoxelDocument, ops: EditOperation[], registry?: BlockRegistry, assets?: AssetManifest): ValidationIssue[] {
  const reg = registry ?? createBlockRegistry(doc.theme)
  const issues: ValidationIssue[] = []
  const locked = new Set(doc.lockedObjectIds)
  const lockedCells = new Map<string, string>() // cellKey -> objectId（仅锁定物体）
  for (const entry of doc.objectCells) {
    if (!locked.has(entry.objectId)) continue
    for (const at of entry.cells) lockedCells.set(cellKey(at), entry.objectId)
  }

  const checkBlockCell = (at: VoxelCoord, block: string) => {
    if (!inBounds(doc.size, at)) {
      issues.push({ code: 'out-of-bounds', message: `block edit outside world bounds`, at })
      return
    }
    if (block !== AIR && !reg.get(block)) {
      issues.push({ code: 'unknown-block', message: `unknown block '${block}'`, at })
    }
    const holder = lockedCells.get(cellKey(at))
    if (holder) {
      issues.push({ code: 'locked-violation', message: `cell belongs to locked object '${holder}'`, at })
    }
  }

  const checkObjectPlacement = (objectType: string, anchor: VoxelCoord, rotation: 0 | 90 | 180 | 270, selfId?: string) => {
    if (!getObjectTemplate(objectType)) {
      issues.push({ code: 'unknown-block', message: `unknown object type '${objectType}'`, at: anchor })
      return
    }
    const cells = objectFootprint(objectType, anchor, rotation)
    for (const at of cells) {
      if (!inBounds(doc.size, at)) {
        issues.push({ code: 'out-of-bounds', message: `object '${objectType}' would lie outside world bounds`, at })
        return
      }
      const lockedHolder = lockedCells.get(cellKey(at))
      if (lockedHolder && lockedHolder !== selfId) {
        issues.push({ code: 'locked-violation', message: `object would overlap locked object '${lockedHolder}'`, at })
        return
      }
    }
    for (const entry of doc.objectCells) {
      if (entry.objectId === selfId) continue
      if (entry.cells.some((at) => cells.some((c) => c.x === at.x && c.y === at.y && c.z === at.z))) {
        issues.push({ code: 'object-overlap', message: `object '${objectType}' would overlap object '${entry.objectId}'`, at: anchor })
        return
      }
    }
    if (objectIsFloating(doc, reg, cells)) {
      issues.push({ code: 'floating-object', message: `object '${objectType}' has no support beneath`, at: anchor })
    }
  }

  for (const op of ops) {
    switch (op.kind) {
      case 'set-block':
        checkBlockCell(op.at, op.block)
        break
      case 'fill': {
        const [x0, x1] = [Math.min(op.from.x, op.to.x), Math.max(op.from.x, op.to.x)]
        const [y0, y1] = [Math.min(op.from.y, op.to.y), Math.max(op.from.y, op.to.y)]
        const [z0, z1] = [Math.min(op.from.z, op.to.z), Math.max(op.from.z, op.to.z)]
        for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) checkBlockCell({ x, y, z }, op.block)
        break
      }
      case 'place-object':
        checkObjectPlacement(op.objectType, op.anchor, op.rotation)
        break
      case 'move-object': {
        const object = doc.objects.find((o) => o.id === op.objectId)
        if (!object) {
          issues.push({ code: 'unknown-block', message: `object not found: '${op.objectId}'`, at: op.anchor })
          break
        }
        if (locked.has(object.id)) {
          issues.push({ code: 'locked-violation', message: `object '${object.id}' is locked`, at: object.anchor })
          break
        }
        checkObjectPlacement(object.objectType, op.anchor, object.rotation, object.id)
        break
      }
      case 'remove-object': {
        if (locked.has(op.objectId)) {
          const object = doc.objects.find((o) => o.id === op.objectId)
          issues.push({ code: 'locked-violation', message: `object '${op.objectId}' is locked`, at: object?.anchor })
        }
        break
      }
      case 'place-asset': {
        if (!assets) {
          const shape = placementShapeIssue({ assetId: op.assetId, anchor: [op.anchor.x, op.anchor.y, op.anchor.z], rotation: op.rotation, seed: op.seed ?? 0 }, op.assetId)
          if (shape) issues.push(shape)
          break
        }
        checkAssetPlacement(doc, reg, assets, op.assetId, op.anchor, op.rotation, undefined, issues)
        break
      }
      case 'move-asset': {
        const target = doc.assetPlacements?.find((p) => p.id === op.placementId)
        if (!target) {
          issues.push({ code: 'unknown-asset', message: `asset placement not found: '${op.placementId}'`, at: op.anchor })
          break
        }
        if (!assets) {
          if (!Number.isInteger(op.anchor.x) || !Number.isInteger(op.anchor.y) || !Number.isInteger(op.anchor.z)) {
            issues.push({ code: 'invalid-meta', message: `asset placement '${op.placementId}': anchor must be three integers`, at: op.anchor })
          }
          break
        }
        checkAssetPlacement(doc, reg, assets, target.assetId, op.anchor, op.rotation ?? target.rotation, target, issues)
        break
      }
      case 'remove-asset': {
        if (!doc.assetPlacements?.some((p) => p.id === op.placementId)) {
          issues.push({ code: 'unknown-asset', message: `asset placement not found: '${op.placementId}'` })
        }
        break
      }
    }
  }
  return issues
}

export function createValidator(registry?: BlockRegistry, assets?: AssetManifest): Validator {
  return {
    validateDocument: (doc) => validateDocument(doc, registry, assets),
    validateEdit: (doc, ops) => validateEdit(doc, ops, registry, assets),
  }
}
