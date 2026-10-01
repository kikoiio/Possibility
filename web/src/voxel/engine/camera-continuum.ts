import * as THREE from 'three'
import type { OrbitPose } from './camera'
import type { MotionPreference } from './motion-preference'

/**
 * ContinuumController(S3a F2/F3/F7):落地/升空补间与两策略位姿交接。
 * - 状态机 orbit → landing → walk → lifting → orbit
 * - 补间期间持有自有 transitionCamera 作为渲染相机(两策略都不被驱动,
 *   避免污染内部状态);完成后由引擎走 CameraRig.setMode 既有交接
 * - 路径:二次贝塞尔,控制点抬高防穿地形(N1);朝向四元数 slerp;
 *   fov 同步插值(orbit 35 ↔ walk 70),避免落地瞬间视野跳变
 * - reduced-motion:begin* 立即落定,无补间(F7)
 */

export type ContinuumState = 'orbit' | 'landing' | 'walk' | 'lifting'

export interface WalkPose {
  eye: { x: number; y: number; z: number }
  yaw: number
  pitch: number
}

export const TWEEN_MS = 500
/** 控制点抬高量:|Δy|×0.3 + 2 格(N1 防穿地) */
const LIFT_FACTOR = 0.3
const LIFT_BASE = 2
const ORBIT_FOV = 35
const WALK_FOV = 70

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/** orbit 位姿 → 相机位置(与 OrbitCameraStrategy.update 同一球面公式) */
function orbitPosition(pose: OrbitPose): THREE.Vector3 {
  const sinPhi = Math.sin(pose.phi)
  return new THREE.Vector3(
    pose.target.x + pose.distance * sinPhi * Math.sin(pose.theta),
    pose.target.y + pose.distance * Math.cos(pose.phi),
    pose.target.z + pose.distance * sinPhi * Math.cos(pose.theta),
  )
}

/** lookAt 约定(相机 -Z 朝向 target) */
function lookQuat(eye: THREE.Vector3, target: THREE.Vector3): THREE.Quaternion {
  const m = new THREE.Matrix4().lookAt(eye, target, new THREE.Vector3(0, 1, 0))
  return new THREE.Quaternion().setFromRotationMatrix(m)
}

function walkQuat(pose: WalkPose): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(pose.pitch, pose.yaw, 0, 'YXZ'))
}

interface Tween {
  kind: 'landing' | 'lifting'
  t: number
  p0: THREE.Vector3
  ctrl: THREE.Vector3
  p1: THREE.Vector3
  q0: THREE.Quaternion
  q1: THREE.Quaternion
  fov0: number
  fov1: number
}

export class ContinuumController {
  private currentState: ContinuumState = 'orbit'
  private tween: Tween | null = null
  private camera: THREE.PerspectiveCamera | null = null
  /** reduced-motion 直切的待返回结果(update 取一次) */
  private pendingResult: 'landed' | 'lifted' | null = null

  constructor(private readonly motion: MotionPreference) {}

  get state(): ContinuumState {
    return this.currentState
  }

  /** 过渡期间为自有相机,否则 null(渲染相机由 CameraRig 决定) */
  get transitionCamera(): THREE.PerspectiveCamera | null {
    return this.camera
  }

  beginLanding(from: OrbitPose, to: WalkPose): void {
    if (this.currentState !== 'orbit') this.cancel()
    if (this.motion.isReduced()) {
      this.currentState = 'walk'
      this.pendingResult = 'landed'
      return
    }
    const p0 = orbitPosition(from)
    const p1 = new THREE.Vector3(to.eye.x, to.eye.y, to.eye.z)
    this.tween = {
      kind: 'landing', t: 0, p0, p1,
      ctrl: this.controlPoint(p0, p1),
      q0: lookQuat(p0, new THREE.Vector3(from.target.x, from.target.y, from.target.z)),
      q1: walkQuat(to),
      fov0: ORBIT_FOV, fov1: WALK_FOV,
    }
    this.camera = new THREE.PerspectiveCamera(ORBIT_FOV, 1, 0.1, 2000)
    this.applyTween(0)
    this.currentState = 'landing'
  }

  beginLifting(from: WalkPose, to: OrbitPose): void {
    if (this.currentState !== 'walk') this.cancel()
    if (this.motion.isReduced()) {
      this.currentState = 'orbit'
      this.pendingResult = 'lifted'
      return
    }
    const p0 = new THREE.Vector3(from.eye.x, from.eye.y, from.eye.z)
    const p1 = orbitPosition(to)
    this.tween = {
      kind: 'lifting', t: 0, p0, p1,
      ctrl: this.controlPoint(p0, p1),
      q0: walkQuat(from),
      q1: lookQuat(p1, new THREE.Vector3(to.target.x, to.target.y, to.target.z)),
      fov0: WALK_FOV, fov1: ORBIT_FOV,
    }
    this.camera = new THREE.PerspectiveCamera(WALK_FOV, 1, 0.1, 2000)
    this.applyTween(0)
    this.currentState = 'lifting'
  }

  /** 补间推进;完成时返回 'landed' | 'lifted' 供引擎交接,其余帧 null */
  update(dt: number): 'landed' | 'lifted' | null {
    if (this.pendingResult) {
      const r = this.pendingResult
      this.pendingResult = null
      return r
    }
    if (!this.tween || !this.camera) return null
    this.tween.t = Math.min(1, this.tween.t + (dt * 1000) / TWEEN_MS)
    this.applyTween(easeInOutCubic(this.tween.t))
    if (this.tween.t < 1) return null
    const done = this.tween.kind === 'landing' ? 'landed' : 'lifted'
    this.currentState = this.tween.kind === 'landing' ? 'walk' : 'orbit'
    this.tween = null
    this.camera = null
    return done
  }

  /** 直切回最近稳定态(文档重载/反向指令) */
  cancel(): void {
    if (this.currentState === 'landing') this.currentState = 'orbit'
    else if (this.currentState === 'lifting') this.currentState = 'walk'
    this.tween = null
    this.camera = null
    this.pendingResult = null
  }

  /** 强制落定到指定稳定态(交接失败回退等异常路径;正常流程勿用) */
  forceSettle(state: 'orbit' | 'walk'): void {
    this.currentState = state
    this.tween = null
    this.camera = null
    this.pendingResult = null
  }

  private controlPoint(p0: THREE.Vector3, p1: THREE.Vector3): THREE.Vector3 {
    const mid = p0.clone().add(p1).multiplyScalar(0.5)
    mid.y += Math.abs(p1.y - p0.y) * LIFT_FACTOR + LIFT_BASE
    return mid
  }

  private applyTween(e: number): void {
    if (!this.tween || !this.camera) return
    const { p0, ctrl, p1, q0, q1, fov0, fov1 } = this.tween
    // 二次贝塞尔:B(t) = (1-t)²p0 + 2(1-t)t·ctrl + t²p1
    const u = 1 - e
    this.camera.position.set(
      u * u * p0.x + 2 * u * e * ctrl.x + e * e * p1.x,
      u * u * p0.y + 2 * u * e * ctrl.y + e * e * p1.y,
      u * u * p0.z + 2 * u * e * ctrl.z + e * e * p1.z,
    )
    this.camera.quaternion.copy(q0).slerp(q1, e)
    this.camera.fov = fov0 + (fov1 - fov0) * e
    this.camera.updateProjectionMatrix()
  }
}
