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

describe('samplePalette 直射光', () => {
  it('正午直射来自太阳方位,午夜来自月亮方位且偏冷', () => {
    const noon = samplePalette(palette, 0.5, { dim: 0, fogBoost: 0 })
    expect(noon.direct.intensity).toBeCloseTo(1.3)
    expect(noon.direct.dir.y).toBeGreaterThan(0.8) // 太阳高悬
    const midnight = samplePalette(palette, 0, { dim: 0, fogBoost: 0 })
    expect(midnight.direct.intensity).toBeCloseTo(0.3)
    expect(midnight.direct.dir.y).toBeGreaterThan(0.8) // 月亮高悬(夜)
    expect(midnight.direct.color[2]).toBeGreaterThan(midnight.direct.color[0]) // 冷色
    // 与天空穹顶天体方位同源
    expect(Math.sign(midnight.direct.dir.z)).toBe(Math.sign(midnight.sky.moonDir.z))
  })

  it('黄昏直射强度低于正午与午夜(换向低谷)', () => {
    const dusk = samplePalette(palette, 0.74, { dim: 0, fogBoost: 0 })
    const noon = samplePalette(palette, 0.5, { dim: 0, fogBoost: 0 })
    const midnight = samplePalette(palette, 0, { dim: 0, fogBoost: 0 })
    expect(dusk.direct.intensity).toBeLessThan(noon.direct.intensity)
    expect(dusk.direct.intensity).toBeLessThan(midnight.direct.intensity)
  })

  it('天气 dim 压暗直射', () => {
    const clear = samplePalette(palette, 0.5, { dim: 0, fogBoost: 0 })
    const dimmed = samplePalette(palette, 0.5, { dim: 0.6, fogBoost: 0 })
    expect(dimmed.direct.intensity).toBeLessThan(clear.direct.intensity * 0.6)
  })

  it('直射强度随时间连续(±0.001 抖动 < 0.05)', () => {
    for (const t of [0.1, 0.24, 0.3, 0.5, 0.7, 0.76, 0.9]) {
      const a = samplePalette(palette, t - 0.001, { dim: 0, fogBoost: 0 })
      const b = samplePalette(palette, t + 0.001, { dim: 0, fogBoost: 0 })
      expect(Math.abs(a.direct.intensity - b.direct.intensity)).toBeLessThan(0.05)
    }
  })

  it('直射方向全程合法(单位向量,无 NaN)', () => {
    for (let t = 0; t < 1; t += 0.01) {
      const d = samplePalette(palette, t, { dim: 0, fogBoost: 0 }).direct.dir
      const len = Math.hypot(d.x, d.y, d.z)
      expect(Number.isFinite(len)).toBe(true)
      expect(len).toBeCloseTo(1, 5)
    }
  })
})
