import { describe, expect, it } from 'vitest'
import { loadPalette, samplePalette, type RGB } from '../engine/palette'

const palette = loadPalette('mist-manor')
const NOON = palette.keyframes[palette.keyframes.length - 1]

const dist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

describe('samplePalette', () => {
  it('noon (t=0.5) samples exactly the noon keyframe', () => {
    const r = samplePalette(palette, 0.5, { dim: 0, fogBoost: 0 })
    expect(r.sky.zenith).toEqual(NOON.skyZenith)
    expect(r.sky.horizon).toEqual(NOON.skyHorizon)
    expect(r.skyLevel).toBeCloseTo(NOON.skyLevel)
    expect(r.bakeEnv.skyTint).toEqual(NOON.skyTint)
  })

  it('is continuous under ±0.001 time jitter', () => {
    for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const a = samplePalette(palette, t - 0.001, { dim: 0, fogBoost: 0 })
      const b = samplePalette(palette, t + 0.001, { dim: 0, fogBoost: 0 })
      expect(dist(a.sky.zenith, b.sky.zenith)).toBeLessThan(0.01)
      expect(Math.abs(a.skyLevel - b.skyLevel)).toBeLessThan(0.3)
    }
  })

  it('skyLevel is non-decreasing from midnight to noon', () => {
    let prev = -Infinity
    for (let t = 0; t <= 0.5; t += 0.02) {
      const level = samplePalette(palette, t, { dim: 0, fogBoost: 0 }).skyLevel
      expect(level).toBeGreaterThanOrEqual(prev)
      prev = level
    }
  })

  it('weather dim pushes fog toward weatherGray and increases fog density', () => {
    const clear = samplePalette(palette, 0.5, { dim: 0, fogBoost: 0 })
    const dimmed = samplePalette(palette, 0.5, { dim: 0.5, fogBoost: 0 })
    expect(dist(dimmed.fog.color, palette.weatherGray)).toBeLessThan(dist(clear.fog.color, palette.weatherGray))
    expect(dimmed.fog.density).toBeGreaterThan(clear.fog.density)
    expect(dimmed.sky.cloudCoverage).toBeGreaterThan(clear.sky.cloudCoverage)
    expect(dimmed.sky.sunIntensity).toBeLessThan(clear.sky.sunIntensity)
  })

  it('time wraps: t=0 / t=0.999 / t=1 do not throw and wrap consistently', () => {
    const t0 = samplePalette(palette, 0, { dim: 0, fogBoost: 0 })
    const t1 = samplePalette(palette, 1, { dim: 0, fogBoost: 0 })
    expect(() => samplePalette(palette, 0.999, { dim: 0, fogBoost: 0 })).not.toThrow()
    expect(dist(t0.sky.zenith, t1.sky.zenith)).toBeLessThan(1e-9)
  })

  it('unknown theme throws', () => {
    expect(() => loadPalette('no-such-theme')).toThrow(/unknown voxel palette theme/)
  })
})
