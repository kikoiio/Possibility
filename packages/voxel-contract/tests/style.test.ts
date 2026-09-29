import { describe, expect, it } from 'vitest'
import { clampStyleRef, DEFAULT_STYLE_PRESET, STYLE_PRESETS } from '../src/style'

describe('clampStyleRef', () => {
  it('合法输入原样通过,零记录', () => {
    const { style, clamps } = clampStyleRef({
      preset: 'dusk-warm',
      tweaks: { fogDensity: 0.2, exposure: -0.1, saturation: 0.15 },
    })
    expect(style.preset).toBe('dusk-warm')
    expect(style.tweaks).toEqual({ fogDensity: 0.2, exposure: -0.1, saturation: 0.15 })
    expect(clamps).toEqual([])
    expect(style.clamps).toBeUndefined()
  })

  it('非对象输入 → 默认预设,零记录', () => {
    for (const raw of [undefined, null, 42, 'nope', []]) {
      const { style, clamps } = clampStyleRef(raw)
      expect(style.preset).toBe(DEFAULT_STYLE_PRESET)
      expect(clamps).toEqual([])
    }
  })

  it('未知预设 → 默认 + 记录', () => {
    const { style, clamps } = clampStyleRef({ preset: 'cyberpunk' })
    expect(style.preset).toBe(DEFAULT_STYLE_PRESET)
    expect(clamps).toEqual([{ field: 'style.preset', from: 'cyberpunk', to: DEFAULT_STYLE_PRESET }])
    expect(style.clamps).toEqual(clamps)
  })

  it('tweak 超范围 → 夹取 + 记录字段名与原值', () => {
    const { style, clamps } = clampStyleRef({
      preset: 'misty-vale',
      tweaks: { fogDensity: 5, exposure: -1.2, saturation: 0.1 },
    })
    expect(style.tweaks).toEqual({ fogDensity: 0.5, exposure: -0.3, saturation: 0.1 })
    expect(clamps).toEqual([
      { field: 'style.tweaks.fogDensity', from: 5, to: 0.5 },
      { field: 'style.tweaks.exposure', from: -1.2, to: -0.3 },
    ])
  })

  it('非数值 tweak 被忽略(不记录)', () => {
    const { style, clamps } = clampStyleRef({ preset: 'default', tweaks: { exposure: 'hot' } })
    expect(style.tweaks).toBeUndefined()
    expect(clamps).toEqual([])
  })

  it('预设注册表 id 唯一且含默认', () => {
    const ids = STYLE_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(DEFAULT_STYLE_PRESET)
  })
})
