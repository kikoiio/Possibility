import { describe, expect, it } from 'vitest'
import { validateAssetManifest } from '../src/assets'
import type { AssetEntry, AssetManifest } from '../src/assets'

const entry = (over: Partial<AssetEntry> = {}): AssetEntry => ({
  id: 'veg-tree-a',
  category: 'vegetation',
  url: '/voxel-assets/library/models/veg-tree-a.glb',
  footprint: [1, 1],
  height: 3,
  thumbnail: '/voxel-assets/library/thumbnails/veg-tree-a.png',
  sway: 0.12,
  ...over,
})

const manifest = (assets: Record<string, AssetEntry>): AssetManifest => ({ version: 2, assets })

describe('validateAssetManifest', () => {
  it('接受合法的 6 条目清单(4 植被 + 2 建筑)', () => {
    const six = manifest({
      'veg-tree-a': entry(),
      'veg-flower-a': entry({ id: 'veg-flower-a' }),
      'veg-grass-a': entry({ id: 'veg-grass-a' }),
      'veg-bush-a': entry({ id: 'veg-bush-a' }),
      'bld-hut-a': entry({ id: 'bld-hut-a', category: 'building', footprint: [2, 2], height: 2, sway: 0 }),
      'bld-tower-a': entry({ id: 'bld-tower-a', category: 'building', footprint: [1, 1], height: 4, sway: 0 }),
    })
    const result = validateAssetManifest(six)
    expect(result.ok).toBe(true)
    if (result.ok) expect(Object.keys(result.manifest.assets)).toHaveLength(6)
  })

  it('拒绝错误的 version', () => {
    const result = validateAssetManifest({ version: 1, assets: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0].message).toContain('version')
  })

  it('拒绝缺失的 assets', () => {
    const result = validateAssetManifest({ version: 2 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.some((i) => i.message.includes('assets'))).toBe(true)
  })

  it('拒绝缺字段的条目并指明 id', () => {
    const broken = entry()
    delete (broken as Partial<AssetEntry>).url
    const result = validateAssetManifest(manifest({ 'veg-tree-a': broken }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((i) => i.id === 'veg-tree-a' && i.message.includes('url'))).toBe(true)
    }
  })

  it('拒绝非正整数的 footprint', () => {
    const result = validateAssetManifest(manifest({ 'veg-tree-a': entry({ footprint: [0, 1.5] as [number, number] }) }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.some((i) => i.message.includes('footprint'))).toBe(true)
  })

  it('拒绝非正数的 height', () => {
    const result = validateAssetManifest(manifest({ 'veg-tree-a': entry({ height: -1 }) }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.some((i) => i.message.includes('height'))).toBe(true)
  })

  it('拒绝非 vegetation 上的正 sway 振幅', () => {
    const result = validateAssetManifest(manifest({
      'bld-hut-a': entry({ id: 'bld-hut-a', category: 'building', sway: 0.5 }),
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.some((i) => i.id === 'bld-hut-a' && i.message.includes('sway'))).toBe(true)
  })

  it('接受非 vegetation 上的 sway=0', () => {
    const result = validateAssetManifest(manifest({
      'bld-hut-a': entry({ id: 'bld-hut-a', category: 'building', sway: 0 }),
    }))
    expect(result.ok).toBe(true)
  })

  it('拒绝负数 sway', () => {
    const result = validateAssetManifest(manifest({ 'veg-tree-a': entry({ sway: -0.1 }) }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.some((i) => i.message.includes('sway'))).toBe(true)
  })

  it('拒绝 id 与键不一致的条目', () => {
    const result = validateAssetManifest(manifest({ 'veg-tree-a': entry({ id: 'veg-tree-b' }) }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.some((i) => i.message.includes('不一致'))).toBe(true)
  })

  it('拒绝非法字符的 id', () => {
    const result = validateAssetManifest(manifest({ 'Veg_Tree!': entry({ id: 'Veg_Tree!' }) }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.some((i) => i.message.includes('kebab-case'))).toBe(true)
  })

  it('拒绝空的 thumbnail', () => {
    const result = validateAssetManifest(manifest({ 'veg-tree-a': entry({ thumbnail: '' }) }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.some((i) => i.message.includes('thumbnail'))).toBe(true)
  })

  it('拒绝非对象输入', () => {
    expect(validateAssetManifest(null).ok).toBe(false)
    expect(validateAssetManifest('x').ok).toBe(false)
  })
})
