import * as THREE from 'three'
import type { VoxelCoord } from '@possibility/voxel-contract'
import type { Assets } from './assets'
import type { WorldModel } from './world-model'

export interface VoxelPick { at: VoxelCoord; face: { x: number; y: number; z: number } }

const MAX_STEPS = 512

/** 射线与 AABB 求交（slab），返回进入距离；不相交返回 null */
function rayBoxEntry(ray: THREE.Ray, min: THREE.Vector3, max: THREE.Vector3): number | null {
  let tNear = -Infinity
  let tFar = Infinity
  for (const axis of ['x', 'y', 'z'] as const) {
    const origin = ray.origin[axis]
    const dir = ray.direction[axis]
    if (Math.abs(dir) < 1e-12) {
      if (origin < min[axis] || origin > max[axis]) return null
      continue
    }
    let t0 = (min[axis] - origin) / dir
    let t1 = (max[axis] - origin) / dir
    if (t0 > t1) [t0, t1] = [t1, t0]
    tNear = Math.max(tNear, t0)
    tFar = Math.min(tFar, t1)
    if (tNear > tFar) return null
  }
  return tFar < 0 ? null : Math.max(0, tNear)
}

/** 射线拾取：体素 DDA（格子 + 面朝向）与物体 id 反查（F15/F16 的地基） */
export class Picker {
  private readonly raycaster = new THREE.Raycaster()
  constructor(private world: WorldModel, private assets?: Assets) {}

  /** S2b GLB 实例拾取(F2):raycast 资产层 InstancedMesh,最近命中反查 placementId */
  pickAsset(ray: THREE.Ray): string | null {
    if (!this.assets) return null
    this.raycaster.ray.copy(ray)
    const hits = this.raycaster.intersectObject(this.assets.object, true)
    for (const hit of hits) {
      if (hit.object instanceof THREE.InstancedMesh && hit.instanceId !== undefined) {
        const placementId = this.assets.placementIdAt(hit.object, hit.instanceId)
        if (placementId) return placementId
      }
    }
    return null
  }

  /** Amanatides–Woo DDA：命中第一个非空气格，返回格子与入射面 */
  pickVoxel(ray: THREE.Ray): VoxelPick | null {
    const size = this.world.doc.size
    // 从射线进入世界包围盒处起步（相机可在世界外任意距离）
    const entry = rayBoxEntry(
      ray,
      new THREE.Vector3(-0.001, -0.001, -0.001),
      new THREE.Vector3(size.width + 0.001, size.height + 0.001, size.depth + 0.001),
    )
    if (entry === null) return null
    const start = ray.origin.clone().addScaledVector(ray.direction, entry + 1e-4)

    let x = Math.floor(start.x)
    let y = Math.floor(start.y)
    let z = Math.floor(start.z)
    const stepX = Math.sign(ray.direction.x) || 1
    const stepY = Math.sign(ray.direction.y) || 1
    const stepZ = Math.sign(ray.direction.z) || 1
    const tDeltaX = ray.direction.x !== 0 ? Math.abs(1 / ray.direction.x) : Infinity
    const tDeltaY = ray.direction.y !== 0 ? Math.abs(1 / ray.direction.y) : Infinity
    const tDeltaZ = ray.direction.z !== 0 ? Math.abs(1 / ray.direction.z) : Infinity
    const boundary = (s: number, p: number, step: number) => (step > 0 ? s + 1 - p : p - s)
    let tMaxX = tDeltaX === Infinity ? Infinity : boundary(x, start.x, stepX) * tDeltaX
    let tMaxY = tDeltaY === Infinity ? Infinity : boundary(y, start.y, stepY) * tDeltaY
    let tMaxZ = tDeltaZ === Infinity ? Infinity : boundary(z, start.z, stepZ) * tDeltaZ

    let face = { x: 0, y: 0, z: 0 }
    // 起点在盒内时无入射面；从盒外进入时按进入轴给一个初始面
    if (entry > 0) {
      const before = start.clone().addScaledVector(ray.direction, -0.01)
      face = {
        x: Math.floor(before.x) !== x ? -stepX : 0,
        y: Math.floor(before.y) !== y ? -stepY : 0,
        z: Math.floor(before.z) !== z ? -stepZ : 0,
      }
    }
    for (let steps = 0; steps < MAX_STEPS; steps++) {
      if (this.world.inBounds({ x, y, z }) && this.isPickable({ x, y, z })) {
        return { at: { x, y, z }, face }
      }
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        x += stepX
        tMaxX += tDeltaX
        face = { x: -stepX, y: 0, z: 0 }
      } else if (tMaxY <= tMaxZ) {
        y += stepY
        tMaxY += tDeltaY
        face = { x: 0, y: -stepY, z: 0 }
      } else {
        z += stepZ
        tMaxZ += tDeltaZ
        face = { x: 0, y: 0, z: -stepZ }
      }
      if (x < -1 || y < -1 || z < -1 || x > size.width || y > size.height || z > size.depth) return null
    }
    return null
  }

  private isPickable(at: VoxelCoord): boolean {
    return this.world.getBlock(at) !== 'air'
  }

  /** 命中格反查物体 id（物体占据格登记在 objectCells） */
  pickObject(ray: THREE.Ray): string | null {
    const hit = this.pickVoxel(ray)
    if (!hit) return null
    const key = `${hit.at.x},${hit.at.y},${hit.at.z}`
    for (const entry of this.world.doc.objectCells) {
      if (entry.cells.some((c) => `${c.x},${c.y},${c.z}` === key)) return entry.objectId
    }
    return null
  }

  /** 屏幕坐标 → 世界射线（含放置用的相邻格） */
  static rayFromScreen(screenX: number, screenY: number, canvas: HTMLCanvasElement, camera: THREE.Camera): THREE.Ray {
    const rect = canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((screenX - rect.left) / rect.width) * 2 - 1,
      -((screenY - rect.top) / rect.height) * 2 + 1,
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, camera)
    return raycaster.ray.clone()
  }

  /** 放置目标：命中面外侧的相邻格 */
  static placementCell(hit: VoxelPick): VoxelCoord {
    return { x: hit.at.x + hit.face.x, y: hit.at.y + hit.face.y, z: hit.at.z + hit.face.z }
  }
}
