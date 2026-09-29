import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createBlockRegistry, createEmptyWorld } from '@possibility/voxel-contract'
import { computeUV, TextureAtlas, type AtlasJson } from '../engine/atlas'
import { LightingEngine } from '../engine/lighting'
import { DEFAULT_BAKE_ENV, Mesher } from '../engine/mesher'
import { WorldModel } from '../engine/world-model'

const at = (x: number, y: number, z: number) => ({ x, y, z })
const registry = createBlockRegistry('mist-manor')

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

function makeWorld(size = { width: 32, height: 32, depth: 32 }) {
  const doc = createEmptyWorld(size, 'mist-manor', 'test')
  const world = new WorldModel(doc)
  const lighting = new LightingEngine(world, registry)
  return { world, lighting }
}

/** 铺一层草地地面（y=0） */
function floor(world: WorldModel) {
  const { width, depth } = world.doc.size
  for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) world.setBlock(at(x, 0, z), 'grass')
}

describe('TextureAtlas', () => {
  it('computes UV rects with inset and y-flip', () => {
    const uv = computeUV({ x: 32, y: 0, w: 32, h: 32 }, 256, 256)
    expect(uv.u0).toBeCloseTo(32.5 / 256)
    expect(uv.u1).toBeCloseTo(63.5 / 256)
    expect(uv.v1).toBeCloseTo(1 - 0.5 / 256)
    expect(uv.v0).toBeCloseTo(1 - 31.5 / 256)
  })

  it('throws on missing frame', () => {
    const atlas = testAtlas()
    expect(() => atlas.uv('no-such-frame')).toThrow(/atlas frame missing/)
    expect(atlas.has('grass-top')).toBe(true)
  })
})

describe('WorldModel', () => {
  it('setBlock reports affected sections including border neighbors', () => {
    const { world } = makeWorld({ width: 64, height: 32, depth: 32 })
    expect(world.setBlock(at(5, 5, 5), 'stone')).toEqual(['0,0,0'])
    expect(world.setBlock(at(16, 5, 5), 'stone').sort()).toEqual(['0,0,0', '1,0,0'])
  })

  it('tracks dirty sections and notifies subscribers', () => {
    const { world } = makeWorld()
    const seen: string[][] = []
    const unsubscribe = world.subscribe((keys) => seen.push(keys))
    world.setBlock(at(1, 1, 1), 'stone')
    world.setBlock(at(20, 1, 1), 'stone')
    expect(world.consumeDirty().sort()).toEqual(['0,0,0', '1,0,0'])
    expect(world.consumeDirty()).toEqual([])
    expect(seen).toHaveLength(2)
    unsubscribe()
    world.setBlock(at(2, 2, 2), 'stone')
    expect(seen).toHaveLength(2)
  })
})

describe('LightingEngine', () => {
  it('open-air cells above ground receive full sky light', () => {
    const { world, lighting } = makeWorld()
    floor(world)
    lighting.computeAll()
    expect(lighting.getSky(at(5, 1, 5))).toBe(15)
    expect(lighting.getSky(at(5, 20, 5))).toBe(15)
  })

  it('sealed rooms get no sky light; tunnels attenuate', () => {
    const { world, lighting } = makeWorld()
    floor(world)
    // 5×3×5 密封石屋：墙、顶
    for (let y = 1; y <= 4; y++) {
      for (let x = 4; x <= 8; x++) for (let z = 4; z <= 8; z++) {
        const wall = x === 4 || x === 8 || z === 4 || z === 8 || y === 4
        if (wall) world.setBlock(at(x, y, z), 'stone')
      }
    }
    lighting.computeAll()
    expect(lighting.getSky(at(6, 2, 6))).toBe(0)
    expect(lighting.getSky(at(6, 5, 6))).toBe(15) // 屋顶上方
    // 在墙上开一格门洞：光衰减着渗进来
    world.setBlock(at(6, 1, 4), 'air')
    world.setBlock(at(6, 2, 4), 'air')
    lighting.computeSection('0,0,0')
    expect(lighting.getSky(at(6, 1, 5))).toBeGreaterThan(10)
    expect(lighting.getSky(at(6, 1, 7))).toBeLessThan(lighting.getSky(at(6, 1, 5)))
    expect(lighting.getSky(at(6, 1, 7))).toBeGreaterThan(0)
  })

  it('lanterns emit a block-light halo', () => {
    const { world, lighting } = makeWorld()
    floor(world)
    world.setBlock(at(8, 1, 8), 'lantern')
    lighting.computeAll()
    expect(lighting.getBlockLight(at(8, 1, 8))).toBe(14)
    expect(lighting.getBlockLight(at(9, 1, 8))).toBe(13)
    expect(lighting.getBlockLight(at(11, 1, 8))).toBe(11)
    expect(lighting.getBlockLight(at(8, 4, 8))).toBe(11)
  })

  it('setSkyLevel rescales the sky channel', () => {
    const { world, lighting } = makeWorld()
    floor(world)
    lighting.computeAll()
    expect(lighting.getSky(at(5, 1, 5))).toBe(15)
    lighting.setSkyLevel(4)
    expect(lighting.getSky(at(5, 1, 5))).toBe(4)
    expect(lighting.getSkyLevel()).toBe(4)
  })

  it('local recompute after edit matches full recompute', () => {
    const { world, lighting } = makeWorld()
    floor(world)
    world.setBlock(at(8, 1, 8), 'lantern')
    lighting.computeAll()
    const before = lighting.getBlockLight(at(12, 1, 8))
    // 挖掉灯笼 → 局部重算 → 光晕消失
    world.setBlock(at(8, 1, 8), 'air')
    lighting.computeSection('0,0,0')
    expect(lighting.getBlockLight(at(8, 1, 8))).toBe(0)
    expect(lighting.getBlockLight(at(12, 1, 8))).toBe(0)
    expect(before).toBeGreaterThan(0)
  })
})

describe('Mesher', () => {
  function makeMesher() {
    const { world, lighting } = makeWorld()
    const mesher = new Mesher(world, registry, testAtlas(), lighting)
    return { world, lighting, mesher }
  }

  it('a lone block bakes 6 faces', () => {
    const { world, lighting, mesher } = makeMesher()
    world.setBlock(at(5, 5, 5), 'stone')
    lighting.computeAll()
    const geo = mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV)
    expect(geo.opaque.faceCount).toBe(6)
    expect(geo.opaque.positions).toHaveLength(6 * 4 * 3)
    expect(geo.opaque.indices).toHaveLength(6 * 6)
    expect(geo.translucent.faceCount).toBe(0)
  })

  it('two adjacent blocks bake 10 faces', () => {
    const { world, lighting, mesher } = makeMesher()
    world.setBlock(at(5, 5, 5), 'stone')
    world.setBlock(at(6, 5, 5), 'stone')
    lighting.computeAll()
    expect(mesher.bakeSection('0,0,0').opaque.faceCount).toBe(10)
  })

  it('a fully buried block contributes no faces (3×3×3 cube = 54)', () => {
    const { world, lighting, mesher } = makeMesher()
    for (let y = 3; y <= 5; y++) for (let z = 3; z <= 5; z++) for (let x = 3; x <= 5; x++) world.setBlock(at(x, y, z), 'stone')
    lighting.computeAll()
    expect(mesher.bakeSection('0,0,0').opaque.faceCount).toBe(54)
  })

  it('water bakes into the translucent layer; water-water faces are culled', () => {
    const { world, lighting, mesher } = makeMesher()
    world.setBlock(at(5, 5, 5), 'water')
    world.setBlock(at(6, 5, 5), 'water')
    lighting.computeAll()
    const geo = mesher.bakeSection('0,0,0')
    expect(geo.opaque.faceCount).toBe(0)
    expect(geo.translucent.faceCount).toBe(10)
  })

  it('top and side faces sample different texture frames', () => {
    const { world, lighting, mesher } = makeMesher()
    world.setBlock(at(5, 5, 5), 'grass')
    lighting.computeAll()
    const atlas = testAtlas()
    const topUV = atlas.uv('grass-top')
    const sideUV = atlas.uv('grass-side')
    const geo = mesher.bakeSection('0,0,0')
    const uvs = geo.opaque.uvs
    const usesTop = Array.from(uvs).some((v) => Math.abs(v - topUV.u0) < 1e-6 || Math.abs(v - topUV.u1) < 1e-6)
    const usesSide = Array.from(uvs).some((v) => Math.abs(v - sideUV.u0) < 1e-6 || Math.abs(v - sideUV.u1) < 1e-6)
    expect(usesTop).toBe(true)
    expect(usesSide).toBe(true)
  })

  it('bakes sky light into vertex colors (open brighter than sealed)', () => {
    const build = (sealed: boolean) => {
      const { world, lighting, mesher } = makeMesher()
      floor(world)
      world.setBlock(at(5, 1, 5), 'stone')
      if (sealed) {
        // 四周与顶部留一格空气间隙的密封罩：方块各面仍有面可画，但天空光为 0
        for (let y = 1; y <= 3; y++) {
          for (let x = 4; x <= 6; x++) for (let z = 4; z <= 6; z++) {
            const shell = x === 4 || x === 6 || z === 4 || z === 6 || y === 3
            if (shell && !(x === 5 && y === 1 && z === 5)) world.setBlock(at(x, y, z), 'stone')
          }
        }
      }
      lighting.computeAll()
      const geo = mesher.bakeSection('0,0,0')
      // 目标方块顶面顶点：x∈[5,6]、y=2、z∈[5,6]
      let max = 0
      for (let v = 0; v < geo.opaque.positions.length / 3; v++) {
        const px = geo.opaque.positions[v * 3], py = geo.opaque.positions[v * 3 + 1], pz = geo.opaque.positions[v * 3 + 2]
        if (py === 2 && px >= 5 && px <= 6 && pz >= 5 && pz <= 6) max = Math.max(max, geo.opaque.colors[v * 3])
      }
      return max
    }
    expect(build(false)).toBeGreaterThan(0.5)
    expect(build(true)).toBeLessThan(0.2)
  })
})
