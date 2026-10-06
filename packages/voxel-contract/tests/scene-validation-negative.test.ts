import { describe, expect, it } from 'vitest'
import { applyEdits, createEmptyWorld, setBlockMut } from '../src'
import type { AssetManifest } from '../src/assets'
import { validateSceneEnvelope } from '../src/scene-validation'
import type {
  SceneCompatibilityEnvelope, SceneValidationContext, SceneWorkBudget, SceneWorkControl,
} from '../src/scene-compatibility'
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
const control = (): SceneWorkControl => ({
  signal: new AbortController().signal,
  nowMs: () => Date.now(),
  yieldControl: async () => {},
})

function groundedWorld(id: string) {
  const doc = createEmptyWorld({ width: 8, height: 6, depth: 8 }, 'mist-manor', id)
  for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) setBlockMut(doc, at(x, 0, z), 'grass')
  return doc
}

const assetManifest: AssetManifest = {
  version: 2,
  assets: {
    'test-hut': {
      id: 'test-hut', category: 'building', url: '/hut.glb', footprint: [2, 2] as [number, number],
      height: 2, thumbnail: '/hut.png', sway: 0,
    },
  },
}

function context(): SceneValidationContext {
  return {
    rulesVersion: 'negative-test',
    assets: assetManifest,
    assetManifestHash: 'negative-assets',
    templateCatalogHash: 'negative-templates',
    bindingHash: 'negative-bindings',
    contextFingerprint: 'negative-context',
    bindings: {
      personIds: [], locations: [], protectedObjects: [], protectedPlacements: [],
      locationBindings: [], personBindings: [], entries: [],
    },
  }
}

function envelope(documents: Array<[string, ReturnType<typeof groundedWorld>]>): SceneCompatibilityEnvelope {
  const spaces = documents.map(([spaceId, document]) => ({ spaceId, document }))
  const rawSpaces = spaces.map(({ spaceId, document }) => ({
    id: spaceId,
    name: spaceId,
    document: JSON.parse(serialize(document)) as SerializedVoxelDocument,
  }))
  return {
    original: { format: 'voxel-spaces', version: 1, defaultSpaceId: spaces[0].spaceId, spaces: rawSpaces },
    spaces,
    format: 'spaces',
    compatibilityChanges: [],
  }
}

function expectIssue(
  issues: Awaited<ReturnType<typeof validateSceneEnvelope>>['issues'],
  expected: {
    code: string
    category: string
    spaceId: string
    at?: ReturnType<typeof at>
    reason?: string
    summary?: RegExp
  },
) {
  const issue = issues.find((candidate) => candidate.code === expected.code
    && candidate.spaceId === expected.spaceId
    && (!expected.summary || expected.summary.test(candidate.summary)))
  expect(issue).toBeDefined()
  expect(issue).toMatchObject({
    code: expected.code,
    category: expected.category,
    spaceId: expected.spaceId,
    ...(expected.at ? { at: expected.at } : {}),
    ...(expected.reason ? { reason: expected.reason } : {}),
  })
  if (!expected.at) expect(issue).not.toHaveProperty('at')
  if (!expected.reason) expect(issue).not.toHaveProperty('reason')
}

describe('validateSceneEnvelope negative rule reports', () => {
  it('reports a real structural object defect with its space and anchor', async () => {
    const doc = applyEdits(groundedWorld('structure'), [{
      kind: 'place-object', objectType: 'stone-lantern', anchor: at(3, 4, 3), rotation: 0, objectId: 'floating-lantern',
    }]).document
    const report = await validateSceneEnvelope(envelope([['structure', doc]]), context(), budget, control())

    expect(report.status).toBe('invalid')
    expectIssue(report.issues, {
      code: 'floating-object', category: 'structure', spaceId: 'structure', at: at(3, 4, 3),
      summary: /floating-lantern/,
    })
  })

  it('distinguishes asset collision from unsupported placement reasons', async () => {
    const collision = applyEdits(groundedWorld('collision'), [
      { kind: 'place-asset', assetId: 'test-hut', anchor: at(2, 1, 2), rotation: 0, placementId: 'hut-a' },
      { kind: 'place-asset', assetId: 'test-hut', anchor: at(2, 1, 2), rotation: 0, placementId: 'hut-b' },
    ]).document
    const unsupported = applyEdits(groundedWorld('unsupported'), [
      { kind: 'place-asset', assetId: 'test-hut', anchor: at(5, 3, 5), rotation: 0, placementId: 'hut-floating' },
    ]).document
    const report = await validateSceneEnvelope(
      envelope([['collision', collision], ['unsupported', unsupported]]), context(), budget, control(), 'edit',
    )

    expectIssue(report.issues, {
      code: 'asset-overlap', category: 'asset', reason: 'collision', spaceId: 'collision', at: at(2, 1, 2),
      summary: /hut-a|hut-b/,
    })
    expectIssue(report.issues, {
      code: 'asset-overlap', category: 'asset', reason: 'unsupported', spaceId: 'unsupported', at: at(5, 3, 5),
      summary: /support/,
    })
    expect(report.issues.filter((issue) => issue.code === 'asset-overlap')).toHaveLength(2)
  })

  it('reports mismatched person and missing location bindings independently', async () => {
    const doc = applyEdits(groundedWorld('bindings'), [{
      kind: 'place-object', objectType: 'stone-lantern', anchor: at(3, 1, 3), rotation: 0, objectId: 'person-carrier',
    }]).document
    doc.objects[0].binding = { kind: 'person', personId: 'someone-else' }
    const bindings = context()
    bindings.bindings.personBindings.push({ spaceId: 'bindings', objectId: 'person-carrier', personId: 'person-1' })
    bindings.bindings.locationBindings.push({
      spaceId: 'bindings', carrierId: 'missing-location-carrier', location: { name: 'Kitchen', stableId: 'kitchen' },
    })
    const report = await validateSceneEnvelope(envelope([['bindings', doc]]), bindings, budget, control())

    expectIssue(report.issues, {
      code: 'binding-mismatch', category: 'binding', spaceId: 'bindings', at: at(3, 1, 3),
      summary: /person-1/,
    })
    expectIssue(report.issues, {
      code: 'binding-mismatch', category: 'binding', spaceId: 'bindings', summary: /Kitchen/,
    })
  })

  it('reports an undeclared cross-space entry at its actual source coordinate', async () => {
    const source = groundedWorld('source')
    const target = groundedWorld('target')
    const bindings = context()
    bindings.bindings.entries.push({ fromSpaceId: 'source', toSpaceId: 'target', at: at(0, 1, 3) })
    const report = await validateSceneEnvelope(envelope([['source', source], ['target', target]]), bindings, budget, control())

    expectIssue(report.issues, {
      code: 'connection-invalid', category: 'connection', spaceId: 'source', at: at(0, 1, 3),
      summary: /未在坐标/,
    })
  })

  it('reports a reachable one-cell clearance obstruction with its coordinate', async () => {
    const doc = groundedWorld('walkability')
    setBlockMut(doc, at(0, 2, 0), 'stone')
    const report = await validateSceneEnvelope(envelope([['walkability', doc]]), context(), budget, control())

    expectIssue(report.issues, {
      code: 'walk-clearance', category: 'walkability', spaceId: 'walkability', at: at(0, 1, 0),
      summary: /净空不足/,
    })
  })
})
