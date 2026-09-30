import * as THREE from 'three'
import type { VoxelSize } from '@possibility/voxel-contract'

/** 相机策略接口：第一视角模式 = 新增策略实现(S2b) */
export interface CameraStrategy {
  readonly mode: string
  readonly camera: THREE.PerspectiveCamera
  attach?(canvas: HTMLCanvasElement): void
  detach?(): void
  update(dt: number): void
  fitToWorld(size: VoxelSize): void
  /** walk 策略暴露玩家脚底位置(切回 orbit 时交接注视点) */
  readonly playerPosition?: { x: number; y: number; z: number } | null
}

const MIN_DISTANCE = 6
const MAX_DISTANCE = 400
const MIN_PHI = 0.25
const MAX_PHI = 1.45

/** orbit 相机位姿(S1 分屏联动):整体读出/写入,walk 模式不适用 */
export interface OrbitPose {
  theta: number
  phi: number
  distance: number
  target: { x: number; y: number; z: number }
}

/** 等距 3D 环绕相机：旋转 / 缩放 / 平移，初始构图自动适配世界尺寸 */
export class OrbitCameraStrategy implements CameraStrategy {
  readonly mode = 'orbit'
  readonly camera: THREE.PerspectiveCamera
  private target = new THREE.Vector3()
  private theta = Math.PI * 0.25
  private phi = 0.96          // 俯角：接近经典等距视角
  private distance = 48
  private dragging: 'rotate' | 'pan' | null = null
  private lastX = 0
  private lastY = 0
  private disposers: Array<() => void> = []

  constructor(aspect = 1) {
    this.camera = new THREE.PerspectiveCamera(35, aspect, 0.1, 2000)
    this.update(0)
  }

  attach(canvas: HTMLCanvasElement): void {
    const onPointerDown = (e: PointerEvent) => {
      this.dragging = e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : 'rotate'
      this.lastX = e.clientX
      this.lastY = e.clientY
      canvas.setPointerCapture(e.pointerId)
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!this.dragging) return
      const dx = e.clientX - this.lastX
      const dy = e.clientY - this.lastY
      this.lastX = e.clientX
      this.lastY = e.clientY
      if (this.dragging === 'rotate') {
        this.theta -= dx * 0.008
        this.phi = THREE.MathUtils.clamp(this.phi - dy * 0.006, MIN_PHI, MAX_PHI)
      } else {
        this.pan(dx, dy)
      }
    }
    const onPointerUp = (e: PointerEvent) => {
      this.dragging = null
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      this.distance = THREE.MathUtils.clamp(this.distance * (e.deltaY > 0 ? 1.1 : 0.9), MIN_DISTANCE, MAX_DISTANCE)
    }
    const onContextMenu = (e: Event) => e.preventDefault()
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', onContextMenu)
    this.disposers = [
      () => canvas.removeEventListener('pointerdown', onPointerDown),
      () => canvas.removeEventListener('pointermove', onPointerMove),
      () => canvas.removeEventListener('pointerup', onPointerUp),
      () => canvas.removeEventListener('wheel', onWheel),
      () => canvas.removeEventListener('contextmenu', onContextMenu),
    ]
  }

  detach(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
  }

  /** 屏幕平移 → 地平面上沿相机朝向的目标点位移 */
  private pan(dx: number, dy: number): void {
    const scale = this.distance * 0.0016
    const forward = new THREE.Vector3(-Math.sin(this.theta), 0, -Math.cos(this.theta))
    const right = new THREE.Vector3(-forward.z, 0, forward.x)
    this.target.addScaledVector(right, -dx * scale)
    this.target.addScaledVector(forward, -dy * scale)
  }

  fitToWorld(size: VoxelSize): void {
    this.target.set(size.width / 2, Math.min(size.height * 0.3, 10), size.depth / 2)
    const radius = Math.hypot(size.width, size.depth, size.height) / 2
    const fov = THREE.MathUtils.degToRad(this.camera.fov)
    this.distance = THREE.MathUtils.clamp((radius / Math.sin(fov / 2)) * 0.9, MIN_DISTANCE, MAX_DISTANCE)
    this.update(0)
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
  }

  update(_dt: number): void {
    const sinPhi = Math.sin(this.phi)
    this.camera.position.set(
      this.target.x + this.distance * sinPhi * Math.sin(this.theta),
      this.target.y + this.distance * Math.cos(this.phi),
      this.target.z + this.distance * sinPhi * Math.cos(this.theta),
    )
    this.camera.lookAt(this.target)
  }

  /** 测试 / 调试读数 */
  get state() {
    return { theta: this.theta, phi: this.phi, distance: this.distance, target: this.target.clone() }
  }

  /** walk → orbit 交接:注视点跟随玩家位置(S2b F1) */
  setTarget(at: { x: number; y: number; z: number }): void {
    this.target.set(at.x, at.y, at.z)
  }

  /** 受控位姿写入(S1 分屏联动):越界值按既有边界收敛 */
  setPose(pose: OrbitPose): void {
    this.theta = pose.theta
    this.phi = THREE.MathUtils.clamp(pose.phi, MIN_PHI, MAX_PHI)
    this.distance = THREE.MathUtils.clamp(pose.distance, MIN_DISTANCE, MAX_DISTANCE)
    this.target.set(pose.target.x, pose.target.y, pose.target.z)
  }
}

/** 相机装配:orbit / walk 双策略(S2b F1)。walk 策略由引擎门面按需创建注入 */
export class CameraRig {
  private orbit: OrbitCameraStrategy
  private walk: CameraStrategy | null = null
  private active: CameraStrategy
  private canvas: HTMLCanvasElement | null = null

  constructor() {
    this.orbit = new OrbitCameraStrategy()
    this.active = this.orbit
  }

  get camera(): THREE.PerspectiveCamera {
    return this.active.camera
  }

  get mode(): string {
    return this.active.mode
  }

  /** 注入 walk 策略(引擎在 world/registry 就绪后创建) */
  registerWalkStrategy(strategy: CameraStrategy): void {
    this.walk = strategy
  }

  setMode(mode: 'orbit' | 'walk'): { ok: boolean; reason?: string } {
    if (mode === this.active.mode) return { ok: true }
    if (mode === 'walk') {
      if (!this.walk) return { ok: false, reason: '世界未就绪,无法进入第一视角' }
      // walk → orbit 的注视点交接由引擎在创建策略前完成(落点搜索)
      if (this.canvas) { this.orbit.detach(); this.walk.attach?.(this.canvas) }
      this.active = this.walk
      return { ok: true }
    }
    // walk → orbit:注视点跟随玩家位置
    const playerPos = this.walk?.playerPosition
    if (playerPos) this.orbit.setTarget(playerPos)
    if (this.canvas && this.walk) { this.walk.detach?.(); this.orbit.attach(this.canvas) }
    this.active = this.orbit
    return { ok: true }
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    this.active.attach?.(canvas)
  }

  fitToWorld(size: VoxelSize): void {
    this.active.fitToWorld(size)
  }

  setAspect(aspect: number): void {
    this.orbit.setAspect(aspect)
    const walkCam = this.walk as { camera?: THREE.PerspectiveCamera } | null
    if (walkCam?.camera) {
      walkCam.camera.aspect = aspect
      walkCam.camera.updateProjectionMatrix()
    }
  }

  /** 相机注视点(天气粒子跟随、阴影相机聚焦)。walk 时为玩家位置 */
  get state() {
    if (this.active.mode === 'walk' && this.walk?.playerPosition) {
      return { target: this.walk.playerPosition, distance: 40 } // distance 40 = 阴影最小覆盖范围
    }
    return this.orbit.state
  }

  /** orbit 位姿读出(S1 分屏联动);非 orbit 模式返回 null(联动无意义) */
  getOrbitPose(): OrbitPose | null {
    if (this.active.mode !== 'orbit') return null
    const s = this.orbit.state
    return { theta: s.theta, phi: s.phi, distance: s.distance, target: { x: s.target.x, y: s.target.y, z: s.target.z } }
  }

  /** 受控位姿写入;非 orbit 模式忽略(walk 下联动失效) */
  setOrbitPose(pose: OrbitPose): void {
    if (this.active.mode !== 'orbit') return
    this.orbit.setPose(pose)
  }

  update(dt: number): void {
    this.active.update(dt)
  }

  detach(): void {
    this.active.detach?.()
    this.canvas = null
  }
}
