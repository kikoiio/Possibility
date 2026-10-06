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
    expect(report.ruleNotes.items.find((note) => note.code === 'furniture-cavity' && note.objectId === 'shelf')?.at).toEqual(at(3, 2, 2))
    expect(report.issues.some((issue) => issue.code === 'walk-clearance' && issue.at?.x === 3 && issue.at.y === 2 && issue.at.z === 2)).toBe(false)
    expect(report.issues.every((issue) => issue.blocking)).toBe(true)
    expect(report.issueCount).toBe(report.issues.length)
  })

  it('rotates the verified furniture-cavity classification with the same bookshelf template', async () => {
    const doc = applyEdits(document('rotated-books'), [{ kind: 'place-object', objectType: 'bookshelf', anchor: at(2, 1, 2), rotation: 90, objectId: 'rotated-shelf' }]).document
    const report = await validateSceneEnvelope(envelope([['books', doc]]), context(), budget, control())
    expect(report.ruleNotes.items).toContainEqual(expect.objectContaining({
      code: 'furniture-cavity', spaceId: 'books', objectId: 'rotated-shelf', at: at(2, 2, 3),
    }))
    expect(report.issues.some((issue) => issue.code === 'walk-clearance' && issue.at?.x === 2 && issue.at.y === 2 && issue.at.z === 3)).toBe(false)
  })

  it('does not grant furniture clearance for a fake label or mismatched template shape', async () => {
    const labeledBench = applyEdits(document('labeled-bench'), [{ kind: 'place-object', objectType: 'bookshelf', anchor: at(2, 1, 2), rotation: 0, objectId: 'object-a' }]).document
    labeledBench.objects[0].objectType = 'bench'
    labeledBench.objects[0].label = 'bookshelf'
    const fakeLabelReport = await validateSceneEnvelope(envelope([['books', labeledBench]]), context(), budget, control())
    expect(fakeLabelReport.ruleNotes.items.some((note) => note.code === 'furniture-cavity')).toBe(false)
    expect(fakeLabelReport.issues).toContainEqual(expect.objectContaining({ code: 'walk-clearance', spaceId: 'books', at: at(3, 2, 2) }))

    const mismatched = applyEdits(document('mismatched-shelf'), [{ kind: 'place-object', objectType: 'bookshelf', anchor: at(2, 1, 2), rotation: 0, objectId: 'object-b' }]).document
    mismatched.objectCells[0].cells.pop()
    const mismatchedReport = await validateSceneEnvelope(envelope([['books', mismatched]]), context(), budget, control())
    expect(mismatchedReport.ruleNotes.items.some((note) => note.code === 'furniture-cavity')).toBe(false)
    expect(mismatchedReport.issues).toContainEqual(expect.objectContaining({ code: 'walk-clearance', spaceId: 'books', at: at(3, 2, 2) }))
  })

  it('does not exempt a verified furniture cavity when a declared entry targets that cell', async () => {
    const doc = applyEdits(document('entry-in-shelf'), [{ kind: 'place-object', objectType: 'bookshelf', anchor: at(2, 1, 2), rotation: 0, objectId: 'shelf' }]).document
    const access = context()
    access.bindings.entries.push({ fromSpaceId: 'books', toSpaceId: 'missing-target', at: at(3, 2, 2) })
    const report = await validateSceneEnvelope(envelope([['books', doc]]), access, budget, control())
    expect(report.ruleNotes.items).toContainEqual(expect.objectContaining({ code: 'furniture-cavity', at: at(3, 2, 2) }))
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'walk-clearance', spaceId: 'books', at: at(3, 2, 2) }))
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'connection-invalid', spaceId: 'books', at: at(3, 2, 2) }))
  })

  it('returns incomplete with pending spaces when the work budget stops traversal', async () => {
    const tiny = { ...budget, maxWorkUnits: 1 }
    const report = await validateSceneEnvelope(envelope([['one', document('one')], ['two', document('two')]]), context(), tiny, control())
    expect(report.status).toBe('incomplete')
    expect(report.countIsExact).toBe(false)
    expect(report.stopReason).toBe('work-limit')
    expect(report.pendingSpaceIds.length).toBeGreaterThan(0)
  })

  it('does not report complete validity when a walkability flood reaches its visit cap', async () => {
    const tiny = { ...budget, maxVisitedPerFlood: 1 }
    const report = await validateSceneEnvelope(envelope([['one', document('one')]]), context(), tiny, control())

    expect(report.status).toBe('incomplete')
    expect(report.countIsExact).toBe(false)
    expect(report.stopReason).toBe('visit-limit')
    expect(report.checkedSpaceIds).toEqual([])
    expect(report.pendingSpaceIds).toEqual(['one'])
    expect(report.visitedCellsUsed).toBeGreaterThan(0)
    expect(report.workspaceBytesUsed).toBeGreaterThan(0)
  })

  it('distinguishes exactly 256 fully traversed issues from a truncated 257th issue', async () => {
    const issueContext = context()
    const issue = { fromSpaceId: 'one', toSpaceId: 'missing', at: at(1, 1, 1) }
    issueContext.bindings.entries = Array.from({ length: 256 }, () => ({ ...issue }))
    const exact = await validateSceneEnvelope(envelope([['one', document('exact-issues')]]), issueContext,
      { ...budget, maxCollectedIssues: 256 }, control())
    expect(exact.status).toBe('invalid')
    expect(exact.issueCount).toBe(256)
    expect(exact.countIsExact).toBe(true)
    expect(exact.stopReason).toBeNull()

    issueContext.bindings.entries.push({ ...issue })
    const truncated = await validateSceneEnvelope(envelope([['one', document('truncated-issues')]]), issueContext,
      { ...budget, maxCollectedIssues: 256 }, control())
    expect(truncated.status).toBe('incomplete')
    expect(truncated.issueCount).toBe(256)
    expect(truncated.countIsExact).toBe(false)
    expect(truncated.stopReason).toBe('issue-limit')
  })

  it('fails closed when the measured walkability workspace exceeds the report budget', async () => {
    const report = await validateSceneEnvelope(envelope([['one', document('workspace-limit')]]), context(),
      { ...budget, maxWorkspaceBytes: 0 }, control())
    expect(report.status).toBe('incomplete')
    expect(report.stopReason).toBe('workspace-limit')
    expect(report.countIsExact).toBe(false)
    expect(report.workspaceBytesUsed).toBeGreaterThan(0)
    expect(report.checkedSpaceIds).toEqual([])
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

  it('cooperatively cancels a large walkability flood and keeps its space pending', async () => {
    const controller = new AbortController()
    const large = createEmptyWorld({ width: 64, height: 4, depth: 64 }, 'mist-manor', 'cancel-flood')
    for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) setBlockMut(large, at(x, 0, z), 'grass')
    let yields = 0
    const report = await validateSceneEnvelope(envelope([['large', large]]), context(), budget, {
      signal: controller.signal,
      nowMs: () => Date.now(),
      yieldControl: async () => { yields += 1; controller.abort() },
    })
    expect(yields).toBeGreaterThan(0)
    expect(report.status).toBe('incomplete')
    expect(report.stopReason).toBe('cancelled')
    expect(report.checkedSpaceIds).toEqual([])
    expect(report.pendingSpaceIds).toEqual(['large'])
    expect(report.countIsExact).toBe(false)
    expect(report.visitedCellsUsed).toBeGreaterThan(0)
  })

  it('stops a large walkability flood at its 3s operation deadline and preserves pending space', async () => {
    const large = createEmptyWorld({ width: 64, height: 4, depth: 64 }, 'mist-manor', 'deadline-flood')
    for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) setBlockMut(large, at(x, 0, z), 'grass')
    let now = 0
    let yields = 0
    const operationControl: SceneWorkControl & { deadlineAt: number } = {
      signal: new AbortController().signal,
      nowMs: () => now,
      deadlineAt: 3_000,
      yieldControl: async () => { yields += 1; now = 3_000 },
    }
    const report = await validateSceneEnvelope(envelope([['large', large]]), context(), budget, operationControl)
    expect(yields).toBeGreaterThan(0)
    expect(report.status).toBe('incomplete')
    expect(report.stopReason).toBe('deadline')
    expect(report.checkedSpaceIds).toEqual([])
    expect(report.pendingSpaceIds).toEqual(['large'])
    expect(report.countIsExact).toBe(false)
    expect(report.visitedCellsUsed).toBeGreaterThan(0)
  })
})
