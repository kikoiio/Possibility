import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { AssetManifest } from '@possibility/voxel-contract'
import { Assets } from '../engine/assets'
import { BuildFeedback } from '../engine/feedback'
import { MotionPreference } from '../engine/motion-preference'

const manifest: AssetManifest = {
  version: 2,
  assets: {
    'bld-hut-a': { id: 'bld-hut-a', category: 'building', url: '/x.glb', footprint: [2, 2], height: 2, thumbnail: '/x.png', sway: 0 },
  },
}

function makeAssets(anchor: [number, number, number] = [4, 1, 4]): Assets {
  const scene = new THREE.Scene()
  const assets = new Assets(scene, new MotionPreference())
  const prototype = new THREE.Group()
  prototype.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()))
  assets.setPrototype('bld-hut-a', prototype)
  assets.sync([{ id: 'ast-a', assetId: 'bld-hut-a', anchor, rotation: 0, seed: 1 }], manifest)
  return assets
}

describe('BuildFeedback 资产 ghost 与选中 (S2b)', () => {
  it('showAssetGhost 展示半透明克隆+占地指示,dismiss 清除', () => {
    const scene = new THREE.Scene()
    const assets = makeAssets()
    const feedback = new BuildFeedback(scene, assets)
    feedback.showAssetGhost('bld-hut-a', [2, 2], { x: 6, y: 1, z: 6 }, 0, true)
    expect(feedback.assetGhostActive).toBe(true)
    feedback.dismissAssetGhost()
    expect(feedback.assetGhostActive).toBe(false)
    assets.dispose()
    feedback.dispose()
  })

  it('未知资产不展示 ghost', () => {
    const scene = new THREE.Scene()
    const feedback = new BuildFeedback(scene, makeAssets())
    feedback.showAssetGhost('bld-nope', [2, 2], { x: 0, y: 1, z: 0 }, 0, true)
    expect(feedback.assetGhostActive).toBe(false)
    feedback.dispose()
  })

  it('setAssetSelected 生成选中框并随 null 清除', () => {
    const scene = new THREE.Scene()
    const assets = makeAssets([4, 1, 4])
    const feedback = new BuildFeedback(scene, assets)
    feedback.setAssetSelected('ast-a')
    expect(feedback.assetSelectionActive).toBe(true)
    feedback.setAssetSelected(null)
    expect(feedback.assetSelectionActive).toBe(false)
    // 未知 placementId 不生成
    feedback.setAssetSelected('nope')
    expect(feedback.assetSelectionActive).toBe(false)
    assets.dispose()
    feedback.dispose()
  })

  it('无 assets 注入时 ghost/选中均为 no-op', () => {
    const scene = new THREE.Scene()
    const feedback = new BuildFeedback(scene)
    feedback.showAssetGhost('bld-hut-a', [2, 2], { x: 0, y: 1, z: 0 }, 0, true)
    feedback.setAssetSelected('ast-a')
    expect(feedback.assetGhostActive).toBe(false)
    expect(feedback.assetSelectionActive).toBe(false)
    feedback.dispose()
  })

  it('showValidationFailure 展示红色 ghost (Phase 3)', () => {
    const scene = new THREE.Scene()
    const feedback = new BuildFeedback(scene)
    const handle = feedback.showValidationFailure([{ kind: 'set-block', at: { x: 3, y: 1, z: 3 }, block: 'stone' }])
    expect(feedback.ghostActive).toBe(true)
    expect(feedback.ghostColor).toBe(0xef4444)
    handle.dismiss()
    expect(feedback.ghostActive).toBe(false)
    feedback.dispose()
  })
})
