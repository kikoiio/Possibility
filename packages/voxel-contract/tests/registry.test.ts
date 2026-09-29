import { describe, expect, it } from 'vitest'
import { createBlockRegistry, getObjectTemplate, listObjectTemplates, mistManorBlocks } from '../src'

describe('block registry', () => {
  it('resolves theme block sets and supports register/get/list', () => {
    const registry = createBlockRegistry('mist-manor')
    expect(registry.get('grass')?.name).toBe('草地')
    expect(registry.list().length).toBe(mistManorBlocks.length)
    registry.register({ id: 'custom', name: '自定义', textures: { top: 't', side: 's' }, solid: true, category: 'decor' })
    expect(registry.get('custom')?.solid).toBe(true)
    expect(() => registry.register({ id: 'custom', name: 'x', textures: { top: 't', side: 's' }, solid: true, category: 'decor' })).toThrow()
  })

  it('every mist-manor block has non-empty texture frames', () => {
    for (const block of mistManorBlocks) {
      expect(block.textures.top.length, block.id).toBeGreaterThan(0)
      expect(block.textures.side.length, block.id).toBeGreaterThan(0)
      if (block.textures.bottom !== undefined) expect(block.textures.bottom.length).toBeGreaterThan(0)
    }
  })

  it('marks light emitters and snow-accumulating blocks', () => {
    const registry = createBlockRegistry('mist-manor')
    expect(registry.get('lantern')?.emitsLight).toBeGreaterThan(0)
    expect(registry.get('paper-window')?.emitsLight).toBeGreaterThan(0)
    expect(registry.get('grass')?.accumulatesSnow).toBe(true)
    expect(registry.get('water')?.translucent).toBe(true)
    expect(registry.get('water')?.solid).toBe(false)
  })

  it('rejects unknown themes', () => {
    expect(() => createBlockRegistry('nope')).toThrow(/unknown voxel theme/)
  })
})

describe('object catalog', () => {
  it('exposes warehouse templates with cells', () => {
    const types = listObjectTemplates().map((t) => t.objectType)
    expect(types).toContain('manor-main-house')
    expect(types).toContain('stone-lantern')
    for (const template of listObjectTemplates()) {
      expect(template.cells.length, template.objectType).toBeGreaterThan(0)
      for (const c of template.cells) expect(c.block.length).toBeGreaterThan(0)
    }
    expect(getObjectTemplate('manor-greenhouse')?.name).toBe('温室')
    expect(getObjectTemplate('missing')).toBeUndefined()
  })
})
