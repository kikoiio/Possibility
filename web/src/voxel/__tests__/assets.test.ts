import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { AssetManifest, AssetPlacement } from '@possibility/voxel-contract'
import { Assets } from '../engine/assets'
import { MotionPreference } from '../engine/motion-preference'

const manifest: AssetManifest = {
  version: 2,
  assets: {
    'bld-hut-a': { id: 'bld-hut-a', category: 'building', url: '/x.glb', footprint: [2, 2], height: 2, thumbnail: '/x.png', sway: 0 },
    'veg-tree-a': { id: 'veg-tree-a', category: 'vegetation', url: '/x.glb', footprint: [1, 1], height: 3, thumbnail: '/x.png', sway: 0.1 },
  },
}

const placement = (over: Partial<AssetPlacement> = {}): AssetPlacement => ({
  id: 'ast-a', assetId: 'bld-hut-a', anchor: [4, 1, 4], rotation: 0, seed: 1, ...over,
})

function makeAssets(): Assets {
  const scene = new THREE.Scene()
  const assets = new Assets(scene, new MotionPreference())
  const prototype = new THREE.Group()
  prototype.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()))
  assets.setPrototype('bld-hut-a', prototype)
  assets.setPrototype('veg-tree-a', prototype.clone())
  return assets
}

describe('Assets (S2b 增量预览与拾取映射)', () => {
  it('sync 建立 placementId → 实例映射,instanceCount 正确', () => {
    const assets = makeAssets()
    assets.sync([placement(), placement({ id: 'ast-b', assetId: 'veg-tree-a', anchor: [8, 1, 8] })], manifest)
    expect(assets.instanceCount).toBe(2)
    expect(assets.placementIdAt((assets.object.children[0] as THREE.InstancedMesh), 0)).toBe('ast-a')
    assets.dispose()
  })

  it('previewTransform 只动目标实例,其余实例矩阵不变', () => {
    const assets = makeAssets()
    assets.sync([
      placement(),
      placement({ id: 'ast-b', anchor: [10, 1, 10] }),
    ], manifest)
    const mesh = assets.object.children[0] as THREE.InstancedMesh
    const before = new THREE.Matrix4()
    mesh.getMatrixAt(1, before)

    assets.previewTransform('ast-a', { x: 20, y: 1, z: 20 }, 2)

    const moved = new THREE.Matrix4()
    mesh.getMatrixAt(0, moved)
    expect(new THREE.Vector3().setFromMatrixPosition(moved).toArray()).toEqual([20, 1, 20])
    const after = new THREE.Matrix4()
    mesh.getMatrixAt(1, after)
    expect(after.equals(before)).toBe(true)
    assets.dispose()
  })

  it('placementIdAt 反查命中与未命中', () => {
    const assets = makeAssets()
    assets.sync([placement(), placement({ id: 'ast-b', anchor: [10, 1, 10] })], manifest)
    const mesh = assets.object.children[0] as THREE.InstancedMesh
    expect(assets.placementIdAt(mesh, 1)).toBe('ast-b')
    expect(assets.placementIdAt(mesh, 7)).toBeNull()
    expect(assets.placementIdAt(new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1), 0)).toBeNull()
    assets.dispose()
  })

  it('无 id 的摆放不进入映射(旁路防御)', () => {
    const assets = makeAssets()
    assets.sync([placement({ id: undefined })], manifest)
    expect(assets.instanceCount).toBe(1)
    const mesh = assets.object.children[0] as THREE.InstancedMesh
    expect(assets.placementIdAt(mesh, 0)).toBeNull()
    assets.dispose()
  })
})
