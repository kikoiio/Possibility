import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createBlockRegistry, createEmptyWorld } from '@possibility/voxel-contract'
import { TextureAtlas, type AtlasJson } from '../engine/atlas'
import { LightingEngine } from '../engine/lighting'
import { DEFAULT_BAKE_ENV, Mesher, type MeshData } from '../engine/mesher'
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

/**
 * 草地地面（y=0）+ 石沿 3×3 水池（水 y=1，x/z 5..7，石沿 x/z 4..8）
 * + 无沿 3×3 开阔水面（x/z 11..13，四周是空气）+ 一块玻璃（12,1,2）。
 */
function makeScene() {
  const doc = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'test')
  const world = new WorldModel(doc)
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) world.setBlock(at(x, 0, z), 'grass')
  for (let z = 4; z <= 8; z++) for (let x = 4; x <= 8; x++) world.setBlock(at(x, 1, z), 'stone')
  for (let z = 5; z <= 7; z++) for (let x = 5; x <= 7; x++) world.setBlock(at(x, 1, z), 'water')
  for (let z = 11; z <= 13; z++) for (let x = 11; x <= 13; x++) world.setBlock(at(x, 1, z), 'water')
  world.setBlock(at(12, 1, 2), 'glass')
  const lighting = new LightingEngine(world, registry)
  lighting.computeAll()
  const mesher = new Mesher(world, registry, testAtlas(), lighting)
  return { world, lighting, mesher }
}

/** 读指定位置 + 法向顶点的 foam 值（找不到返回 null） */
function foamAt(data: MeshData, x: number, y: number, z: number, nx: number, ny: number, nz: number): number | null {
  return foamsAt(data, x, y, z, nx, ny, nz)[0] ?? null
}

/** 该位置 + 法向的全部顶点 foam 值（同位置可被多格面角共享，需区分） */
function foamsAt(data: MeshData, x: number, y: number, z: number, nx: number, ny: number, nz: number): number[] {
  const out: number[] = []
  for (let v = 0; v < data.positions.length / 3; v++) {
    if (
      Math.abs(data.positions[v * 3] - x) < 1e-6 &&
      Math.abs(data.positions[v * 3 + 1] - y) < 1e-6 &&
      Math.abs(data.positions[v * 3 + 2] - z) < 1e-6 &&
      data.normals[v * 3] === nx && data.normals[v * 3 + 1] === ny && data.normals[v * 3 + 2] === nz
    ) out.push(data.foam[v])
  }
  return out
}

const UP: [number, number, number] = [0, 1, 0]

describe('Mesher 下沉水面与白沫', () => {
  it('水顶面顶点下沉到 格底 + 0.875', () => {
    const { mesher } = makeScene()
    const geo = mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV).translucent
    // 池中央格 (6,1,6) 顶面四角 y 均为 1.875，且找不到旧高度 2 的水顶面
    expect(foamAt(geo, 6, 1.875, 6, ...UP)).not.toBeNull()
    expect(foamAt(geo, 7, 1.875, 7, ...UP)).not.toBeNull()
    expect(foamAt(geo, 6, 2, 6, ...UP)).toBeNull()
  })

  it('非水方块顶面不下沉（石头/玻璃保持整格高）', () => {
    const { mesher } = makeScene()
    const opaque = mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV).opaque
    // 石沿角块 (4,1,4) 顶面角点 y=2（未被水覆盖的外角）
    let found = false
    for (let v = 0; v < opaque.positions.length / 3; v++) {
      if (opaque.positions[v * 3] === 4 && opaque.positions[v * 3 + 1] === 2 && opaque.positions[v * 3 + 2] === 4) found = true
    }
    expect(found).toBe(true)
  })

  it('岸边格 foam=1，石沿包围的水池边缘四周成立', () => {
    const { mesher } = makeScene()
    const geo = mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV).translucent
    // 池角 (5,1.875,5)：只有边缘格 (5,1,5) 的水面角 → 全部 foam=1
    const corner = foamsAt(geo, 5, 1.875, 5, ...UP)
    expect(corner.length).toBeGreaterThan(0)
    for (const f of corner) expect(f).toBe(1)
  })

  it('水池中央格与开阔水面中央 foam=0', () => {
    const { mesher } = makeScene()
    const geo = mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV).translucent
    // 中央格 (6,1,6) 的角与边缘格共享位置：同位置须同时存在 foam=0（中央格自身角）
    for (const [x, z] of [[6, 6], [7, 6], [6, 7], [7, 7]] as const) {
      const values = foamsAt(geo, x, 1.875, z, ...UP)
      expect(values).toContain(0)
      expect(values).toContain(1) // 共享位置的边缘格角仍为 1
    }
    // 开阔水面中央 (12,1,12)：四邻皆水 → 含 foam=0
    expect(foamsAt(geo, 12, 1.875, 12, ...UP)).toContain(0)
    // 开阔水面边缘 (11,1,11)：邻空气 → 全部 1
    const edge = foamsAt(geo, 11, 1.875, 11, ...UP)
    expect(edge.length).toBeGreaterThan(0)
    for (const f of edge) expect(f).toBe(1)
  })

  it('非流体半透明方块（玻璃）foam 恒 0', () => {
    const { mesher } = makeScene()
    const geo = mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV).translucent
    // 玻璃在 (12,1,2)，顶面角 (12,2,12)→(13,2,13) 区域 foam 全 0
    expect(foamAt(geo, 12, 2, 2, ...UP)).toBe(0)
    expect(foamAt(geo, 13, 2, 3, ...UP)).toBe(0)
  })

  it('foam 属性长度与顶点数一致，非水面（侧面/底面）为 0', () => {
    const { mesher } = makeScene()
    const geo = mesher.bakeSection('0,0,0', DEFAULT_BAKE_ENV).translucent
    expect(geo.foam.length).toBe(geo.positions.length / 3)
    // 水侧面（法向 ±x/±z）foam 恒 0
    for (let v = 0; v < geo.foam.length; v++) {
      if (geo.normals[v * 3 + 1] === 0) expect(geo.foam[v]).toBe(0)
    }
  })
})
