import { describe, expect, it } from 'vitest'
import {
  applyEdits, createEmptyWorld, setBlockMut,
} from '../src'
import { validateSceneEnvelope } from '../src/scene-validation'
import type { SceneCompatibilityEnvelope, SceneValidationContext, SceneWorkBudget, SceneWorkControl } from '../src/scene-compatibility'
import type { SerializedVoxelDocument } from '../src/serialize'
import { serialize } from '../src/serialize'

const at = (x: number, y: number, z: number) => ({ x, y, z })
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
}
const control = (): SceneWorkControl => ({ signal: new AbortController().signal, nowMs: () => Date.now(), yieldControl: async () => {} })

function document(id: string) {
  const doc = createEmptyWorld({ width: 8, height: 6, depth: 8 }, 'mist-manor', id)
  for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) setBlockMut(doc, at(x, 0, z), 'grass')
  return doc
}

function context(): SceneValidationContext {
  return {
    rulesVersion: 'test',
    assets: { version: 2, assets: {} },
    assetManifestHash: 'assets',
    templateCatalogHash: 'templates',
    bindingHash: 'bindings',
    contextFingerprint: 'context',
    bindings: {
      personIds: [], locations: [], protectedObjects: [], protectedPlacements: [],
      locationBindings: [], personBindings: [], entries: [],
    },
  }
}

function envelope(documents: Array<[string, ReturnType<typeof document>]>): SceneCompatibilityEnvelope {
  const spaces = documents.map(([spaceId, doc]) => ({ spaceId, document: doc }))
  const rawSpaces = spaces.map(({ spaceId, document: doc }) => ({ id: spaceId, name: spaceId, document: JSON.parse(serialize(doc)) as SerializedVoxelDocument }))
  return {
    original: { format: 'voxel-spaces', version: 1, defaultSpaceId: spaces[0].spaceId, spaces: rawSpaces },
    spaces,
    format: 'spaces',
    compatibilityChanges: [],
  }
}

describe('validateSceneEnvelope', () => {
  it('validates every space and reports a defect in an otherwise untouched space', async () => {
    const good = document('good')
    const bad = applyEdits(document('bad'), [{ kind: 'place-object', objectType: 'stone-lantern', anchor: at(3, 4, 3), rotation: 0, objectId: 'floating' }]).document
    const report = await validateSceneEnvelope(envelope([['good', good], ['bad', bad]]), context(), budget, control())
    expect(report.status).toBe('invalid')
    expect(report.checkedSpaceIds).toEqual(['good', 'bad'])
    expect(report.issues.some((issue) => issue.spaceId === 'bad' && issue.code === 'floating-object')).toBe(true)
    expect(report.issueCount).toBe(report.issues.length)
    expect(report.countIsExact).toBe(true)
  })

  it('keeps issue counting exact while furniture notes remain non-blocking', async () => {
    const doc = applyEdits(document('books'), [{ kind: 'place-object', objectType: 'bookshelf', anchor: at(2, 1, 2), rotation: 0, objectId: 'shelf' }]).document
    const report = await validateSceneEnvelope(envelope([['books', doc]]), context(), budget, control())
    expect(report.ruleNotes.items.some((note) => note.code === 'furniture-cavity' && note.objectId === 'shelf')).toBe(true)
    expect(report.issues.every((issue) => issue.blocking)).toBe(true)
    expect(report.issueCount).toBe(report.issues.length)
  })

  it('returns incomplete with pending spaces when the work budget stops traversal', async () => {
    const tiny = { ...budget, maxWorkUnits: 1 }
    const report = await validateSceneEnvelope(envelope([['one', document('one')], ['two', document('two')]]), context(), tiny, control())
    expect(report.status).toBe('incomplete')
    expect(report.countIsExact).toBe(false)
    expect(report.stopReason).toBe('work-limit')
    expect(report.pendingSpaceIds.length).toBeGreaterThan(0)
  })

  it('returns incomplete on cancellation even when no issue has been found', async () => {
    const controller = new AbortController()
    controller.abort()
    const report = await validateSceneEnvelope(envelope([['one', document('one')]]), context(), budget, {
      signal: controller.signal, nowMs: () => Date.now(), yieldControl: async () => {},
    })
    expect(report.status).toBe('incomplete')
    expect(report.stopReason).toBe('cancelled')
    expect(report.countIsExact).toBe(false)
  })
})
