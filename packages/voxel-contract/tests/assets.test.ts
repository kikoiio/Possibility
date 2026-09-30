import { describe, expect, it } from 'vitest'
import { assetFootprintCells, ensureAssetPlacementIds, validateAssetManifest } from '../src/assets'
import { createEmptyWorld } from '../src/sections'
import type { AssetEntry, AssetManifest } from '../src/assets'
import type { AssetPlacement } from '../src/types'

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

describe('assetFootprintCells', () => {
  const hut = entry({ id: 'bld-hut-a', category: 'building', footprint: [2, 2], height: 2, sway: 0 })

  it('footprint 平移到 anchor 并含全高柱', () => {
    const cells = assetFootprintCells(hut, { x: 3, y: 1, z: 5 }, 0)
    expect(cells).toHaveLength(2 * 2 * 2)
    expect(cells).toContainEqual({ x: 3, y: 1, z: 5 })
    expect(cells).toContainEqual({ x: 4, y: 2, z: 6 })
  })

  it('奇数旋转互换 footprint 的 w/d', () => {
    const tower = entry({ footprint: [1, 3], height: 1 })
    const cells = assetFootprintCells(tower, { x: 0, y: 0, z: 0 }, 1)
    expect(cells).toHaveLength(3)
    expect(cells).toContainEqual({ x: 2, y: 0, z: 0 }) // w/d 互换后沿 x 展开
  })

  it('非整数高度向上取整且至少一行', () => {
    const tall = entry({ footprint: [1, 1], height: 2.5 })
    expect(assetFootprintCells(tall, { x: 0, y: 0, z: 0 }, 0)).toHaveLength(3)
    const flat = entry({ footprint: [1, 1], height: 0.2 })
    expect(assetFootprintCells(flat, { x: 0, y: 0, z: 0 }, 0)).toHaveLength(1)
  })
})

describe('ensureAssetPlacementIds', () => {
  const placement = (over: Partial<AssetPlacement> = {}): AssetPlacement => ({
    assetId: 'veg-tree-a', anchor: [1, 2, 3], rotation: 0, seed: 42, ...over,
  })

  it('为无 id 摆放派生确定性 id', () => {
    const doc = { ...createEmptyWorld({ width: 8, height: 8, depth: 8 }, 'mist-manor', 't'), assetPlacements: [placement()] }
    const a = ensureAssetPlacementIds(doc)
    const b = ensureAssetPlacementIds(doc)
    expect(a.assetPlacements![0].id).toMatch(/^ast-0-/)
    expect(a.assetPlacements![0].id).toBe(b.assetPlacements![0].id)
  })

  it('保留既有 id 且全有 id 时返回原文档引用', () => {
    const doc = { ...createEmptyWorld({ width: 8, height: 8, depth: 8 }, 'mist-manor', 't'), assetPlacements: [placement({ id: 'ast-x' })] }
    expect(ensureAssetPlacementIds(doc)).toBe(doc)
    expect(ensureAssetPlacementIds(doc).assetPlacements![0].id).toBe('ast-x')
  })

  it('无 assetPlacements 的文档原样返回', () => {
    const doc = createEmptyWorld({ width: 8, height: 8, depth: 8 }, 'mist-manor', 't')
    expect(ensureAssetPlacementIds(doc)).toBe(doc)
  })
})
