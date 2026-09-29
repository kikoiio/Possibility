import * as THREE from 'three'
import type { VoxelSize } from '@possibility/voxel-contract'

/** 相机策略接口：后续第一视角模式 = 新增策略实现（N7） */
export interface CameraStrategy {
  readonly mode: string
  attach?(canvas: HTMLCanvasElement): void
  detach?(): void
  update(dt: number): void
  fitToWorld(size: VoxelSize): void
}

const MIN_DISTANCE = 6
const MAX_DISTANCE = 400
const MIN_PHI = 0.25
const MAX_PHI = 1.45

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
}

/** 相机装配：当前仅 orbit；setMode 为第一视角预留（N7） */
export class CameraRig {
  private strategy: OrbitCameraStrategy

  constructor() {
    this.strategy = new OrbitCameraStrategy()
  }

  get camera(): THREE.PerspectiveCamera {
    return this.strategy.camera
  }

  setMode(mode: 'orbit'): void {
    if (mode !== 'orbit') throw new Error(`unknown camera mode: ${mode as string}`)
    // 本周期仅 orbit；第一视角 = 新策略挂到这里
  }

  attach(canvas: HTMLCanvasElement): void {
    this.strategy.attach(canvas)
  }

  fitToWorld(size: VoxelSize): void {
    this.strategy.fitToWorld(size)
  }

  setAspect(aspect: number): void {
    this.strategy.setAspect(aspect)
  }

  /** 相机注视点（天气粒子跟随等） */
  get state() {
    return this.strategy.state
  }

  update(dt: number): void {
    this.strategy.update(dt)
  }

  detach(): void {
    this.strategy.detach()
  }
}
