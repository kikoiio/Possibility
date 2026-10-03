import { describe, expect, it } from 'vitest'
import { resolveSpaceContext } from './space-context'

const exterior = {
  kind: 'exterior' as const,
  skyVisible: true,
  skyLightEnabled: true,
  fogMode: 'outdoor' as const,
}

const interior = {
  kind: 'interior' as const,
  skyVisible: false,
  skyLightEnabled: false,
  fogMode: 'indoor' as const,
}

describe('resolveSpaceContext', () => {
  it('maps the main-house interior space to the indoor rendering context', () => {
    expect(resolveSpaceContext(undefined, 'main-house-interior')).toEqual(interior)
  })

  it('keeps the explicit exterior space on the outdoor context', () => {
    expect(resolveSpaceContext(undefined, 'exterior')).toEqual(exterior)
  })

  it('falls back to exterior for unknown and missing space ids', () => {
    expect(resolveSpaceContext(undefined, 'future-space')).toEqual(exterior)
    expect(resolveSpaceContext()).toEqual(exterior)
  })

  it('prefers explicit document metadata over the compatibility id mapping', () => {
    expect(resolveSpaceContext({ spaceKind: 'exterior' }, 'main-house-interior')).toEqual(exterior)
    expect(resolveSpaceContext({ metadata: { kind: 'interior' } }, 'unknown-space')).toEqual(interior)
  })

  it('supports legacy nested space metadata without depending on page presentation', () => {
    expect(resolveSpaceContext({ space: { type: 'interior' } }, 'legacy-space')).toEqual(interior)
    expect(resolveSpaceContext({ meta: { spaceType: 'exterior' } }, 'main-house-interior')).toEqual(exterior)
  })

  it('returns stable, independent context values for repeated resolution', () => {
    const first = resolveSpaceContext(undefined, 'main-house-interior')
    first.skyVisible = true
    expect(resolveSpaceContext(undefined, 'main-house-interior')).toEqual(interior)
  })
})
