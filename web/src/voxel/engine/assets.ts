import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { AssetPlacement } from '@possibility/voxel-contract'
import type { MotionPreference } from './motion-preference'

export interface VegetationManifestEntry { url: string; category: 'vegetation'; sway: number; footprint: [number, number] }
export interface VegetationManifest { version: 1; assets: Record<string, VegetationManifestEntry> }

type InstanceGroup = { mesh: THREE.InstancedMesh; sway: number; seeds: Float32Array; base: THREE.Matrix4[] }
function hash(seed: number): number { let x = seed | 0; x = Math.imul(x ^ (x >>> 16), 0x45d9f3b); x = Math.imul(x ^ (x >>> 16), 0x45d9f3b); return ((x ^ (x >>> 16)) >>> 0) / 0x100000000 }

/** Async glTF vegetation cache and instanced renderer. Voxel startup never depends on this optional layer. */
export class Assets {
  readonly object = new THREE.Group()
  private readonly loader = new GLTFLoader()
  private readonly prototypes = new Map<string, THREE.Object3D>()
  private readonly groups = new Map<string, InstanceGroup>()
  private unsubscribe: (() => void) | null = null
  private time = 0

  private readonly root = this.object
  constructor(scene: THREE.Scene, private readonly motion: MotionPreference) { scene.add(this.root) }
  async loadManifest(url = '/voxel-assets/mist-manor/vegetation/manifest.json'): Promise<VegetationManifest> {
    const response = await fetch(url); if (!response.ok) throw new Error(`vegetation manifest failed: ${response.status}`)
    const manifest = await response.json() as VegetationManifest
    await Promise.all(Object.entries(manifest.assets).map(async ([assetId, entry]) => {
      const gltf = await this.loader.loadAsync(entry.url)
      this.prototypes.set(assetId, gltf.scene)
    }))
    return manifest
  }
  sync(placements: AssetPlacement[], manifest: VegetationManifest): void {
    for (const group of this.groups.values()) this.root.remove(group.mesh)
    this.groups.clear()
    for (const [assetId, entry] of Object.entries(manifest.assets)) {
      const items = placements.filter((p) => p.assetId === assetId)
      const prototype = this.prototypes.get(assetId)
      if (!prototype || items.length === 0) continue
      const source = prototype.children.find((child) => child instanceof THREE.Mesh) as THREE.Mesh | undefined
      if (!source || !source.geometry || !source.material) continue
      const mesh = new THREE.InstancedMesh(source.geometry, source.material, items.length)
      mesh.castShadow = true; mesh.receiveShadow = true
      const seeds = new Float32Array(items.length), base: THREE.Matrix4[] = []
      items.forEach((placement, i) => {
        const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...placement.anchor), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), placement.rotation * Math.PI / 2), new THREE.Vector3(1, 1, 1))
        mesh.setMatrixAt(i, matrix); base.push(matrix.clone()); seeds[i] = hash(placement.seed)
      })
      mesh.instanceMatrix.needsUpdate = true; this.root.add(mesh)
      this.groups.set(assetId, { mesh, sway: entry.sway, seeds, base })
    }
  }
  update(dt: number): void {
    this.time += dt * this.motion.animationTimeScale()
    for (const group of this.groups.values()) for (let i = 0; i < group.base.length; i++) {
      const sway = Math.sin(this.time * 1.7 + group.seeds[i] * 6.28) * group.sway * this.motion.animationTimeScale()
      const matrix = group.base[i].clone().multiply(new THREE.Matrix4().makeRotationZ(sway))
      group.mesh.setMatrixAt(i, matrix)
    }
    for (const group of this.groups.values()) group.mesh.instanceMatrix.needsUpdate = true
  }
  dispose(): void { this.unsubscribe?.(); this.unsubscribe = null; for (const group of this.groups.values()) group.mesh.dispose(); this.groups.clear(); this.root.removeFromParent() }
}
