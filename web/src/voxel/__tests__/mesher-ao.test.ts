import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createBlockRegistry, createEmptyWorld } from '@possibility/voxel-contract'
import { TextureAtlas, type AtlasJson } from '../engine/atlas'
import { LightingEngine } from '../engine/lighting'
import { DEFAULT_BAKE_ENV, Mesher, type AoParams, type MeshData } from '../engine/mesher'
import { WorldModel } from '../engine/world-model'

const at = (x: number, y: number, z: number) => ({ x, y, z })
const registry = createBlockRegistry('mist-manor')

const AO: AoParams = { curve: [0.45, 0.65, 0.85, 1.0], strength: 1 }

function testAtlas(): TextureAtlas {
  const frames: AtlasJson['frames'] = {}
  let i = 0
  for (const block of registry.list()) {
    for (const name of [block.textures.top, block.textures.side, block.textures.bottom]) {
      if (name && !frames[name]) frames[name] = { x: (i++ % 8) * 32, y: Math.floor(i / 8) * 32, w: 32, h: 32 }
    }
  }
  const atlas = new TextureAtlas()
  atlas.setTexture(new THREE.Texture(), { width: 256, height: 256, frames })
  return atlas
}

/**
 * 草地地面（y=0）+ 中心石块（5,1,5），可选在石块上方 y=2 放遮蔽块。
 * 目标观察面：石块顶面（py），邻居格 (5,2,5)，切向轴 x/z。
 */
function makeScene(occluders: Array<[number, number, number]>) {
  const doc = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'test')
  const world = new WorldModel(doc)
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) world.setBlock(at(x, 0, z), 'grass')
  world.setBlock(at(5, 1, 5), 'stone')
  for (const [x, y, z] of occluders) world.setBlock(at(x, y, z), 'stone')
  const lighting = new LightingEngine(world, registry)
  lighting.computeAll()
  const mesher = new Mesher(world, registry, testAtlas(), lighting)
  return { world, lighting, mesher }
}

/** 读 opaque 层指定位置 + 法向的顶点色 r 通道 */
function colorAt(data: MeshData, x: number, y: number, z: number, nx: number, ny: number, nz: number): number | null {
  for (let v = 0; v < data.positions.length / 3; v++) {
    if (
      data.positions[v * 3] === x && data.positions[v * 3 + 1] === y && data.positions[v * 3 + 2] === z &&
      data.normals[v * 3] === nx && data.normals[v * 3 + 1] === ny && data.normals[v * 3 + 2] === nz
    ) return data.colors[v * 3]
  }
  return null
}

/** 石块顶面的角顶点 (5,2,5)：对应角 (0,1,0)，切向偏移 -x / -z */
const CORNER: [number, number, number] = [5, 2, 5]
const UP: [number, number, number] = [0, 1, 0]

describe('Mesher 逐顶点 AO', () => {
  it('自由角（无邻块）：level=3，顶点色 = 无 AO 基准 × curve[3]', () => {
    const { mesher } = makeScene([])
    const base = colorAt(mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV).opaque, ...CORNER, ...UP)!
    const withAo = colorAt(mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV, AO).opaque, ...CORNER, ...UP)!
    expect(base).toBeGreaterThan(0)
    expect(withAo).toBeCloseTo(base * AO.curve[3], 6)
  })

  it('单边遮挡：level=2', () => {
    const { mesher } = makeScene([[4, 2, 5]]) // side1(-x)
    const base = colorAt(mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV).opaque, ...CORNER, ...UP)!
    const withAo = colorAt(mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV, AO).opaque, ...CORNER, ...UP)!
    expect(withAo).toBeCloseTo(base * AO.curve[2], 6)
  })

  it('凹槽（一边 + 对角遮挡）：level=1', () => {
    const { mesher } = makeScene([[4, 2, 5], [4, 2, 4]]) // side1(-x) + 对角(-x,-z)
    const base = colorAt(mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV).opaque, ...CORNER, ...UP)!
    const withAo = colorAt(mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV, AO).opaque, ...CORNER, ...UP)!
    expect(withAo).toBeCloseTo(base * AO.curve[1], 6)
  })

  it('拐角内陷（两邻边遮挡）：level=0', () => {
    const { mesher } = makeScene([[4, 2, 5], [5, 2, 4]]) // side1(-x) + side2(-z)
    const base = colorAt(mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV).opaque, ...CORNER, ...UP)!
    const withAo = colorAt(mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV, AO).opaque, ...CORNER, ...UP)!
    expect(withAo).toBeCloseTo(base * AO.curve[0], 6)
  })

  it('同一面的四个角可有不同 AO 档位', () => {
    const { mesher } = makeScene([[4, 2, 5], [4, 2, 4]])
    const geo = mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV, AO).opaque
    const occluded = colorAt(geo, 5, 2, 5, ...UP)!   // level=1
    const free = colorAt(geo, 6, 2, 6, ...UP)!       // 角 (1,1,1)：无邻块 level=3
    expect(occluded).toBeLessThan(free)
  })

  it('strength=0 时与不传 AO 完全一致', () => {
    const { mesher } = makeScene([[4, 2, 5], [5, 2, 4]])
    const off = mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV)
    const zero = mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV, { curve: AO.curve, strength: 0 })
    expect([...zero.opaque.colors]).toEqual([...off.opaque.colors])
  })
})
