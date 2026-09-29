import { describe, expect, it } from 'vitest'
import { createBlockRegistry, createEmptyWorld } from '@possibility/voxel-contract'
import { isEyeUnderwater, smoothUnderwater, underwaterDepth, WATER_SURFACE_DROP } from '../engine/underwater'
import { WorldModel } from '../engine/world-model'

const registry = createBlockRegistry('mist-manor')

/** 草地 y=0 + 水池 y=1（x/z 5..7） */
function makeWorld() {
  const doc = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'test')
  const world = new WorldModel(doc)
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) world.setBlock({ x, y: 0, z }, 'grass')
  for (let z = 5; z <= 7; z++) for (let x = 5; x <= 7; x++) world.setBlock({ x, y: 1, z }, 'water')
  return world
}

describe('isEyeUnderwater', () => {
  it('眼位低于下沉水面 → true', () => {
    const world = makeWorld()
    expect(isEyeUnderwater(world, registry, { x: 6.5, y: 1.5, z: 6.5 })).toBe(true)
    expect(isEyeUnderwater(world, registry, { x: 6.5, y: 1.01, z: 6.5 })).toBe(true)
  })

  it('眼位恰好高于下沉水面 → false', () => {
    const world = makeWorld()
    expect(isEyeUnderwater(world, registry, { x: 6.5, y: 1 + WATER_SURFACE_DROP, z: 6.5 })).toBe(false)
    expect(isEyeUnderwater(world, registry, { x: 6.5, y: 1.95, z: 6.5 })).toBe(false)
  })

  it('非流体格 → false', () => {
    const world = makeWorld()
    expect(isEyeUnderwater(world, registry, { x: 6.5, y: 0.5, z: 6.5 })).toBe(false) // 草地内部
    expect(isEyeUnderwater(world, registry, { x: 2.5, y: 1.5, z: 2.5 })).toBe(false) // 空气
  })

  it('出界坐标安全返回 false', () => {
    const world = makeWorld()
    expect(isEyeUnderwater(world, registry, { x: -1, y: 1.5, z: 6.5 })).toBe(false)
    expect(isEyeUnderwater(world, registry, { x: 6.5, y: 99, z: 6.5 })).toBe(false)
    expect(isEyeUnderwater(world, registry, { x: 6.5, y: 1.5, z: 999 })).toBe(false)
  })

  it('underwaterDepth：未入水为 0，随没入加深，打满封顶 1', () => {
    const world = makeWorld()
    expect(underwaterDepth(world, registry, { x: 6.5, y: 1.9, z: 6.5 })).toBe(0)
    const shallow = underwaterDepth(world, registry, { x: 6.5, y: 1.7, z: 6.5 })
    const deep = underwaterDepth(world, registry, { x: 6.5, y: 1.1, z: 6.5 })
    expect(shallow).toBeGreaterThan(0)
    expect(deep).toBeGreaterThan(shallow)
    expect(underwaterDepth(world, registry, { x: 6.5, y: -5, z: 6.5 })).toBeLessThanOrEqual(1)
  })
})

describe('smoothUnderwater', () => {
  it('单调收敛不超调', () => {
    let v = 0
    const seq: number[] = []
    for (let i = 0; i < 60; i++) { v = smoothUnderwater(v, 1, 1 / 60); seq.push(v) }
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1])
    expect(seq[seq.length - 1]).toBeLessThanOrEqual(1)
    expect(seq[seq.length - 1]).toBeGreaterThan(0.99)
  })

  it('约 150ms 时间常数：150ms 后收敛约 63%', () => {
    let v = 0
    for (let i = 0; i < 9; i++) v = smoothUnderwater(v, 1, 1 / 60) // 150ms
    expect(v).toBeGreaterThan(0.55)
    expect(v).toBeLessThan(0.7)
  })

  it('回落同样平滑', () => {
    let v = 1
    v = smoothUnderwater(v, 0, 1 / 60)
    expect(v).toBeLessThan(1)
    expect(v).toBeGreaterThan(0.88)
    for (let i = 0; i < 90; i++) v = smoothUnderwater(v, 0, 1 / 60)
    expect(v).toBeLessThan(0.01)
  })
})
