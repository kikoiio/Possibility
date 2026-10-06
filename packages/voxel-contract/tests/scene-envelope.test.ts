import { describe, expect, it } from 'vitest'
import { createEmptyWorld } from '../src/sections'
import { serialize } from '../src/serialize'
import type { SerializedVoxelSpaces } from '../src/serialize'
import {
  SCENE_COMPATIBILITY_LIMITS,
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

function rawSpaces(count: number) {
  const spaces = Array.from({ length: count }, (_, index) => ({
    id: `space-${index}`,
    name: `Space ${index}`,
    document: rawWorld(`space-${index}`),
  }))
  return {
    format: 'voxel-spaces' as const,
    version: 1 as const,
    defaultSpaceId: 'space-0',
    spaces,
  }
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
    expect(decodeSceneCompatibility({ format: 'voxel-document', version: 2 })).toMatchObject({
      status: 'unsupported',
      issues: [expect.objectContaining({ code: 'unsupported-document-version', summary: '场景文档版本不受支持' })],
    })
  })

  it('accepts each supported dimension boundary and rejects an over-limit axis without clamping', () => {
    const maximum = rawWorld('maximum-dimensions')
    maximum.size = {
      width: SCENE_COMPATIBILITY_LIMITS.width,
      height: SCENE_COMPATIBILITY_LIMITS.height,
      depth: SCENE_COMPATIBILITY_LIMITS.depth,
    }
    expect(decodeSceneCompatibility(maximum).status).toBe('ready')

    for (const axis of ['width', 'height', 'depth'] as const) {
      const overLimit = rawWorld(`over-${axis}`)
      const limit = SCENE_COMPATIBILITY_LIMITS[axis]
      overLimit.size = { ...(overLimit.size as Record<string, unknown>), [axis]: limit + 1 }
      const original = structuredClone(overLimit)
      expect(decodeSceneCompatibility(overLimit)).toMatchObject({
        status: 'unsupported',
        issues: [expect.objectContaining({ code: 'unsupported-size' })],
      })
      expect(overLimit).toEqual(original)
      expect((overLimit.size as Record<string, unknown>)[axis]).toBe(limit + 1)
    }
  })

  it('accepts eight spaces and rejects the ninth without dropping spaces', () => {
    expect(decodeSceneCompatibility(rawSpaces(SCENE_COMPATIBILITY_LIMITS.spaces)).status).toBe('ready')
    const tooMany = rawSpaces(SCENE_COMPATIBILITY_LIMITS.spaces + 1)
    const original = structuredClone(tooMany)
    expect(decodeSceneCompatibility(tooMany)).toMatchObject({
      status: 'unsupported',
      issues: [expect.objectContaining({ code: 'unsupported-format', summary: expect.stringContaining('超过支持上限 8') })],
    })
    expect(tooMany).toEqual(original)
    expect(tooMany.spaces).toHaveLength(9)
  })

  it('measures raw JSON UTF-8 bytes, accepts the exact limit, and rejects one extra byte', () => {
    const exact = rawWorld('json-byte-limit')
    exact.unknownPadding = ''
    const baseBytes = new TextEncoder().encode(JSON.stringify(exact)).byteLength
    const remaining = SCENE_COMPATIBILITY_LIMITS.jsonUtf8Bytes - baseBytes
    exact.unknownPadding = `${'界'.repeat(3)}${'x'.repeat(remaining - 9)}`
    const exactJson = JSON.stringify(exact)
    expect(new TextEncoder().encode(exactJson).byteLength).toBe(SCENE_COMPATIBILITY_LIMITS.jsonUtf8Bytes)
    expect(decodeSceneCompatibility(exactJson).status).toBe('ready')
    expect(decodeSceneCompatibility(exact).status).toBe('ready')

    const overLimitJson = `${exactJson} `
    expect(new TextEncoder().encode(overLimitJson).byteLength).toBe(SCENE_COMPATIBILITY_LIMITS.jsonUtf8Bytes + 1)
    expect(decodeSceneCompatibility(overLimitJson)).toMatchObject({
      status: 'unsupported',
      issues: [expect.objectContaining({ code: 'unsupported-format', summary: expect.stringContaining('超过支持上限 1500000 bytes') })],
    })
    exact.unknownPadding = `${exact.unknownPadding as string}x`
    expect(decodeSceneCompatibility(exact)).toMatchObject({
      status: 'unsupported',
      issues: [expect.objectContaining({ code: 'unsupported-format', summary: expect.stringContaining('超过支持上限 1500000 bytes') })],
    })
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
