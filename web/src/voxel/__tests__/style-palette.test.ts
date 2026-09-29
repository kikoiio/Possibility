import { describe, expect, it } from 'vitest'
import { STYLE_PRESETS } from '@possibility/voxel-contract'
import { applyStyleTweaks, loadPalette, samplePalette } from '../engine/palette'
import { resolvePalette, STYLE_PRESET_DATA } from '../engine/palettes/style-presets'

describe('resolvePalette(S3b F8/F9)', () => {
  it('契约注册的全部预设 id 都能解析', () => {
    for (const meta of STYLE_PRESETS) {
      expect(() => resolvePalette('mist-manor', { preset: meta.id })).not.toThrow()
    }
  })

  it('default/未知/缺省 → 主题基底(N1 等价)', () => {
    const base = loadPalette('mist-manor')
    expect(resolvePalette('mist-manor')).toBe(base)
    expect(resolvePalette('mist-manor', { preset: 'default' })).toBe(base)
    expect(resolvePalette('mist-manor', { preset: 'nope' })).toBe(base)
  })

  it('预设数据与基底不同,且关键帧结构完整', () => {
    const base = loadPalette('mist-manor')
    for (const [id, palette] of Object.entries(STYLE_PRESET_DATA)) {
      expect(palette.keyframes.length).toBe(base.keyframes.length)
      expect(palette.keyframes.map((k) => k.elevation)).toEqual(base.keyframes.map((k) => k.elevation))
      expect(palette.keyframes[4].skyZenith).not.toEqual(base.keyframes[4].skyZenith)
      expect(palette.name).toBe(id)
    }
  })

  it('预设采样输出不同(F9 风格生效探针)', () => {
    const noon = samplePalette(loadPalette('mist-manor'), 0.5, { dim: 0, fogBoost: 0 })
    const dusk = samplePalette(resolvePalette('mist-manor', { preset: 'dusk-warm' }), 0.5, { dim: 0, fogBoost: 0 })
    expect(dusk.sky.zenith).not.toEqual(noon.sky.zenith)
    const misty = samplePalette(resolvePalette('mist-manor', { preset: 'misty-vale' }), 0.5, { dim: 0, fogBoost: 1 })
    const foggyNoon = samplePalette(loadPalette('mist-manor'), 0.5, { dim: 0, fogBoost: 1 })
    expect(misty.fog.density).toBeGreaterThan(foggyNoon.fog.density)
  })
})

describe('applyStyleTweaks(微调在采样出口叠加)', () => {
  const base = samplePalette(loadPalette('mist-manor'), 0.5, { dim: 0, fogBoost: 0.4 })

  it('fogDensity 乘性、exposure/saturation 加性', () => {
    const out = applyStyleTweaks(base, { fogDensity: 0.5, exposure: 0.1, saturation: -0.2 })
    expect(out.fog.density).toBeCloseTo(base.fog.density * 1.5)
    expect(out.post.exposure).toBeCloseTo(base.post.exposure + 0.1)
    expect(out.post.saturation).toBeCloseTo(base.post.saturation - 0.2)
  })

  it('无 tweaks → 原样返回', () => {
    expect(applyStyleTweaks(base)).toBe(base)
    expect(applyStyleTweaks(base, {})).toEqual(base)
  })

  it('结果夹到合法域', () => {
    const out = applyStyleTweaks(base, { fogDensity: -0.5, exposure: -0.3, saturation: 0.3 })
    expect(out.fog.density).toBeGreaterThanOrEqual(0)
    expect(out.post.exposure).toBeGreaterThanOrEqual(0.2)
    expect(out.post.saturation).toBeLessThanOrEqual(2)
    // 其余字段不受影响
    expect(out.sky).toBe(base.sky)
    expect(out.water).toBe(base.water)
  })
})
