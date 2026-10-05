import { describe, expect, it } from 'vitest'
import { createEmptyWorld } from '../src/sections'
import { serialize } from '../src/serialize'
import type { SerializedVoxelSpaces } from '../src/serialize'
import {
  applySceneRepairChangesToRaw,
  decodeSceneCompatibility,
  materializeSceneCandidate,
} from '../src/scene-envelope'

function rawWorld(id: string, withLegacyPlacement = false) {
  const world = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', id)
  if (withLegacyPlacement) {
    world.assetPlacements = [{ assetId: 'bld-hut-a', anchor: [1, 2, 3], rotation: 0, seed: 7 }]
  }
  return JSON.parse(serialize(world)) as Record<string, unknown>
}

describe('scene envelope compatibility', () => {
  it('decodes single legacy documents without mutating raw input', () => {
    const raw = rawWorld('single', true)
    ;(raw as Record<string, unknown>).unknownExtension = { keep: true }
    const before = structuredClone(raw)
    const result = decodeSceneCompatibility(raw)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.envelope.format).toBe('single')
    expect(result.envelope.spaces[0].spaceId).toBe('single')
    expect(result.envelope.spaces[0].document.assetPlacements?.[0].id).toMatch(/^legacy-placement-/)
    expect(result.envelope.original).toEqual(before)
    expect(raw).toEqual(before)
    expect(result.envelope.compatibilityChanges).toHaveLength(1)
  })

  it('classifies missing, corrupt, and unsupported payloads', () => {
    expect(decodeSceneCompatibility(undefined).status).toBe('missing')
    expect(decodeSceneCompatibility('{bad json').status).toBe('corrupt')
    expect(decodeSceneCompatibility({ format: 'other', version: 1 }).status).toBe('unsupported')
    expect(decodeSceneCompatibility({ format: 'voxel-document', version: 2 }).status).toBe('unsupported')
  })

  it('keeps multi-space order and requires a real space for candidates', () => {
    const multi = {
      format: 'voxel-spaces' as const, version: 1 as const, defaultSpaceId: 'hall',
      spaces: [
        { id: 'hall', name: 'Hall', document: rawWorld('hall') },
        { id: 'yard', name: 'Yard', document: rawWorld('yard') },
      ],
      extension: { retain: 'yes' },
    } as unknown as SerializedVoxelSpaces
    const decoded = decodeSceneCompatibility(multi)
    expect(decoded.status).toBe('ready')
    if (decoded.status !== 'ready') return
    expect(decoded.envelope.spaces.map((space) => space.spaceId)).toEqual(['hall', 'yard'])
    expect(materializeSceneCandidate(multi, { kind: 'operations', operations: [] }).status).toBe('corrupt')
    expect(materializeSceneCandidate(multi, { kind: 'operations', spaceId: 'missing', operations: [] }).status).toBe('corrupt')
    const candidate = materializeSceneCandidate(multi, {
      kind: 'operations', spaceId: 'hall', operations: [{ kind: 'set-block', at: { x: 1, y: 1, z: 1 }, block: 'stone' }],
    })
    expect(candidate.status).toBe('ready')
    expect(multi.spaces[1].document).toEqual(rawWorld('yard'))
  })

  it('patches only declared raw changes and preserves unknown fields', () => {
    const raw = rawWorld('patch', true)
    ;(raw as Record<string, unknown>).unknownExtension = { keep: 1 }
    const decoded = decodeSceneCompatibility(raw)
    expect(decoded.status).toBe('ready')
    if (decoded.status !== 'ready') return
    const change = decoded.envelope.compatibilityChanges[0]
    const patched = applySceneRepairChangesToRaw(raw as never, [change])
    expect('status' in patched).toBe(false)
    expect((patched as Record<string, unknown>).unknownExtension).toEqual({ keep: 1 })
    expect((patched as { assetPlacements: Array<{ id?: string }> }).assetPlacements[0].id)
      .toBe(change.kind === 'assign-placement-id' ? change.placementId : undefined)
    expect((raw as { assetPlacements: Array<{ id?: string }> }).assetPlacements[0].id).toBeUndefined()
  })
})
