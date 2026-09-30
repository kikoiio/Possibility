import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { validateAssetManifest, type AssetManifest, type AssetPlacement } from '@possibility/voxel-contract'
import type { MotionPreference } from './motion-preference'

type InstanceGroup = { meshes: THREE.InstancedMesh[]; sway: number; seeds: Float32Array; base: THREE.Matrix4[] }
function hash(seed: number): number { let x = seed | 0; x = Math.imul(x ^ (x >>> 16), 0x45d9f3b); x = Math.imul(x ^ (x >>> 16), 0x45d9f3b); return ((x ^ (x >>> 16)) >>> 0) / 0x100000000 }

/**
 * Async glTF asset cache and instanced renderer, backed by the global asset library
 * (`/voxel-assets/library/manifest.json`, S2a). Voxel startup never depends on this optional layer.
 */
export class Assets {
  readonly object = new THREE.Group()
  private readonly loader = new GLTFLoader()
  private readonly prototypes = new Map<string, THREE.Object3D>()
  private readonly groups = new Map<string, InstanceGroup>()
  private unsubscribe: (() => void) | null = null
  private time = 0

  get instanceCount(): number {
    let count = 0
    for (const group of this.groups.values()) count += group.meshes[0]?.count ?? 0
    return count
  }

  private readonly root = this.object
  constructor(scene: THREE.Scene, private readonly motion: MotionPreference) { scene.add(this.root) }
  async loadManifest(): Promise<AssetManifest> {
    const response = await fetch('/voxel-assets/library/manifest.json')
    if (!response.ok) throw new Error(`asset manifest failed: ${response.status}`)
    const parsed = validateAssetManifest(await response.json())
    if (!parsed.ok) throw new Error(`asset manifest invalid: ${parsed.issues[0]?.message ?? 'unknown'}`)
    await Promise.all(Object.entries(parsed.manifest.assets).map(async ([assetId, entry]) => {
      const gltf = await this.loader.loadAsync(entry.url)
      this.prototypes.set(assetId, gltf.scene)
    }))
    return parsed.manifest
  }
  sync(placements: AssetPlacement[], manifest: AssetManifest): void {
    for (const group of this.groups.values()) for (const mesh of group.meshes) this.root.remove(mesh)
    this.groups.clear()
    for (const [assetId, entry] of Object.entries(manifest.assets)) {
      const items = placements.filter((p) => p.assetId === assetId)
      const prototype = this.prototypes.get(assetId)
      if (!prototype || items.length === 0) continue
      // 多材质资产(one primitive → one Mesh):每个子网格一个 InstancedMesh,共享同一套实例矩阵
      const sources: THREE.Mesh[] = []
      prototype.traverse((child) => {
        if (child instanceof THREE.Mesh && child.geometry && child.material) sources.push(child)
      })
      if (sources.length === 0) continue
      const seeds = new Float32Array(items.length), base: THREE.Matrix4[] = []
      items.forEach((placement, i) => {
        const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...placement.anchor), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), placement.rotation * Math.PI / 2), new THREE.Vector3(1, 1, 1))
        base.push(matrix); seeds[i] = hash(placement.seed)
      })
      const meshes = sources.map((source) => {
        const mesh = new THREE.InstancedMesh(source.geometry, source.material, items.length)
        mesh.castShadow = true; mesh.receiveShadow = true
        base.forEach((matrix, i) => mesh.setMatrixAt(i, matrix))
        mesh.instanceMatrix.needsUpdate = true; this.root.add(mesh)
        return mesh
      })
      this.groups.set(assetId, { meshes, sway: entry.sway, seeds, base })
    }
  }
  update(dt: number): void {
    this.time += dt * this.motion.animationTimeScale()
    for (const group of this.groups.values()) for (let i = 0; i < group.base.length; i++) {
      const sway = Math.sin(this.time * 1.7 + group.seeds[i] * 6.28) * group.sway * this.motion.animationTimeScale()
      const matrix = group.base[i].clone().multiply(new THREE.Matrix4().makeRotationZ(sway))
      for (const mesh of group.meshes) mesh.setMatrixAt(i, matrix)
    }
    for (const group of this.groups.values()) for (const mesh of group.meshes) mesh.instanceMatrix.needsUpdate = true
  }
  dispose(): void { this.unsubscribe?.(); this.unsubscribe = null; for (const group of this.groups.values()) for (const mesh of group.meshes) mesh.dispose(); this.groups.clear(); this.root.removeFromParent() }
}
