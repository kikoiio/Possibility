import { getObjectTemplate } from './catalog'
import { AIR, setBlockMut } from './sections'
import type {
  EditOperation, EditResult, SectionKey, VoxelCoord, VoxelDocument, VoxelObject, VoxelObjectCells,
} from './types'

let objectCounter = 0
function newObjectId(): string {
  objectCounter += 1
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  const rand = typeof cryptoApi?.randomUUID === 'function' ? cryptoApi.randomUUID().slice(0, 8) : `${Date.now()}`
  return `obj-${rand}-${objectCounter}`
}

/** 旋转模板偏移（绕 anchor 水平旋转），并归一化使 x/z 最小偏移为 0 */
export function rotatedOffsets(offsets: VoxelCoord[], rotation: 0 | 90 | 180 | 270): VoxelCoord[] {
  const rotated = offsets.map(({ x, y, z }) => {
    switch (rotation) {
      case 90: return { x: -z, y, z: x }
      case 180: return { x: -x, y, z: -z }
      case 270: return { x: z, y, z: -x }
      default: return { x, y, z }
    }
  })
  const minX = Math.min(...rotated.map((o) => o.x))
  const minZ = Math.min(...rotated.map((o) => o.z))
  return rotated.map((o) => ({ x: o.x - minX, y: o.y, z: o.z - minZ }))
}

function templateCells(objectType: string, anchor: VoxelCoord, rotation: 0 | 90 | 180 | 270): Array<{ at: VoxelCoord; block: string }> {
  const template = getObjectTemplate(objectType)
  if (!template) throw new Error(`unknown object type: ${objectType}`)
  const offsets = rotatedOffsets(template.cells.map((c) => c.offset), rotation)
  return template.cells.map((c, i) => ({
    at: { x: anchor.x + offsets[i].x, y: anchor.y + offsets[i].y, z: anchor.z + offsets[i].z },
    block: c.block,
  }))
}

/** 不可变编辑应用：原文档不被修改，节采用写时复制 */
export function applyEdits(doc: VoxelDocument, ops: EditOperation[]): EditResult {
  const next: VoxelDocument = {
    ...doc,
    sections: { ...doc.sections },
    objects: [...doc.objects],
    objectCells: [...doc.objectCells],
    ...(doc.assetPlacements ? { assetPlacements: doc.assetPlacements.map((placement) => ({
      ...placement,
      anchor: [...placement.anchor] as [number, number, number],
    })) } : {}),
    locations: [...doc.locations],
    spaceEntries: [...doc.spaceEntries],
    lockedObjectIds: [...doc.lockedObjectIds],
  }
  const changed = new Set<SectionKey>()
  const affectedObjects = new Set<string>()

  const write = (at: VoxelCoord, block: string) => {
    for (const key of setBlockMut(next, at, block)) changed.add(key)
  }

  const brandObject = (object: VoxelObject): VoxelObjectCells => {
    const branded = templateCells(object.objectType, object.anchor, object.rotation)
    for (const { at, block } of branded) write(at, block)
    return { objectId: object.id, cells: branded.map((b) => b.at) }
  }

  const clearObjectCells = (objectId: string) => {
    const entry = next.objectCells.find((c) => c.objectId === objectId)
    if (!entry) return
    for (const at of entry.cells) write(at, AIR)
    next.objectCells = next.objectCells.filter((c) => c.objectId !== objectId)
  }

  for (const op of ops) {
    switch (op.kind) {
      case 'set-block': {
        write(op.at, op.block)
        break
      }
      case 'fill': {
        const [x0, x1] = [Math.min(op.from.x, op.to.x), Math.max(op.from.x, op.to.x)]
        const [y0, y1] = [Math.min(op.from.y, op.to.y), Math.max(op.from.y, op.to.y)]
        const [z0, z1] = [Math.min(op.from.z, op.to.z), Math.max(op.from.z, op.to.z)]
        for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) write({ x, y, z }, op.block)
        break
      }
      case 'place-object': {
        const object: VoxelObject = {
          id: op.objectId ?? newObjectId(),
          objectType: op.objectType,
          anchor: { ...op.anchor },
          rotation: op.rotation,
          ...(op.label ? { label: op.label } : {}),
        }
        const cells = brandObject(object)
        next.objects.push(object)
        next.objectCells.push(cells)
        affectedObjects.add(object.id)
        break
      }
      case 'move-object': {
        const object = next.objects.find((o) => o.id === op.objectId)
        if (!object) throw new Error(`object not found: ${op.objectId}`)
        clearObjectCells(object.id)
        const moved: VoxelObject = { ...object, anchor: { ...op.anchor } }
        next.objects = next.objects.map((o) => (o.id === object.id ? moved : o))
        next.objectCells.push(brandObject(moved))
        affectedObjects.add(object.id)
        break
      }
      case 'remove-object': {
        const object = next.objects.find((o) => o.id === op.objectId)
        if (!object) throw new Error(`object not found: ${op.objectId}`)
        clearObjectCells(object.id)
        next.objects = next.objects.filter((o) => o.id !== object.id)
        next.locations = next.locations.filter((l) => l.objectId !== object.id)
        next.lockedObjectIds = next.lockedObjectIds.filter((id) => id !== object.id)
        affectedObjects.add(object.id)
        break
      }
    }
  }

  return { document: next, changedSections: [...changed], affectedObjectIds: [...affectedObjects] }
}
