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

describe('samplePalette 水色', () => {
  it('noon (t=0.5) 水四色命中正午关键帧', () => {
    const r = samplePalette(palette, 0.5, { dim: 0, fogBoost: 0 })
    expect(r.water.shallow).toEqual(NOON.waterShallow)
    expect(r.water.deep).toEqual(NOON.waterDeep)
    expect(r.water.foam).toEqual(NOON.waterFoam)
    expect(r.water.fog).toEqual(NOON.waterFog)
  })

  it('水色 ±0.001 时间抖动连续', () => {
    for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const a = samplePalette(palette, t - 0.001, { dim: 0, fogBoost: 0 })
      const b = samplePalette(palette, t + 0.001, { dim: 0, fogBoost: 0 })
      expect(dist(a.water.shallow, b.water.shallow)).toBeLessThan(0.01)
      expect(dist(a.water.deep, b.water.deep)).toBeLessThan(0.01)
      expect(dist(a.water.foam, b.water.foam)).toBeLessThan(0.01)
      expect(dist(a.water.fog, b.water.fog)).toBeLessThan(0.01)
    }
  })

  it('weather dim 把水四色推向 weatherGray', () => {
    const clear = samplePalette(palette, 0.5, { dim: 0, fogBoost: 0 })
    const dimmed = samplePalette(palette, 0.5, { dim: 0.6, fogBoost: 0 })
    for (const key of ['shallow', 'deep', 'foam', 'fog'] as const) {
      expect(dist(dimmed.water[key], palette.weatherGray)).toBeLessThan(dist(clear.water[key], palette.weatherGray))
    }
  })

  it('时间 wrap:t=0 与 t=1 水色一致', () => {
    const t0 = samplePalette(palette, 0, { dim: 0, fogBoost: 0 })
    const t1 = samplePalette(palette, 1, { dim: 0, fogBoost: 0 })
    expect(dist(t0.water.shallow, t1.water.shallow)).toBeLessThan(1e-9)
    expect(dist(t0.water.fog, t1.water.fog)).toBeLessThan(1e-9)
  })
})

describe('samplePalette 直射光', () => {
  it('正午直射来自太阳方位,午夜来自月亮方位且偏冷', () => {
    const noon = samplePalette(palette, 0.5, { dim: 0, fogBoost: 0 })
    expect(noon.direct.intensity).toBeCloseTo(2.15)
    // S1v2:方位仰角封顶 0.66(CoC 式长影),正午不再是头顶直射
    expect(noon.direct.dir.y).toBeGreaterThan(0.55)
    expect(noon.direct.dir.y).toBeLessThan(0.8)
    const midnight = samplePalette(palette, 0, { dim: 0, fogBoost: 0 })
    expect(midnight.direct.intensity).toBeCloseTo(0.38)
    expect(midnight.direct.dir.y).toBeGreaterThan(0.8) // 月亮高悬(夜)
    expect(midnight.direct.color[2]).toBeGreaterThan(midnight.direct.color[0]) // 冷色
    // 与天空穹顶天体方位同源
    expect(Math.sign(midnight.direct.dir.z)).toBe(Math.sign(midnight.sky.moonDir.z))
  })

  it('黄昏直射低于正午,且与午夜换向无跳变(S1v2:金色时刻加强后不再要求低于午夜)', () => {
    const dusk = samplePalette(palette, 0.74, { dim: 0, fogBoost: 0 })
    const noon = samplePalette(palette, 0.5, { dim: 0, fogBoost: 0 })
    const midnight = samplePalette(palette, 0, { dim: 0, fogBoost: 0 })
    expect(dusk.direct.intensity).toBeLessThan(noon.direct.intensity)
    // 换向连续性:黄昏→午夜单调回落,不出现亮度跳升
    expect(Math.abs(dusk.direct.intensity - midnight.direct.intensity)).toBeLessThan(0.5)
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
