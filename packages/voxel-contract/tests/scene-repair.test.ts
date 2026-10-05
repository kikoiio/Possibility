import { describe, expect, it } from 'vitest'
import { createEmptyWorld, setBlockMut } from '../src/sections'
import { serialize } from '../src/serialize'
import { decodeSceneCompatibility } from '../src/scene-envelope'
import { repairSceneCompatibility } from '../src/scene-repair'
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

  it('blocks a candidate that cannot strictly reduce the issue count', async () => {
    const doc = groundedDocument()
    doc.assetPlacements = [{ id: 'chair', assetId: 'dec-chair', anchor: [1, 0, 1], rotation: 0, seed: 1 }]
    doc.objects.push({ id: 'one', objectType: 'stone-lantern', anchor: { x: 1, y: 0, z: 1 }, rotation: 0 })
    doc.objectCells.push({ objectId: 'one', cells: [{ x: 1, y: 0, z: 1 }, { x: 1, y: 1, z: 1 }] })
    doc.objects.push({ id: 'two', objectType: 'stone-lantern', anchor: { x: 0, y: 0, z: 0 }, rotation: 0 })
    doc.objectCells.push({ objectId: 'two', cells: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }] })
    doc.locations.push({ name: 'keeper', objectId: 'chair' })
    const result = await repairSceneCompatibility(envelope(doc), context(), { ...budget, maxRepairCandidates: 1 }, control())

    expect(result.status).toBe('blocked')
    expect(result.changes).toHaveLength(0)
  })
})
