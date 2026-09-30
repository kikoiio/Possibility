import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createEmptyWorld, type AssetManifest } from '@possibility/voxel-contract'
import { Assets } from '../engine/assets'
import { ghostCells } from '../engine/feedback'
import { MotionPreference } from '../engine/motion-preference'
import { Picker } from '../engine/picker'
import { WorldModel } from '../engine/world-model'

const at = (x: number, y: number, z: number) => ({ x, y, z })

function makeWorld() {
  const doc = createEmptyWorld({ width: 32, height: 16, depth: 32 }, 'mist-manor', 'test')
  const world = new WorldModel(doc)
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) world.setBlock(at(x, 0, z), 'grass')
  return world
}

describe('Picker', () => {
  it('vertical ray hits the expected ground cell and +y face', () => {
    const world = makeWorld()
    const picker = new Picker(world)
    const ray = new THREE.Ray(new THREE.Vector3(5.3, 10, 5.7), new THREE.Vector3(0, -1, 0))
    const hit = picker.pickVoxel(ray)!
    expect(hit.at).toEqual(at(5, 0, 5))
    expect(hit.face).toEqual({ x: 0, y: 1, z: 0 })
    expect(Picker.placementCell(hit)).toEqual(at(5, 1, 5))
  })

  it('angled ray hits a wall face (side face orientation)', () => {
    const world = makeWorld()
    world.setBlock(at(10, 1, 10), 'stone')
    const picker = new Picker(world)
    // 从 -x 方向水平射向石块
    const ray = new THREE.Ray(new THREE.Vector3(5, 1.5, 10.5), new THREE.Vector3(1, 0, 0))
    const hit = picker.pickVoxel(ray)!
    expect(hit.at).toEqual(at(10, 1, 10))
    expect(hit.face).toEqual({ x: -1, y: 0, z: 0 })
  })

  it('misses return null', () => {
    const world = makeWorld()
    const picker = new Picker(world)
    const ray = new THREE.Ray(new THREE.Vector3(5, 10, 5), new THREE.Vector3(0, 1, 0)) // 朝天
    expect(picker.pickVoxel(ray)).toBeNull()
  })

  it('pickObject reverse-maps hit cells to object ids', () => {
    const doc = createEmptyWorld({ width: 32, height: 16, depth: 32 }, 'mist-manor', 'test')
    const world = new WorldModel(doc)
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) world.setBlock(at(x, 0, z), 'grass')
    world.setBlock(at(5, 1, 5), 'stone')
    world.setBlock(at(5, 2, 5), 'lantern')
    doc.objectCells.push({ objectId: 'obj-lamp', cells: [at(5, 1, 5), at(5, 2, 5)] })
    const picker = new Picker(world)
    const ray = new THREE.Ray(new THREE.Vector3(5.5, 10, 5.5), new THREE.Vector3(0, -1, 0))
    expect(picker.pickObject(ray)).toBe('obj-lamp')
    const groundRay = new THREE.Ray(new THREE.Vector3(8.5, 10, 8.5), new THREE.Vector3(0, -1, 0))
    expect(picker.pickObject(groundRay)).toBeNull()
  })
})

describe('ghostCells', () => {
  it('expands set-block / fill / place-object into cells', () => {
    expect(ghostCells([{ kind: 'set-block', at: at(1, 1, 1), block: 'stone' }])).toEqual([at(1, 1, 1)])
    expect(ghostCells([{ kind: 'fill', from: at(0, 0, 0), to: at(1, 0, 1), block: 'stone' }])).toHaveLength(4)
    const placed = ghostCells([{ kind: 'place-object', objectType: 'stone-lantern', anchor: at(3, 1, 3), rotation: 0 }])
    expect(placed).toContainEqual(at(3, 1, 3))
    expect(placed).toContainEqual(at(3, 2, 3))
  })

  it('S2b: 资产 op 不展开格子(由 UI 层 showAssetGhost 负责预览)', () => {
    expect(ghostCells([
      { kind: 'place-asset', assetId: 'bld-hut-a', anchor: at(3, 1, 3), rotation: 0 },
      { kind: 'move-asset', placementId: 'ast-a', anchor: at(5, 1, 5) },
      { kind: 'remove-asset', placementId: 'ast-a' },
    ])).toEqual([])
  })
})

describe('Picker.pickAsset (S2b)', () => {
  const manifest: AssetManifest = {
    version: 2,
    assets: {
      'bld-hut-a': { id: 'bld-hut-a', category: 'building', url: '/x.glb', footprint: [2, 2], height: 2, thumbnail: '/x.png', sway: 0 },
    },
  }

  function makeAssets(anchor: [number, number, number]): Assets {
    const scene = new THREE.Scene()
    const assets = new Assets(scene, new MotionPreference())
    const prototype = new THREE.Group()
    prototype.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()))
    assets.setPrototype('bld-hut-a', prototype)
    assets.sync([{ id: 'ast-hit', assetId: 'bld-hut-a', anchor, rotation: 0, seed: 1 }], manifest)
    return assets
  }

  it('命中实例返回 placementId,未命中返回 null', () => {
    const world = makeWorld()
    const assets = makeAssets([4, 1, 4])
    const picker = new Picker(world, assets)
    const down = new THREE.Ray(new THREE.Vector3(4, 10, 4), new THREE.Vector3(0, -1, 0))
    expect(picker.pickAsset(down)).toBe('ast-hit')
    const miss = new THREE.Ray(new THREE.Vector3(25, 10, 25), new THREE.Vector3(0, -1, 0))
    expect(picker.pickAsset(miss)).toBeNull()
    assets.dispose()
  })

  it('多实例取最近命中', () => {
    const world = makeWorld()
    const scene = new THREE.Scene()
    const assets = new Assets(scene, new MotionPreference())
    const prototype = new THREE.Group()
    prototype.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()))
    assets.setPrototype('bld-hut-a', prototype)
    assets.sync([
      { id: 'ast-near', assetId: 'bld-hut-a', anchor: [4, 1, 4], rotation: 0, seed: 1 },
      { id: 'ast-far', assetId: 'bld-hut-a', anchor: [4, 3, 4], rotation: 0, seed: 2 },
    ], manifest)
    const picker = new Picker(world, assets)
    // 自上而下:先命中 y=3 的 ast-far(几何中心 3,±0.5)
    const down = new THREE.Ray(new THREE.Vector3(4, 10, 4), new THREE.Vector3(0, -1, 0))
    expect(picker.pickAsset(down)).toBe('ast-far')
    assets.dispose()
  })

  it('无 assets 注入时返回 null', () => {
    const picker = new Picker(makeWorld())
    const ray = new THREE.Ray(new THREE.Vector3(4, 10, 4), new THREE.Vector3(0, -1, 0))
    expect(picker.pickAsset(ray)).toBeNull()
  })
})
