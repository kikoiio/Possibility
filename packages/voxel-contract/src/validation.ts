import { getObjectTemplate } from './catalog'
import { rotatedOffsets } from './edits'
import { createBlockRegistry } from './registry'
import { getBlock, inBounds, parseSectionKey } from './sections'
import { AIR, SECTION_SIZE } from './sections'
import { STYLE_PRESETS } from './style'
import type {
  BlockRegistry, EditOperation, ValidationIssue, Validator, VoxelCoord, VoxelDocument,
} from './types'

/** 物体模板在某锚点与旋转下的占据格（与世界坐标） */
export function objectFootprint(objectType: string, anchor: VoxelCoord, rotation: 0 | 90 | 180 | 270): VoxelCoord[] {
  const template = getObjectTemplate(objectType)
  if (!template) return []
  return rotatedOffsets(template.cells.map((c) => c.offset), rotation)
    .map((o) => ({ x: anchor.x + o.x, y: anchor.y + o.y, z: anchor.z + o.z }))
}

const cellKey = (at: VoxelCoord) => `${at.x},${at.y},${at.z}`

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

export function validateDocument(doc: VoxelDocument, registry?: BlockRegistry): ValidationIssue[] {
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
  return issues
}

export function validateEdit(doc: VoxelDocument, ops: EditOperation[], registry?: BlockRegistry): ValidationIssue[] {
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
    }
  }
  return issues
}

export function createValidator(registry?: BlockRegistry): Validator {
  return {
    validateDocument: (doc) => validateDocument(doc, registry),
    validateEdit: (doc, ops) => validateEdit(doc, ops, registry),
  }
}
