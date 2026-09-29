import * as THREE from 'three'
import { objectFootprint, type EditOperation, type VoxelCoord } from '@possibility/voxel-contract'

interface Effect { update(dt: number): boolean; dispose(): void }

export interface GhostHandle { dismiss(): void }

const MAX_FRAGMENTS = 96

/** 编辑的动画反馈：放置弹落、挖掘碎裂粒子、幽灵预览体（F14, AC11/AC14） */
export class BuildFeedback {
  private effects: Effect[] = []
  private ghostGroup: THREE.Group | null = null
  private hoverMesh: THREE.Mesh | null = null
  private fragmentPoints: THREE.Points
  private fragmentPos = new Float32Array(MAX_FRAGMENTS * 3)
  private fragmentVel = new Float32Array(MAX_FRAGMENTS * 3)
  private fragmentLife = new Float32Array(MAX_FRAGMENTS)
  private fragmentHead = 0

  constructor(private scene: THREE.Scene) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.fragmentPos, 3))
    this.fragmentPoints = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xbfa77a, size: 0.14, transparent: true, opacity: 0.95, sizeAttenuation: true,
    }))
    this.fragmentPoints.frustumCulled = false
    scene.add(this.fragmentPoints)
  }

  /** 放置反馈：目标格弹性框 + 少量碎屑 */
  playPlace(at: VoxelCoord): void {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1.04, 1.04, 1.04),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
    )
    mesh.position.set(at.x + 0.5, at.y + 0.5, at.z + 0.5)
    mesh.scale.setScalar(1.25)
    this.scene.add(mesh)
    let life = 0.28
    const self = this
    this.effects.push({
      update(dt) {
        life -= dt
        const t = Math.max(0, life / 0.28)
        mesh.scale.setScalar(1 + 0.25 * t)
        ;(mesh.material as THREE.MeshBasicMaterial).opacity = 0.35 * t
        if (life <= 0) {
          self.scene.remove(mesh)
          mesh.geometry.dispose()
          ;(mesh.material as THREE.Material).dispose()
          return false
        }
        return true
      },
      dispose() { self.scene.remove(mesh) },
    })
    this.burst(at, 6, 1.6)
  }

  /** 挖掘反馈：碎裂粒子四散 */
  playDig(at: VoxelCoord): void {
    this.burst(at, 16, 3.2)
  }

  private burst(at: VoxelCoord, count: number, speed: number): void {
    for (let n = 0; n < count; n++) {
      const i = this.fragmentHead
      this.fragmentHead = (this.fragmentHead + 1) % MAX_FRAGMENTS
      this.fragmentPos[i * 3] = at.x + 0.5
      this.fragmentPos[i * 3 + 1] = at.y + 0.5
      this.fragmentPos[i * 3 + 2] = at.z + 0.5
      const theta = Math.random() * Math.PI * 2
      const up = Math.random() * 0.9 + 0.2
      this.fragmentVel[i * 3] = Math.cos(theta) * speed * Math.random()
      this.fragmentVel[i * 3 + 1] = up * speed
      this.fragmentVel[i * 3 + 2] = Math.sin(theta) * speed * Math.random()
      this.fragmentLife[i] = 0.45 + Math.random() * 0.2
    }
  }

  /** 悬停目标格高亮（方块级编辑的瞄准框） */
  setHover(at: VoxelCoord | null): void {
    if (!at) {
      if (this.hoverMesh) this.hoverMesh.visible = false
      return
    }
    if (!this.hoverMesh) {
      this.hoverMesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.05, 1.05, 1.05),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }),
      )
      this.scene.add(this.hoverMesh)
    }
    this.hoverMesh.visible = true
    this.hoverMesh.position.set(at.x + 0.5, at.y + 0.5, at.z + 0.5)
  }

  /** AI 编辑预览：半透明幽灵体覆盖将变更的格子 */
  showGhost(ops: EditOperation[]): GhostHandle {
    this.dismissGhost()
    const cells = ghostCells(ops)
    if (cells.length === 0) return { dismiss: () => {} }
    const group = new THREE.Group()
    const material = new THREE.MeshBasicMaterial({ color: 0x6ee7a0, transparent: true, opacity: 0.4, depthWrite: false })
    for (const at of cells) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.02, 1.02, 1.02), material)
      mesh.position.set(at.x + 0.5, at.y + 0.5, at.z + 0.5)
      group.add(mesh)
    }
    this.ghostGroup = group
    this.scene.add(group)
    return { dismiss: () => this.dismissGhost() }
  }

  private dismissGhost(): void {
    if (this.ghostGroup) {
      this.scene.remove(this.ghostGroup)
      for (const child of this.ghostGroup.children) {
        ;(child as THREE.Mesh).geometry.dispose()
      }
      ;((this.ghostGroup.children[0] as THREE.Mesh | undefined)?.material as THREE.Material | undefined)?.dispose()
      this.ghostGroup = null
    }
  }

  /** 幽灵预览是否展示中（e2e 探针） */
  get ghostActive(): boolean {
    return this.ghostGroup !== null
  }

  update(dt: number): void {
    this.effects = this.effects.filter((e) => e.update(dt))
    let anyAlive = false
    for (let i = 0; i < MAX_FRAGMENTS; i++) {
      if (this.fragmentLife[i] <= 0) continue
      anyAlive = true
      this.fragmentLife[i] -= dt
      this.fragmentVel[i * 3 + 1] -= dt * 9
      this.fragmentPos[i * 3] += this.fragmentVel[i * 3] * dt
      this.fragmentPos[i * 3 + 1] += this.fragmentVel[i * 3 + 1] * dt
      this.fragmentPos[i * 3 + 2] += this.fragmentVel[i * 3 + 2] * dt
      if (this.fragmentLife[i] <= 0) this.fragmentPos[i * 3 + 1] = -100
    }
    if (anyAlive) this.fragmentPoints.geometry.attributes.position.needsUpdate = true
  }

  dispose(): void {
    this.dismissGhost()
    if (this.hoverMesh) {
      this.scene.remove(this.hoverMesh)
      this.hoverMesh.geometry.dispose()
      ;(this.hoverMesh.material as THREE.Material).dispose()
      this.hoverMesh = null
    }
    this.effects = []
    this.scene.remove(this.fragmentPoints)
    this.fragmentPoints.geometry.dispose()
    ;(this.fragmentPoints.material as THREE.Material).dispose()
  }
}

/** 从编辑操作提取将变更的格子（幽灵预览用） */
export function ghostCells(ops: EditOperation[]): VoxelCoord[] {
  const cells: VoxelCoord[] = []
  for (const op of ops) {
    switch (op.kind) {
      case 'set-block':
        cells.push(op.at)
        break
      case 'fill': {
        const [x0, x1] = [Math.min(op.from.x, op.to.x), Math.max(op.from.x, op.to.x)]
        const [y0, y1] = [Math.min(op.from.y, op.to.y), Math.max(op.from.y, op.to.y)]
        const [z0, z1] = [Math.min(op.from.z, op.to.z), Math.max(op.from.z, op.to.z)]
        for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) cells.push({ x, y, z })
        break
      }
      case 'place-object':
        cells.push(...objectFootprint(op.objectType, op.anchor, op.rotation))
        break
      case 'move-object':
      case 'remove-object':
        break // 由 UI 层高亮物体本身，此处不展开
    }
  }
  return cells
}
