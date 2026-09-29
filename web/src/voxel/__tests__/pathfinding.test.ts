import { describe, expect, it } from 'vitest'
import { createBlockRegistry, createEmptyWorld } from '@possibility/voxel-contract'
import { findPath, isStandable, nearestStandable } from '../engine/pathfinding'
import { WorldModel } from '../engine/world-model'

const at = (x: number, y: number, z: number) => ({ x, y, z })
const registry = createBlockRegistry('mist-manor')

function makeWorld() {
  const doc = createEmptyWorld({ width: 24, height: 16, depth: 24 }, 'mist-manor', 'test')
  const world = new WorldModel(doc)
  for (let z = 0; z < 24; z++) for (let x = 0; x < 24; x++) world.setBlock(at(x, 0, z), 'grass')
  return world
}

describe('pathfinding', () => {
  it('identifies standable cells (solid top + two air above)', () => {
    const world = makeWorld()
    expect(isStandable(world, registry, at(5, 1, 5))).toBe(true)
    world.setBlock(at(7, 1, 7), 'stone')
    expect(isStandable(world, registry, at(7, 1, 7))).toBe(false) // 格内有实体
    expect(isStandable(world, registry, at(7, 2, 7))).toBe(true)  // 站在石块上
    world.setBlock(at(9, 1, 9), 'water')
    expect(isStandable(world, registry, at(9, 2, 9))).toBe(false) // 不能站在水上
  })

  it('finds a straight path on open ground', () => {
    const world = makeWorld()
    const path = findPath(world, registry, at(2, 1, 2), at(8, 1, 2))
    expect(path).not.toBeNull()
    expect(path!.at(-1)).toEqual(at(8, 1, 2))
    expect(path!.length).toBe(6)
  })

  it('routes around obstacles', () => {
    const world = makeWorld()
    // 竖一道两格高的墙（爬不上），留北侧缺口
    for (let z = 2; z < 12; z++) {
      world.setBlock(at(5, 1, z), 'stone')
      world.setBlock(at(5, 2, z), 'stone')
    }
    const path = findPath(world, registry, at(3, 1, 6), at(8, 1, 6))
    expect(path).not.toBeNull()
    expect(path!.at(-1)).toEqual(at(8, 1, 6))
    // 路径不穿墙（任何高度都不经过墙占的 x/z）
    expect(path!.some((c) => c.x === 5 && c.z >= 2 && c.z < 12)).toBe(false)
    expect(path!.length).toBeGreaterThan(5)
  })

  it('climbs a one-step staircase', () => {
    const world = makeWorld()
    for (let x = 4; x < 10; x++) for (let z = 2; z < 6; z++) world.setBlock(at(x, 1, z), 'stone') // 一级高台
    const path = findPath(world, registry, at(2, 1, 4), at(8, 2, 4))
    expect(path).not.toBeNull()
    expect(path!.at(-1)).toEqual(at(8, 2, 4))
    expect(Math.max(...path!.map((c) => c.y))).toBe(2)
  })

  it('refuses two-step cliffs and returns null when sealed', () => {
    const world = makeWorld()
    // 两级高台：不可直接上
    for (let x = 4; x < 10; x++) for (let z = 2; z < 6; z++) {
      world.setBlock(at(x, 1, z), 'stone')
      world.setBlock(at(x, 2, z), 'stone')
    }
    const cliff = findPath(world, registry, at(2, 1, 4), at(6, 3, 4))
    expect(cliff === null || !cliff.some((c, i) => i > 0 && c.y - cliff[i - 1].y > 1)).toBe(true)

    // 全封闭目标
    const boxed = at(15, 1, 15)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) world.setBlock(at(15 + dx, 1, 15 + dz), 'stone')
    world.setBlock(at(15, 2, 15), 'stone')
    expect(findPath(world, registry, at(2, 1, 2), boxed)).toBeNull()
  })

  it('nearestStandable drops onto ground from air', () => {
    const world = makeWorld()
    expect(nearestStandable(world, registry, at(5, 6, 5), 6)).toEqual(at(5, 1, 5))
  })
})
