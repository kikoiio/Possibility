import { describe, expect, it } from 'vitest'
import { applyEdits } from '../src/edits'
import { createEmptyWorld, getBlock, setBlockMut } from '../src/sections'
import { serialize } from '../src/serialize'
import { applySceneRepairChangesToRaw, decodeSceneCompatibility } from '../src/scene-envelope'
import { repairSceneCompatibility } from '../src/scene-repair'
import { validateSceneEnvelope } from '../src/scene-validation'
import { byteCount } from '../src/scene-work'
import type { AssetManifest } from '../src/assets'
import type {
  SceneCompatibilityEnvelope,
  SceneValidationContext,
  SceneWorkBudget,
  SceneWorkControl,
} from '../src/scene-compatibility'
import type { SerializedVoxelDocument } from '../src/serialize'

const budget: SceneWorkBudget = {
  maxWorkUnits: 100_000,
  maxVisitedPerFlood: 10_000,
  maxCollectedIssues: 256,
  maxRepairCandidates: 256,
  maxRepairPasses: 3,
  maxWallMs: 10_000,
  maxWorkspaceBytes: 16 * 1024 * 1024,
  maxSerializedBytes: 10_000_000,
  maxSpaces: 8,
  maxRepairChanges: 64,
}
const control = (): SceneWorkControl => ({
  signal: new AbortController().signal,
  nowMs: () => Date.now(),
  yieldControl: async () => {},
})

const assets: AssetManifest = {
  version: 2,
  assets: {
    'dec-chair': {
      id: 'dec-chair', category: 'decoration', url: '/chair.glb', thumbnail: '/chair.png',
      footprint: [1, 1], height: 1, sway: 0,
    },
    'bld-house': {
      id: 'bld-house', category: 'building', url: '/house.glb', thumbnail: '/house.png',
      footprint: [1, 1], height: 1, sway: 0,
    },
  },
}

function context(protectedPlacements: string[] = []): SceneValidationContext {
  return {
    rulesVersion: 'test', assets,
    assetManifestHash: 'assets', templateCatalogHash: 'templates', bindingHash: 'bindings', contextFingerprint: 'context',
    bindings: {
      personIds: [], locations: [], protectedObjects: [],
      protectedPlacements: protectedPlacements.map((placementId) => ({ spaceId: 'single', placementId, reasons: ['test'] })),
      locationBindings: [], personBindings: [], entries: [],
    },
  }
}

function envelope(doc: ReturnType<typeof createEmptyWorld>): SceneCompatibilityEnvelope {
  const raw = JSON.parse(serialize(doc)) as SerializedVoxelDocument
  const decoded = decodeSceneCompatibility(raw)
  if (decoded.status !== 'ready') throw new Error('test envelope failed to decode')
  return decoded.envelope
}

function groundedDocument() {
  const doc = createEmptyWorld({ width: 4, height: 3, depth: 4 }, 'mist-manor', 'repair-test')
  for (let z = 0; z < 4; z += 1) for (let x = 0; x < 4; x += 1) setBlockMut(doc, { x, y: 0, z }, 'grass')
  return doc
}

describe('repairSceneCompatibility', () => {
  it('blocks a normalized candidate whose serialized bytes exceed the limit', async () => {
    const doc = groundedDocument()
    doc.assetPlacements = [{ id: 'legacy-chair', assetId: 'dec-chair', anchor: [2, 0, 2], rotation: 0, seed: 1 }]
    const raw = JSON.parse(serialize(doc)) as SerializedVoxelDocument
    const placement = raw.assetPlacements?.[0]
    if (!placement) throw new Error('test placement missing')
    delete (placement as unknown as { id?: string }).id
    const decoded = decodeSceneCompatibility(raw)
    expect(decoded.status).toBe('ready')
    if (decoded.status !== 'ready') return
    expect(decoded.envelope.compatibilityChanges.some(change => change.kind === 'assign-placement-id')).toBe(true)

    const serializedInputBytes = byteCount(raw)
    const validated = await validateSceneEnvelope(
      decoded.envelope,
      context(),
      { ...budget, maxSerializedBytes: serializedInputBytes },
      control(),
      'existing',
    )
    expect(validated.status).toBe('valid')
    const normalizedCandidate = applySceneRepairChangesToRaw(decoded.envelope.original, decoded.envelope.compatibilityChanges)
    expect('status' in normalizedCandidate).toBe(false)
    if ('status' in normalizedCandidate) return
    expect(byteCount(normalizedCandidate)).toBeGreaterThan(serializedInputBytes)

    const result = await repairSceneCompatibility(
      decoded.envelope,
      context(),
      { ...budget, maxSerializedBytes: serializedInputBytes },
      control(),
    )

    expect(result.status).toBe('blocked')
    expect(result.report).toMatchObject({ status: 'incomplete', countIsExact: false, stopReason: 'payload-limit' })
    expect(byteCount(raw)).toBe(serializedInputBytes)
  })

  it('also counts stable IDs after a semantic repair before returning a ready candidate', async () => {
    const doc = groundedDocument()
    doc.assetPlacements = [{ id: 'legacy-chair', assetId: 'dec-chair', anchor: [2, 0, 2], rotation: 0, seed: 1 }]
    doc.objects.push({ id: 'keeper', objectType: 'stone-lantern', anchor: { x: 2, y: 0, z: 2 }, rotation: 0 })
    doc.objectCells.push({ objectId: 'keeper', cells: [{ x: 2, y: 0, z: 2 }, { x: 2, y: 1, z: 2 }] })
    const raw = JSON.parse(serialize(doc)) as SerializedVoxelDocument
    const placement = raw.assetPlacements?.[0]
    if (!placement) throw new Error('test placement missing')
    delete (placement as unknown as { id?: string }).id
    const decoded = decodeSceneCompatibility(raw)
    expect(decoded.status).toBe('ready')
    if (decoded.status !== 'ready') return
    const serializedInputBytes = byteCount(raw)

    const planned = await repairSceneCompatibility(decoded.envelope, context(), budget, control())
    expect(planned.status).toBe('ready')
    if (planned.status !== 'ready') return
    expect(planned.changes.some(change => change.kind === 'assign-placement-id')).toBe(true)
    expect(planned.changes.some(change => change.kind === 'move-asset')).toBe(true)
    expect(byteCount(planned.candidate)).toBeGreaterThan(serializedInputBytes)

    const bounded = await repairSceneCompatibility(
      decoded.envelope,
      context(),
      { ...budget, maxSerializedBytes: serializedInputBytes },
      control(),
    )
    expect(bounded.status).toBe('blocked')
    expect(bounded.report).toMatchObject({ status: 'incomplete', countIsExact: false, stopReason: 'payload-limit' })
  })

  it('applies the candidate limit globally across placements and repair passes', async () => {
    const doc = createEmptyWorld({ width: 8, height: 3, depth: 8 }, 'mist-manor', 'global-candidate-limit')
    for (let z = 0; z < 8; z += 1) for (let x = 0; x < 8; x += 1) setBlockMut(doc, { x, y: 0, z }, 'grass')
    doc.assetPlacements = [
      { id: 'chair-a', assetId: 'dec-chair', anchor: [2, 0, 2], rotation: 0, seed: 1 },
      { id: 'chair-b', assetId: 'dec-chair', anchor: [6, 0, 6], rotation: 0, seed: 2 },
    ]
    for (const [id, at] of [['keeper-a', { x: 2, y: 0, z: 2 }], ['keeper-b', { x: 6, y: 0, z: 6 }]] as const) {
      doc.objects.push({ id, objectType: 'stone-lantern', anchor: at, rotation: 0 })
      doc.objectCells.push({ objectId: id, cells: [at, { ...at, y: 1 }] })
    }
    const source = envelope(doc)

    const exact = await repairSceneCompatibility(source, context(), { ...budget, maxRepairCandidates: 2 }, control())
    expect(exact.status).toBe('ready')
    if (exact.status !== 'ready') return
    expect(exact.changes.filter(change => change.kind === 'move-asset')).toHaveLength(2)
    expect(exact.report.status).toBe('valid')

    const over = await repairSceneCompatibility(source, context(), { ...budget, maxRepairCandidates: 1 }, control())
    expect(over.status).toBe('blocked')
    expect(over.report).toMatchObject({ status: 'incomplete', countIsExact: false, stopReason: 'attempt-limit' })
    expect(over.changes.filter(change => change.kind === 'move-asset')).toHaveLength(1)
  })

  it('stops at the independent 256 global candidate cap', async () => {
    const doc = createEmptyWorld({ width: 8, height: 3, depth: 8 }, 'mist-manor', 'candidate-cap-256')
    for (let z = 0; z < 8; z += 1) for (let x = 0; x < 8; x += 1) setBlockMut(doc, { x, y: 0, z }, 'grass')
    const center = { x: 4, y: 0, z: 4 }
    doc.assetPlacements = Array.from({ length: 11 }, (_, index) => ({
      id: `decor-${index}`, assetId: 'dec-chair', anchor: [center.x, center.y, center.z] as [number, number, number], rotation: 0 as const, seed: index,
    }))
    doc.objects.push({ id: 'keeper', objectType: 'stone-lantern', anchor: center, rotation: 0 })
    doc.objectCells.push({ objectId: 'keeper', cells: [center, { ...center, y: 1 }] })
    const blockedAnchors: Array<[number, number]> = []
    for (let radius = 1; radius <= 3; radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const remaining = radius - Math.abs(dx)
        for (const dz of remaining === 0 ? [0] : [-remaining, remaining]) blockedAnchors.push([center.x + dx, center.z + dz])
      }
    }
    doc.assetPlacements.push(...blockedAnchors.map(([x, z], index) => ({
      id: `blocker-${index}`, assetId: 'bld-house', anchor: [x, 0, z] as [number, number, number], rotation: 0 as const, seed: index,
    })))
    const source = envelope(doc)
    const capped = await repairSceneCompatibility(source, context(), { ...budget, maxRepairCandidates: 256, maxRepairPasses: 64 }, control())
    const oneMore = await repairSceneCompatibility(source, context(), { ...budget, maxRepairCandidates: 257, maxRepairPasses: 64 }, control())

    expect(capped.status).toBe('blocked')
    expect(capped.report).toMatchObject({ status: 'incomplete', countIsExact: false, stopReason: 'attempt-limit' })
    expect(oneMore.status).toBe('blocked')
    expect(oneMore.report).toMatchObject({ status: 'incomplete', countIsExact: false, stopReason: 'attempt-limit' })
    expect(oneMore.report.workUnitsUsed).toBeGreaterThan(capped.report.workUnitsUsed)
  })

  it('allows one repair pass to fix multiple independent defects', async () => {
    const doc = createEmptyWorld({ width: 12, height: 3, depth: 12 }, 'mist-manor', 'pass-cap-3')
    for (let z = 0; z < 12; z += 1) for (let x = 0; x < 12; x += 1) setBlockMut(doc, { x, y: 0, z }, 'grass')
    const anchors = [[2, 2], [9, 2], [2, 9], [9, 9]] as const
    doc.assetPlacements = anchors.map(([x, z], index) => ({
      id: `decor-${index}`, assetId: 'dec-chair', anchor: [x, 0, z] as [number, number, number], rotation: 0, seed: index,
    }))
    anchors.forEach(([x, z], index) => {
      const at = { x, y: 0, z }
      doc.objects.push({ id: `keeper-${index}`, objectType: 'stone-lantern', anchor: at, rotation: 0 })
      doc.objectCells.push({ objectId: `keeper-${index}`, cells: [at, { ...at, y: 1 }] })
    })
    const source = envelope(doc)
    const zero = await repairSceneCompatibility(source, context(), { ...budget, maxRepairPasses: 0 }, control())
    const one = await repairSceneCompatibility(source, context(), { ...budget, maxRepairPasses: 1 }, control())

    expect(zero.status).toBe('blocked')
    expect(zero.changes).toHaveLength(0)
    expect(zero.report.status).toBe('invalid')
    expect(one.status).toBe('ready')
    expect(one.changes.filter(change => change.kind === 'move-asset')).toHaveLength(4)
  })

  it('allows exactly 64 semantic repair changes and does not apply the 65th', async () => {
    const doc = createEmptyWorld({ width: 38, height: 3, depth: 34 }, 'mist-manor', 'change-cap-64')
    for (let z = 0; z < 34; z += 1) for (let x = 0; x < 38; x += 1) setBlockMut(doc, { x, y: 0, z }, 'grass')
    const collisions = Array.from({ length: 65 }, (_, index) => ({
      x: 2 + (index % 9) * 4,
      z: 2 + Math.floor(index / 9) * 4,
    }))
    doc.assetPlacements = collisions.map(({ x, z }, index) => ({
      id: `decor-${index}`, assetId: 'dec-chair', anchor: [x, 0, z] as [number, number, number], rotation: 0 as const, seed: index,
    }))
    collisions.forEach(({ x, z }, index) => {
      const at = { x, y: 0, z }
      const id = `keeper-${index}`
      doc.objects.push({ id, objectType: 'stone-lantern', anchor: at, rotation: 0 })
      doc.objectCells.push({ objectId: id, cells: [at, { ...at, y: 1 }] })
    })
    expect(collisions).toHaveLength(65)
    const source = envelope(doc)
    const capped = await repairSceneCompatibility(source, context(), { ...budget, maxRepairChanges: 64, maxRepairPasses: 1 }, control())
    const oneMore = await repairSceneCompatibility(source, context(), { ...budget, maxRepairChanges: 65, maxRepairPasses: 1 }, control())

    expect(capped.status).toBe('blocked')
    expect(capped.changes.filter(change => change.kind === 'move-asset')).toHaveLength(64)
    expect(capped.report.status).toBe('invalid')
    expect(oneMore.status).toBe('ready')
    expect(oneMore.changes.filter(change => change.kind === 'move-asset')).toHaveLength(65)
  })

  it('charges initial and candidate revalidation work to one repair-wide budget', async () => {
    const doc = groundedDocument()
    doc.assetPlacements = [{ id: 'chair', assetId: 'dec-chair', anchor: [1, 0, 1], rotation: 0, seed: 1 }]
    doc.objects.push({ id: 'keeper', objectType: 'stone-lantern', anchor: { x: 1, y: 0, z: 1 }, rotation: 0 })
    doc.objectCells.push({ objectId: 'keeper', cells: [{ x: 1, y: 0, z: 1 }, { x: 1, y: 1, z: 1 }] })
    const source = envelope(doc)
    const initial = await validateSceneEnvelope(source, context(), budget, control(), 'existing')
    expect(initial.status).toBe('invalid')

    const stopped = await repairSceneCompatibility(source, context(), {
      ...budget,
      maxRepairWorkUnits: initial.workUnitsUsed + 1,
    }, control())
    expect(stopped.status).toBe('blocked')
    expect(stopped.report).toMatchObject({ status: 'incomplete', countIsExact: false, stopReason: 'work-limit' })
    expect(stopped.report.workUnitsUsed).toBeGreaterThan(initial.workUnitsUsed)

    const completed = await repairSceneCompatibility(source, context(), budget, control())
    expect(completed.status).toBe('ready')
    expect(completed.report.workUnitsUsed).toBeGreaterThan(initial.workUnitsUsed)
  })

  it('moves a decorative asset deterministically and returns a ready raw candidate', async () => {
    const doc = groundedDocument()
    doc.assetPlacements = [{ id: 'chair', assetId: 'dec-chair', anchor: [1, 0, 1], rotation: 0, seed: 1 }]
    doc.objects.push({ id: 'keeper', objectType: 'stone-lantern', anchor: { x: 1, y: 0, z: 1 }, rotation: 0 })
    doc.objectCells.push({ objectId: 'keeper', cells: [{ x: 1, y: 0, z: 1 }, { x: 1, y: 1, z: 1 }] })
    const first = await repairSceneCompatibility(envelope(doc), context(), budget, control())
    const second = await repairSceneCompatibility(envelope(doc), context(), budget, control())

    expect(first.status).toBe('ready')
    expect(second.status).toBe('ready')
    if (first.status !== 'ready' || second.status !== 'ready') return
    expect(first.changes).toEqual(second.changes)
    expect(first.changes).toHaveLength(1)
    expect(first.changes[0].kind).toBe('move-asset')
    expect(first.report.status).toBe('valid')
    expect(first.report.issueCount).toBe(0)
    const placements = (first.candidate as SerializedVoxelDocument).assetPlacements
    expect(placements?.[0].id).toBe('chair')
    expect(placements?.[0].anchor).not.toEqual([1, 0, 1])
  })

  it('preserves exact bookshelf geometry while repairing a separate decorative collision', async () => {
    const doc = createEmptyWorld({ width: 8, height: 6, depth: 8 }, 'mist-manor', 'shelf-preservation')
    for (let z = 0; z < 8; z += 1) for (let x = 0; x < 8; x += 1) setBlockMut(doc, { x, y: 0, z }, 'grass')
    const placed = applyEdits(doc, [{ kind: 'place-object', objectId: 'bookshelf', objectType: 'bookshelf', anchor: { x: 4, y: 1, z: 4 }, rotation: 0 }])
    const original = placed.document
    const originalShelf = structuredClone(original.objects.find(object => object.id === 'bookshelf'))
    const originalShelfCells = structuredClone(original.objectCells.find(entry => entry.objectId === 'bookshelf'))
    original.assetPlacements = [{ id: 'overlapping-decoration', assetId: 'dec-chair', anchor: [1, 1, 1], rotation: 0, seed: 1 }]
    original.objects.push({ id: 'keeper', objectType: 'stone-lantern', anchor: { x: 1, y: 1, z: 1 }, rotation: 0 })
    original.objectCells.push({ objectId: 'keeper', cells: [{ x: 1, y: 1, z: 1 }, { x: 1, y: 2, z: 1 }] })
    const shelfBeforeRepair = structuredClone(original.objects.find(object => object.id === 'bookshelf'))
    const cellsBeforeRepair = structuredClone(original.objectCells.find(entry => entry.objectId === 'bookshelf'))
    const cavityBefore = getBlock(original, { x: 5, y: 2, z: 4 })
    const topBoardBefore = getBlock(original, { x: 5, y: 3, z: 4 })

    const result = await repairSceneCompatibility(envelope(original), context(), budget, control())

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.report.status).toBe('valid')
    const decoded = decodeSceneCompatibility(result.candidate)
    expect(decoded.status).toBe('ready')
    if (decoded.status !== 'ready') return
    const repaired = decoded.envelope.spaces[0].document
    expect(repaired.objects.find(object => object.id === 'bookshelf')).toEqual(shelfBeforeRepair)
    expect(repaired.objectCells.find(entry => entry.objectId === 'bookshelf')).toEqual(cellsBeforeRepair)
    expect(getBlock(repaired, { x: 5, y: 2, z: 4 })).toBe(cavityBefore)
    expect(getBlock(repaired, { x: 5, y: 3, z: 4 })).toBe(topBoardBefore)
    expect(originalShelf).toEqual(shelfBeforeRepair)
    expect(originalShelfCells).toEqual(cellsBeforeRepair)
    expect(result.changes.some(change => change.kind === 'set-block' && change.at.x === 5 && change.at.y === 3 && change.at.z === 4)).toBe(false)
  })

  it('does not move or remove a protected placement', async () => {
    const doc = groundedDocument()
    doc.assetPlacements = [{ id: 'protected', assetId: 'dec-chair', anchor: [1, 0, 1], rotation: 0, seed: 1 }]
    doc.objects.push({ id: 'keeper', objectType: 'stone-lantern', anchor: { x: 1, y: 0, z: 1 }, rotation: 0 })
    doc.objectCells.push({ objectId: 'keeper', cells: [{ x: 1, y: 0, z: 1 }, { x: 1, y: 1, z: 1 }] })
    const result = await repairSceneCompatibility(envelope(doc), context(['protected']), budget, control())

    expect(result.status).toBe('blocked')
    expect(result.changes).toHaveLength(0)
    expect(result.report.issues.some((issue) => issue.placementId === 'protected')).toBe(true)
  })

  it('blocks unsafe building repairs instead of removing a semantic asset', async () => {
    const doc = groundedDocument()
    doc.assetPlacements = [{ id: 'house', assetId: 'bld-house', anchor: [1, 0, 1], rotation: 0, seed: 1 }]
    doc.objects.push({ id: 'keeper', objectType: 'stone-lantern', anchor: { x: 1, y: 0, z: 1 }, rotation: 0 })
    doc.objectCells.push({ objectId: 'keeper', cells: [{ x: 1, y: 0, z: 1 }, { x: 1, y: 1, z: 1 }] })
    const result = await repairSceneCompatibility(envelope(doc), context(), budget, control())

    expect(result.status).toBe('blocked')
    expect(result.changes).toHaveLength(0)
    expect(result.report.status).toBe('invalid')
  })

  it('tries horizontal Manhattan locations in dx/dz order and preserves placement attributes', async () => {
    const doc = groundedDocument()
    doc.assetPlacements = [{ id: 'chair', assetId: 'dec-chair', anchor: [2, 0, 2], rotation: 2, seed: 77 }]
    doc.objects.push({ id: 'keeper', objectType: 'stone-lantern', anchor: { x: 2, y: 0, z: 2 }, rotation: 0 })
    doc.objectCells.push({ objectId: 'keeper', cells: [{ x: 2, y: 0, z: 2 }, { x: 2, y: 1, z: 2 }] })
    const result = await repairSceneCompatibility(envelope(doc), context(), budget, control())
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.changes[0]).toMatchObject({ kind: 'move-asset', from: { x: 2, y: 0, z: 2 }, to: { x: 1, y: 0, z: 2 } })
    expect((result.candidate as SerializedVoxelDocument).assetPlacements?.[0]).toMatchObject({ id: 'chair', rotation: 2, seed: 77, anchor: [1, 0, 2] })
  })

  it('continues through all distance-1 anchors before choosing a safe distance-2 anchor', async () => {
    const doc = createEmptyWorld({ width: 8, height: 3, depth: 8 }, 'mist-manor', 'repair-distance-2')
    for (let z = 0; z < 8; z += 1) for (let x = 0; x < 8; x += 1) setBlockMut(doc, { x, y: 0, z }, 'grass')
    doc.assetPlacements = [{ id: 'chair', assetId: 'dec-chair', anchor: [2, 0, 2], rotation: 0, seed: 3 }]
    const occupied = [
      { id: 'center', at: { x: 2, y: 0, z: 2 } },
      { id: 'west', at: { x: 1, y: 0, z: 2 } },
      { id: 'north', at: { x: 2, y: 0, z: 1 } },
      { id: 'south', at: { x: 2, y: 0, z: 3 } },
      { id: 'east', at: { x: 3, y: 0, z: 2 } },
    ]
    for (const item of occupied) {
      doc.objects.push({ id: item.id, objectType: 'stone-lantern', anchor: item.at, rotation: 0 })
      doc.objectCells.push({ objectId: item.id, cells: [item.at, { ...item.at, y: item.at.y + 1 }] })
    }
    const result = await repairSceneCompatibility(envelope(doc), context(), budget, control())
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.changes[0]).toMatchObject({ kind: 'move-asset', from: { x: 2, y: 0, z: 2 }, to: { x: 0, y: 0, z: 2 } })
    expect(result.report.status).toBe('valid')
  })

  it('rejects a candidate that would introduce a new collision and uses the next safe anchor', async () => {
    const doc = groundedDocument()
    doc.assetPlacements = [
      { id: 'chair', assetId: 'dec-chair', anchor: [2, 0, 2], rotation: 0, seed: 3 },
      { id: 'neighbor', assetId: 'dec-chair', anchor: [1, 0, 2], rotation: 0, seed: 4 },
    ]
    doc.objects.push({ id: 'keeper', objectType: 'stone-lantern', anchor: { x: 2, y: 0, z: 2 }, rotation: 0 })
    doc.objectCells.push({ objectId: 'keeper', cells: [{ x: 2, y: 0, z: 2 }, { x: 2, y: 1, z: 2 }] })
    const result = await repairSceneCompatibility(envelope(doc), context(), budget, control())
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.changes[0]).toMatchObject({ kind: 'move-asset', placementId: 'chair', to: { x: 2, y: 0, z: 1 } })
    expect(result.report.status).toBe('valid')
    expect(result.report.issueCount).toBe(0)
  })

  it('tries no more than the 24 horizontal Manhattan anchors through radius 3 before safe removal', async () => {
    const doc = createEmptyWorld({ width: 16, height: 3, depth: 16 }, 'mist-manor', 'repair-radius-3-cap')
    for (let z = 0; z < 16; z += 1) for (let x = 0; x < 16; x += 1) setBlockMut(doc, { x, y: 0, z }, 'grass')
    const center = { x: 8, y: 0, z: 8 }
    doc.assetPlacements = [{ id: 'chair', assetId: 'dec-chair', anchor: [8, 0, 8], rotation: 0, seed: 9 }]
    const occupied: Array<{ x: number; y: number; z: number }> = [center]
    for (let radius = 1; radius <= 3; radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const remaining = radius - Math.abs(dx)
        for (const dz of remaining === 0 ? [0] : [-remaining, remaining]) {
          if (radius === 0 && dx === 0 && dz === 0) continue
          occupied.push({ x: center.x + dx, y: 0, z: center.z + dz })
        }
      }
    }
    for (let i = 0; i < occupied.length; i += 1) {
      const at = occupied[i]
      const id = `blocker-${i}`
      doc.objects.push({ id, objectType: 'stone-lantern', anchor: at, rotation: 0 })
      doc.objectCells.push({ objectId: id, cells: [at, { ...at, y: at.y + 1 }] })
    }
    const result = await repairSceneCompatibility(envelope(doc), context(), budget, control())
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.changes).toContainEqual(expect.objectContaining({ kind: 'remove-asset', placementId: 'chair' }))
    expect(result.changes.some(change => change.kind === 'move-asset' && change.placementId === 'chair')).toBe(false)
    expect(result.report.status).toBe('valid')
  })

  it('clears only a safe walk-clearance head cell and protects entry support', async () => {
    const doc = groundedDocument()
    setBlockMut(doc, { x: 1, y: 2, z: 1 }, 'stone')
    const result = await repairSceneCompatibility(envelope(doc), context(), budget, control())
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.changes).toContainEqual(expect.objectContaining({ kind: 'set-block', at: { x: 1, y: 2, z: 1 }, fromBlock: 'stone', toBlock: 'air' }))
    const decoded = decodeSceneCompatibility(result.candidate as SerializedVoxelDocument)
    expect(decoded.status).toBe('ready')
    if (decoded.status === 'ready') expect(getBlock(decoded.envelope.spaces[0].document, { x: 1, y: 2, z: 1 })).toBe('air')

    const protectedContext = context()
    protectedContext.bindings.entries.push({ fromSpaceId: 'single', at: { x: 1, y: 1, z: 1 }, toSpaceId: 'elsewhere' })
    const protectedDoc = groundedDocument()
    setBlockMut(protectedDoc, { x: 1, y: 2, z: 1 }, 'stone')
    const blocked = await repairSceneCompatibility(envelope(protectedDoc), protectedContext, budget, control())
    expect(blocked.status).toBe('blocked')
    expect(blocked.changes).toHaveLength(0)

    const objectOccupied = groundedDocument()
    setBlockMut(objectOccupied, { x: 1, y: 2, z: 1 }, 'stone')
    objectOccupied.objects.push({ id: 'occupant', objectType: 'stone-lantern', anchor: { x: 1, y: 2, z: 1 }, rotation: 0 })
    objectOccupied.objectCells.push({ objectId: 'occupant', cells: [{ x: 1, y: 2, z: 1 }] })
    const objectBlocked = await repairSceneCompatibility(envelope(objectOccupied), context(), budget, control())
    expect(objectBlocked.status).toBe('blocked')
    expect(objectBlocked.changes.some((change) => change.kind === 'set-block')).toBe(false)

    const assetOccupied = groundedDocument()
    setBlockMut(assetOccupied, { x: 1, y: 2, z: 1 }, 'stone')
    assetOccupied.assetPlacements = [{ id: 'head-asset', assetId: 'dec-chair', anchor: [1, 1, 1], rotation: 0, seed: 2 }]
    const assetContext = context()
    assetContext.assets.assets['dec-chair'].height = 2
    const assetBlocked = await repairSceneCompatibility(envelope(assetOccupied), assetContext, budget, control())
    expect(assetBlocked.status).toBe('blocked')
    expect(assetBlocked.changes.some((change) => change.kind === 'set-block')).toBe(false)
  })

  it('does not clear headroom above locked or semantically bound objects', async () => {
    for (const protect of ['locked', 'location'] as const) {
      const doc = groundedDocument()
      setBlockMut(doc, { x: 1, y: 2, z: 1 }, 'stone')
      doc.objects.push({ id: 'bound-carrier', objectType: 'stone-lantern', anchor: { x: 1, y: 1, z: 1 }, rotation: 0 })
      doc.objectCells.push({ objectId: 'bound-carrier', cells: [{ x: 1, y: 1, z: 1 }] })
      if (protect === 'locked') doc.lockedObjectIds = ['bound-carrier']
      const bound = context()
      if (protect === 'location') bound.bindings.locationBindings.push({
        spaceId: 'single', carrierId: 'bound-carrier', location: { name: '门厅' },
      })
      const result = await repairSceneCompatibility(envelope(doc), bound, budget, control())
      expect(result.status).toBe('blocked')
      expect(result.changes.some(change => change.kind === 'set-block' && change.at.x === 1 && change.at.y === 2 && change.at.z === 1)).toBe(false)
    }
  })

  it('never repairs furniture-internal clearance coordinates', async () => {
    const doc = groundedDocument()
    doc.objects.push({ id: 'shelf', objectType: 'bookshelf', anchor: { x: 1, y: 1, z: 1 }, rotation: 0 })
    doc.objectCells.push({ objectId: 'shelf', cells: [
      { x: 1, y: 1, z: 1 }, { x: 2, y: 1, z: 1 }, { x: 3, y: 1, z: 1 },
      { x: 1, y: 2, z: 1 }, { x: 3, y: 2, z: 1 },
      { x: 1, y: 3, z: 1 }, { x: 2, y: 3, z: 1 }, { x: 3, y: 3, z: 1 },
    ] })
    for (const cell of doc.objectCells[0].cells) setBlockMut(doc, cell, 'wood-plank')
    const result = await repairSceneCompatibility(envelope(doc), context(), budget, control())
    expect(result.changes.some((change) => change.kind === 'set-block')).toBe(false)
  })

  it('blocks a candidate that cannot strictly reduce the issue count', async () => {
    const doc = groundedDocument()
    doc.assetPlacements = [{ id: 'chair', assetId: 'dec-chair', anchor: [1, 0, 1], rotation: 0, seed: 1 }]
    doc.objects.push({ id: 'one', objectType: 'stone-lantern', anchor: { x: 1, y: 0, z: 1 }, rotation: 0 })
    doc.objectCells.push({ objectId: 'one', cells: [{ x: 1, y: 0, z: 1 }, { x: 1, y: 1, z: 1 }] })
    doc.objects.push({ id: 'two', objectType: 'stone-lantern', anchor: { x: 0, y: 0, z: 0 }, rotation: 0 })
    doc.objectCells.push({ objectId: 'two', cells: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }] })
    doc.locations.push({ name: 'keeper', objectId: 'chair' })
    const result = await repairSceneCompatibility(envelope(doc), context(), { ...budget, maxRepairChanges: 0 }, control())

    expect(result.status).toBe('blocked')
    expect(result.changes).toHaveLength(0)
  })
})
