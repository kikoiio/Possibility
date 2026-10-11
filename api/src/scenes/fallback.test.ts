import { describe, expect, it } from 'vitest'
import {
  deserialize,
  validateSceneEnvelope,
  type AssetManifest,
  type SceneCompatibilityEnvelope,
  type SceneValidationContext,
  type SceneWorkBudget,
} from '@possibility/voxel-contract'
import { buildFallbackScene, type FallbackSceneInput } from './fallback'

const assets: AssetManifest = {
  version: 2,
  assets: {
    'bld-hut-a': {
      id: 'bld-hut-a', category: 'building', url: '/hut.glb', thumbnail: '/hut.png', footprint: [2, 2], height: 2, sway: 0,
    },
  },
}

const budget: SceneWorkBudget = {
  maxWorkUnits: 200_000, maxVisitedPerFlood: 20_000, maxCollectedIssues: 256, maxRepairCandidates: 32,
  maxRepairPasses: 2, maxWallMs: 10_000, maxWorkspaceBytes: 16 * 1024 * 1024,
  maxSerializedBytes: 1_500_000, maxSpaces: 2,
}

const baseInput = (): FallbackSceneInput => ({
  world: { id: 'world-a', name: '湖畔庄园', description: '一座安静的庄园', locations: [{ name: '主楼' }, { name: '花园' }] },
  residents: [{ personId: 'ada', name: '阿黛', locationName: '主楼' }],
})

function validationContext(result: Extract<ReturnType<typeof buildFallbackScene>, { ok: true }>): SceneValidationContext {
  const doc = result.document
  const resident = doc.objects.find((object) => object.binding?.kind === 'person')
  return {
    rulesVersion: 'fallback-test', assets, assetManifestHash: 'assets', templateCatalogHash: 'templates', bindingHash: 'bindings', contextFingerprint: 'context',
    bindings: {
      personIds: resident?.binding?.kind === 'person' ? [resident.binding.personId] : [],
      locations: result.locationBindings.map((location) => ({ name: location.name })),
      protectedObjects: [], protectedPlacements: [],
      locationBindings: result.locationBindings.map((location) => ({ spaceId: 'exterior', carrierId: location.objectId, location: { name: location.name } })),
      personBindings: resident?.binding?.kind === 'person' ? [{ spaceId: 'exterior', objectId: resident.id, personId: resident.binding.personId }] : [],
      entries: [],
    },
  }
}

async function reportFor(result: Extract<ReturnType<typeof buildFallbackScene>, { ok: true }>) {
  const document = deserialize(JSON.stringify(result.document))
  const envelope: SceneCompatibilityEnvelope = {
    original: result.document,
    spaces: [{ spaceId: 'exterior', document }], format: 'single', compatibilityChanges: [],
  }
  return validateSceneEnvelope(envelope, validationContext(result), budget, {
    signal: new AbortController().signal, nowMs: () => Date.now(), yieldControl: async () => {},
  })
}

describe('buildFallbackScene', () => {
  it('creates a valid deterministic scene and stable content hash', async () => {
    const first = buildFallbackScene(baseInput())
    const second = buildFallbackScene(baseInput())
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.source).toBe('fallback')
    expect(first.contentHash).toBe(second.contentHash)
    expect(first.document).toEqual(second.document)
    expect(first.document.locations.map((location) => location.name)).toEqual(['主楼', '花园'])
    expect((await reportFor(first)).status).toBe('valid')
  })

  it('rejects duplicate location carriers and duplicate resident carriers', () => {
    const locationConflict = buildFallbackScene({
      world: { locations: [{ name: '主楼', objectId: 'same' }, { name: '花园', objectId: 'same' }] },
    })
    expect(locationConflict).toMatchObject({ ok: false, code: 'binding-conflict' })

    const residentConflict = buildFallbackScene({
      world: { locations: [{ name: '主楼' }] },
      residents: [{ personId: 'ada', objectId: 'location-spot-0' }],
    })
    expect(residentConflict).toMatchObject({ ok: false, code: 'binding-conflict' })
  })

  it('rejects an empty location list without returning a partial document', () => {
    const result = buildFallbackScene({ world: { id: 'empty', locations: [] } })
    expect(result).toMatchObject({ ok: false, code: 'no-locations', source: 'fallback' })
    expect(result).not.toHaveProperty('document')
  })

  it('rejects unavailable required assets before constructing a document', () => {
    const result = buildFallbackScene({
      world: { locations: [{ name: '主楼', assetId: 'bld-missing-a' }] },
      assets,
    })
    expect(result).toMatchObject({ ok: false, code: 'asset-unavailable', source: 'fallback' })
    expect(result).not.toHaveProperty('document')
  })

  it('can bind a published asset deterministically', async () => {
    const first = buildFallbackScene({ world: { id: 'asset-world', locations: [{ name: '小屋', assetId: 'bld-hut-a' }] }, assets })
    const second = buildFallbackScene({ world: { id: 'asset-world', locations: [{ name: '小屋', assetId: 'bld-hut-a' }] }, assets })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.contentHash).toBe(second.contentHash)
    expect(first.document.assetPlacements?.[0]).toMatchObject({ id: 'location-spot-0', assetId: 'bld-hut-a', anchor: [12, 1, 6] })
    expect((await reportFor(first)).status).toBe('valid')
  })
})

