import * as THREE from 'three'
import type { BlockRegistry, VoxelCoord } from '@possibility/voxel-contract'
import type { CameraStrategy } from './camera'
import { isStandable } from './pathfinding'
import { PlayerBody, PLAYER, type MoveInput } from './player'
import type { WorldModel } from './world-model'

// ── S2b 第一视角相机(F1/F2)─────────────────────────────
// 眼位 = PlayerBody 脚底 + eye 高;朝向 = pointer lock 累积 yaw/pitch。
// pointer lock 不可用(SwiftShader e2e / 非安全上下文)时退化:
// 免锁定 mousemove 直接转视角(N5,保证 e2e 可操作)。

/** orbit 注视点 → 第一视角落点:垂直找可站立格,失败则螺旋外扩搜索(F1) */
export function findSpawnNear(
  world: WorldModel,
  registry: BlockRegistry,
  target: VoxelCoord,
  radius = 6,
): VoxelCoord | null {
  const { width, height, depth } = world.doc.size
  const clampX = Math.min(Math.max(Math.floor(target.x), 0), width - 1)
  const clampZ = Math.min(Math.max(Math.floor(target.z), 0), depth - 1)
  // 一柱内自底向上找最低可站立格(「向地面投影」:落在地面层而非屋顶)
  const columnSpawn = (x: number, z: number): VoxelCoord | null => {
    for (let y = 1; y <= height - 2; y++) {
      if (isStandable(world, registry, { x, y, z })) return { x, y, z }
    }
    return null
  }
  const direct = columnSpawn(clampX, clampZ)
  if (direct) return direct
  // 螺旋外扩
  for (let r = 1; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue // 只扫当前环
        const x = clampX + dx, z = clampZ + dz
        if (x < 0 || x >= width || z < 0 || z >= depth) continue
        const found = columnSpawn(x, z)
        if (found) return found
      }
    }
  }
  return null
}

const DOUBLE_SPACE_MS = 500 // 软渲染低帧率下事件派发有延迟,窗口放宽(e2e 实测可达 700ms 级抖动,500 内为连击)
const LOOK_SPEED = 0.0025
const MAX_PITCH = Math.PI / 2 - 0.01   // ±89°
const FIXED_STEP = 1 / 60              // 物理子步(N2:单步位移 < 0.5 格不穿墙)

export class WalkCameraStrategy implements CameraStrategy {
  readonly mode = 'walk'
  readonly camera: THREE.PerspectiveCamera
  readonly player: PlayerBody
  private yaw = 0
  private pitch = 0
  private keys = new Set<string>()
  private lastSpaceAt = -Infinity
  /** pointer lock 不可用/被拒时置 true:鼠标在画布上移动即转视角(N5 降级) */
  private fallbackLook = false
  private disposers: Array<() => void> = []
  /** 测试/调试读数 */
  get lookState() { return { yaw: this.yaw, pitch: this.pitch } }

  /** S3a 落地交接:让 walk 起始视角与落地补间终点一致(避免激活瞬间跳变) */
  setLook(yaw: number, pitch: number): void {
    this.yaw = yaw
    this.pitch = THREE.MathUtils.clamp(pitch, -MAX_PITCH, MAX_PITCH)
    this.update(0)
  }

  /** CameraStrategy 交接协议:玩家脚底位置(切回 orbit 的注视点) */
  get playerPosition() { return this.player.state.position }

  constructor(world: WorldModel, registry: BlockRegistry, spawn: VoxelCoord, aspect = 1) {
    this.player = new PlayerBody(world, registry, spawn)
    this.camera = new THREE.PerspectiveCamera(70, aspect, 0.1, 2000)
    this.camera.rotation.order = 'YXZ'
    this.update(0)
  }

  attach(canvas: HTMLCanvasElement): void {
    if (typeof window === 'undefined') return // 纯逻辑测试环境(node)无 DOM
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return
      this.keys.add(e.code)
      if (e.code === 'Space') {
        e.preventDefault()
        const now = performance.now()
        if (now - this.lastSpaceAt < DOUBLE_SPACE_MS) {
          this.player.setFlying(!this.player.state.flying)
          this.lastSpaceAt = -Infinity
        } else {
          this.lastSpaceAt = now
        }
      }
    }
    const onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code)
    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== canvas && !this.fallbackLook) return
      this.yaw -= e.movementX * LOOK_SPEED
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * LOOK_SPEED, -MAX_PITCH, MAX_PITCH)
    }
    const onClick = () => {
      if (document.pointerLockElement === canvas || this.fallbackLook) return
      if (typeof canvas.requestPointerLock !== 'function') { this.fallbackLook = true; return }
      try { canvas.requestPointerLock() } catch { this.fallbackLook = true }
    }
    const onLockError = () => { this.fallbackLook = true }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('click', onClick)
    document.addEventListener('pointerlockerror', onLockError)
    if (typeof canvas.requestPointerLock !== 'function') this.fallbackLook = true
    this.disposers = [
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => canvas.removeEventListener('mousemove', onMouseMove),
      () => canvas.removeEventListener('click', onClick),
      () => document.removeEventListener('pointerlockerror', onLockError),
    ]
  }

  detach(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    this.keys.clear()
    if (typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock()
  }

  fitToWorld(_size: unknown): void {
    // 第一视角不做构图适配:落点由 findSpawnNear 决定
  }

  /** 键盘状态 → 世界坐标移动分量(按 yaw 换算) */
  private readInput(): MoveInput {
    const fwd = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0)
    const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0)
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw)
    return {
      moveX: -fwd * sin + strafe * cos,
      moveZ: -fwd * cos - strafe * sin,
      jump: this.keys.has('Space'),
      ascend: this.keys.has('Space'),
      descend: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
    }
  }

  update(dt: number): void {
    // 固定子步驱动物理(低帧率不放大单步位移)
    let remaining = Math.min(dt, 0.1)
    while (remaining > 1e-9) {
      const h = Math.min(remaining, FIXED_STEP)
      this.player.step(h, this.readInput())
      remaining -= h
    }
    const p = this.player.state.position
    this.camera.position.set(p.x, p.y + PLAYER.eye, p.z)
    this.camera.rotation.set(this.pitch, this.yaw, 0)
  }
}
