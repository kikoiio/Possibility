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
  /** S2b:placementId → 组内实例下标(拖拽增量预览与拾取反查共用) */
  private readonly instanceLookup = new Map<string, { assetId: string; index: number }>()
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
  /** 注册资产原型(loadManifest 内部与单测共用) */
  setPrototype(assetId: string, object: THREE.Object3D): void {
    this.prototypes.set(assetId, object)
  }
  /** 已加载原型(ghost 预览克隆用);未加载返回 undefined */
  getPrototype(assetId: string): THREE.Object3D | undefined {
    return this.prototypes.get(assetId)
  }
  /** placementId → 组内位置(选中高亮求实例矩阵用) */
  instanceInfo(placementId: string): { assetId: string; index: number } | null {
    return this.instanceLookup.get(placementId) ?? null
  }
  /** 实例当前矩阵(含拖拽预览中的临时位置) */
  instanceMatrixOf(placementId: string): THREE.Matrix4 | null {
    const hit = this.instanceLookup.get(placementId)
    if (!hit) return null
    return this.groups.get(hit.assetId)?.base[hit.index]?.clone() ?? null
  }
  sync(placements: AssetPlacement[], manifest: AssetManifest): void {
    for (const group of this.groups.values()) for (const mesh of group.meshes) this.root.remove(mesh)
    this.groups.clear()
    this.instanceLookup.clear()
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
        // 无 id 的摆放(未经 ensureAssetPlacementIds 的旁路)不参与映射,拾取/预览打不到它
        if (placement.id) this.instanceLookup.set(placement.id, { assetId, index: i })
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

  /** S2b 拖拽跟手(N1):单实例矩阵增量更新,不触发全量 sync */
  setInstanceMatrix(placementId: string, matrix: THREE.Matrix4): void {
    const hit = this.instanceLookup.get(placementId)
    if (!hit) return
    const group = this.groups.get(hit.assetId)
    if (!group) return
    group.base[hit.index] = matrix.clone()
    for (const mesh of group.meshes) {
      mesh.setMatrixAt(hit.index, matrix)
      mesh.instanceMatrix.needsUpdate = true
    }
  }

  /** setInstanceMatrix 的语义封装:anchor(体素格) + 四分之一圈旋转 → 实例矩阵 */
  previewTransform(placementId: string, anchor: { x: number; y: number; z: number }, rotation: 0 | 1 | 2 | 3): void {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(anchor.x, anchor.y, anchor.z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotation * Math.PI / 2),
      new THREE.Vector3(1, 1, 1),
    )
    this.setInstanceMatrix(placementId, matrix)
  }

  /** S2b 拾取反查:InstancedMesh + instanceId → placementId */
  placementIdAt(mesh: THREE.Object3D, instanceId: number): string | null {
    for (const [placementId, hit] of this.instanceLookup) {
      if (hit.index !== instanceId) continue
      const group = this.groups.get(hit.assetId)
      if (group && group.meshes.includes(mesh as THREE.InstancedMesh)) return placementId
    }
    return null
  }
  /** S3a LOD:摇摆振幅缩放(overview 档 0 = 静止且零矩阵重算) */
  private swayScale = 1
  setSwayScale(scale: number): void {
    const next = Math.max(0, scale)
    if (next === this.swayScale) return
    const wasZero = this.swayScale === 0
    this.swayScale = next
    // 归零时把实例摆正一次(避免冻结在半倾姿态);从 0 恢复由下一帧 update 接管
    if (next === 0 && !wasZero) {
      for (const group of this.groups.values()) {
        group.base.forEach((matrix, i) => { for (const mesh of group.meshes) mesh.setMatrixAt(i, matrix) })
        for (const mesh of group.meshes) mesh.instanceMatrix.needsUpdate = true
      }
    }
  }
  get currentSwayScale(): number {
    return this.swayScale
  }

  update(dt: number): void {
    if (this.swayScale === 0) return // LOD overview 档:零矩阵重算
    this.time += dt * this.motion.animationTimeScale()
    for (const group of this.groups.values()) for (let i = 0; i < group.base.length; i++) {
      const sway = Math.sin(this.time * 1.7 + group.seeds[i] * 6.28) * group.sway * this.swayScale * this.motion.animationTimeScale()
      const matrix = group.base[i].clone().multiply(new THREE.Matrix4().makeRotationZ(sway))
      for (const mesh of group.meshes) mesh.setMatrixAt(i, matrix)
    }
    for (const group of this.groups.values()) for (const mesh of group.meshes) mesh.instanceMatrix.needsUpdate = true
  }
  dispose(): void { this.unsubscribe?.(); this.unsubscribe = null; for (const group of this.groups.values()) for (const mesh of group.meshes) mesh.dispose(); this.groups.clear(); this.instanceLookup.clear(); this.root.removeFromParent() }
}
