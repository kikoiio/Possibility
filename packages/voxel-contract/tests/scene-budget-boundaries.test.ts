import { describe, expect, it } from 'vitest'
import { createEmptyWorld, setBlockMut } from '../src/sections'
import type { AssetManifest } from '../src/assets'
import { serialize } from '../src/serialize'
import type { SerializedVoxelDocument } from '../src/serialize'
import { decodeSceneCompatibility } from '../src/scene-envelope'
import { repairSceneCompatibility } from '../src/scene-repair'
import { validateSceneEnvelope } from '../src/scene-validation'
import { createBlockRegistry } from '../src/registry'
import { validateWalkabilityWithStatsAsync } from '../src/walkability'
import type {
  SceneCompatibilityEnvelope,
  SceneValidationContext,
  SceneWorkBudget,
  SceneWorkControl,
} from '../src/scene-compatibility'
import { createSceneWorkCounter, DEFAULT_SCENE_BUDGET } from '../src/scene-work'

const control = (): SceneWorkControl => ({
  signal: new AbortController().signal,
  nowMs: () => Date.now(),
  yieldControl: async () => {},
})

const budget: SceneWorkBudget = {
  maxWorkUnits: 1_000_000,
  maxVisitedPerFlood: 200_000,
  maxCollectedIssues: 256,
  maxRepairCandidates: 256,
  maxRepairPasses: 3,
  maxWallMs: 10_000,
  maxWorkspaceBytes: 16 * 1024 * 1024,
  maxSerializedBytes: 1_500_000,
  maxSpaces: 8,
  maxRepairChanges: 64,
  maxRepairWorkUnits: 48_000_000,
  maxDraftWallMs: 10_000,
}

const assets: AssetManifest = {
  version: 2,
  assets: {
    'dec-chair': {
      id: 'dec-chair', category: 'decoration', url: '/chair.glb', thumbnail: '/chair.png',
      footprint: [1, 1], height: 1, sway: 0,
    },
  },
}

function context(): SceneValidationContext {
  return {
    rulesVersion: 'test', assets,
    assetManifestHash: 'assets', templateCatalogHash: 'templates', bindingHash: 'bindings', contextFingerprint: 'context',
    bindings: {
      personIds: [], locations: [], protectedObjects: [], protectedPlacements: [],
      locationBindings: [], personBindings: [], entries: [],
    },
  }
}

function groundedWorld(id: string) {
  const document = createEmptyWorld({ width: 8, height: 4, depth: 8 }, 'mist-manor', id)
  for (let z = 0; z < 8; z += 1) for (let x = 0; x < 8; x += 1) {
    setBlockMut(document, { x, y: 0, z }, 'grass')
  }
  return document
}

function envelopeFrom(document: ReturnType<typeof groundedWorld>): SceneCompatibilityEnvelope {
  const raw = JSON.parse(serialize(document)) as SerializedVoxelDocument
  const decoded = decodeSceneCompatibility(raw)
  if (decoded.status !== 'ready') throw new Error('test world failed to decode')
  return decoded.envelope
}

function collidingEnvelope(): SceneCompatibilityEnvelope {
  const document = groundedWorld('repair-work-boundary')
  const at = { x: 3, y: 0, z: 3 }
  document.assetPlacements = [{ id: 'chair', assetId: 'dec-chair', anchor: [3, 0, 3], rotation: 0, seed: 1 }]
  document.objects.push({ id: 'keeper', objectType: 'stone-lantern', anchor: at, rotation: 0 })
  document.objectCells.push({ objectId: 'keeper', cells: [at, { ...at, y: 1 }] })
  return envelopeFrom(document)
}

describe('scene budget exact boundaries', () => {
  it('pins the approved numeric budgets and accepts exactly each independent inspection limit', () => {
    expect(DEFAULT_SCENE_BUDGET).toMatchObject({
      maxWorkUnits: 12_000_000,
      maxVisitedPerFlood: 200_000,
      maxWorkspaceBytes: 16 * 1024 * 1024,
      maxRepairWorkUnits: 48_000_000,
      maxRepairCandidates: 256,
      maxRepairPasses: 3,
      maxRepairChanges: 64,
    })

    const atWorkLimit = createSceneWorkCounter({
      budget: { maxWorkUnits: DEFAULT_SCENE_BUDGET.maxWorkUnits },
      nowMs: () => 0,
    })
    expect(atWorkLimit.work(DEFAULT_SCENE_BUDGET.maxWorkUnits)).toBe(true)
    expect(atWorkLimit.work(1)).toBe(false)
    expect(atWorkLimit.stopReason).toBe('work-limit')

    const atVisitLimit = createSceneWorkCounter({
      budget: { maxVisitedPerFlood: DEFAULT_SCENE_BUDGET.maxVisitedPerFlood },
      nowMs: () => 0,
    })
    expect(atVisitLimit.visit(DEFAULT_SCENE_BUDGET.maxVisitedPerFlood)).toBe(true)
    expect(atVisitLimit.visit(1)).toBe(false)
    expect(atVisitLimit.stopReason).toBe('visit-limit')

    const atWorkspaceLimit = createSceneWorkCounter({
      budget: { maxWorkspaceBytes: DEFAULT_SCENE_BUDGET.maxWorkspaceBytes },
      nowMs: () => 0,
    })
    expect(atWorkspaceLimit.addWorkspaceBytes(DEFAULT_SCENE_BUDGET.maxWorkspaceBytes)).toBe(true)
    expect(atWorkspaceLimit.addWorkspaceBytes(1)).toBe(false)
    expect(atWorkspaceLimit.stopReason).toBe('workspace-limit')
  })

  it('allows a full validation exactly at its measured work, visit, and workspace limits', async () => {
    const source = envelopeFrom(groundedWorld('validation-budget-boundary'))
    const validationContext = context()
    const baseline = await validateSceneEnvelope(source, validationContext, budget, control())
    expect(baseline.status).not.toBe('incomplete')
    expect(baseline.countIsExact).toBe(true)
    expect(baseline.workUnitsUsed).toBeGreaterThan(0)
    expect(baseline.workspaceBytesUsed).toBeGreaterThan(0)

    const walking = await validateWalkabilityWithStatsAsync(
      source.spaces[0].document,
      createBlockRegistry(source.spaces[0].document.theme),
      { maxVisited: budget.maxVisitedPerFlood, maxWorkspaceBytes: budget.maxWorkspaceBytes },
      control(),
    )
    expect(walking.complete).toBe(true)
    const exactVisitedLimit = Math.max(walking.floods.withGaps.visited, walking.floods.strict.visited)
    expect(exactVisitedLimit).toBeGreaterThan(0)

    const exact = await validateSceneEnvelope(source, validationContext, {
      ...budget,
      maxWorkUnits: baseline.workUnitsUsed,
      maxVisitedPerFlood: exactVisitedLimit,
      maxWorkspaceBytes: baseline.workspaceBytesUsed!,
    }, control())
    expect(exact.status).not.toBe('incomplete')
    expect(exact.countIsExact).toBe(true)
    expect(exact.stopReason).toBeNull()

    const workOver = await validateSceneEnvelope(source, validationContext, {
      ...budget, maxWorkUnits: baseline.workUnitsUsed - 1,
    }, control())
    expect(workOver.status).toBe('incomplete')
    expect(workOver.countIsExact).toBe(false)
    expect(workOver.stopReason).toBe('work-limit')

    const visitOver = await validateSceneEnvelope(source, validationContext, {
      ...budget, maxVisitedPerFlood: exactVisitedLimit - 1,
    }, control())
    expect(visitOver.status).toBe('incomplete')
    expect(visitOver.countIsExact).toBe(false)
    expect(visitOver.stopReason).toBe('visit-limit')

    const workspaceOver = await validateSceneEnvelope(source, validationContext, {
      ...budget, maxWorkspaceBytes: baseline.workspaceBytesUsed! - 1,
    }, control())
    expect(workspaceOver.status).toBe('incomplete')
    expect(workspaceOver.countIsExact).toBe(false)
    expect(workspaceOver.stopReason).toBe('workspace-limit')
  })

  it('allows repair exactly at the aggregate work cap and blocks one unit below it', async () => {
    const source = collidingEnvelope()
    const validationContext = context()
    const baseline = await repairSceneCompatibility(source, validationContext, budget, control())
    expect(baseline.status).toBe('ready')
    expect(baseline.report.workUnitsUsed).toBeGreaterThan(0)

    const exact = await repairSceneCompatibility(source, validationContext, {
      ...budget, maxRepairWorkUnits: baseline.report.workUnitsUsed,
    }, control())
    expect(exact.status).toBe('ready')
    expect(exact.report.workUnitsUsed).toBe(baseline.report.workUnitsUsed)

    const oneBelow = await repairSceneCompatibility(source, validationContext, {
      ...budget, maxRepairWorkUnits: baseline.report.workUnitsUsed - 1,
    }, control())
    expect(oneBelow.status).toBe('blocked')
    expect(oneBelow.report.status).toBe('incomplete')
    expect(oneBelow.report.countIsExact).toBe(false)
    expect(oneBelow.report.stopReason).toBe('work-limit')
  })

  it('repairs three independent clearance cells in three passes and needs a fourth pass for the last one', async () => {
    const document = groundedWorld('repair-pass-boundary')
    const headCells = [
      { x: 1, y: 2, z: 1 },
      { x: 3, y: 2, z: 1 },
      { x: 5, y: 2, z: 1 },
      { x: 1, y: 2, z: 5 },
    ]
    for (const at of headCells) setBlockMut(document, at, 'stone')
    const source = envelopeFrom(document)
    const validationContext = context()

    const threePasses = await repairSceneCompatibility(source, validationContext, {
      ...budget, maxRepairPasses: 3,
    }, control())
    expect(threePasses.status).toBe('blocked')
    expect(threePasses.changes.filter(change => change.kind === 'set-block')).toHaveLength(3)
    expect(threePasses.report).toMatchObject({ status: 'invalid', countIsExact: true, issueCount: 1 })

    const fourPasses = await repairSceneCompatibility(source, validationContext, {
      ...budget, maxRepairPasses: 4,
    }, control())
    expect(fourPasses.status).toBe('ready')
    expect(fourPasses.changes.filter(change => change.kind === 'set-block')).toHaveLength(4)
    expect(fourPasses.report).toMatchObject({ status: 'valid', countIsExact: true, issueCount: 0 })
  })
})
