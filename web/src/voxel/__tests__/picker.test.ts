import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createEmptyWorld } from '@possibility/voxel-contract'
import { ghostCells } from '../engine/feedback'
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
})
