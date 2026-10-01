import { describe, expect, it } from 'vitest'
import { ContinuumController, TWEEN_MS, type WalkPose } from '../engine/camera-continuum'
import { MotionPreference } from '../engine/motion-preference'
import type { OrbitPose } from '../engine/camera'

const normalMotion = () => new MotionPreference(() => null)
const reducedMotion = () => new MotionPreference(() => ({ matches: true }) as unknown as MediaQueryList)

const orbitPose = (): OrbitPose => ({
  theta: Math.PI * 0.25, phi: 0.96, distance: 48,
  target: { x: 10.5, y: 1, z: 10.5 },
})
const walkPose = (): WalkPose => ({ eye: { x: 10.5, y: 2.6, z: 8.5 }, yaw: 0.3, pitch: -0.1 })

/** 逐步推进直到完成,返回最后一次 update 结果与期间捕获的相机 */
function runToCompletion(c: ContinuumController, maxFrames = 200) {
  let result: 'landed' | 'lifted' | 'settled' | null = null
  let lastCam = c.transitionCamera
  for (let i = 0; i < maxFrames && !result; i++) {
    result = c.update(1 / 60)
    if (c.transitionCamera) lastCam = c.transitionCamera
  }
  return { result, lastCam }
}

describe('ContinuumController 落地补间(T3)', () => {
  it('补间完成返回 landed,状态落定 walk,过渡相机回收', () => {
    const c = new ContinuumController(normalMotion())
    c.beginLanding(orbitPose(), walkPose())
    expect(c.state).toBe('landing')
    expect(c.transitionCamera).not.toBeNull()
    const { result } = runToCompletion(c)
    expect(result).toBe('landed')
    expect(c.state).toBe('walk')
    expect(c.transitionCamera).toBeNull()
  })

  it('端点位姿精确:起点 = orbit 球面位,终点 = walk 眼位;fov 35→70', () => {
    const c = new ContinuumController(normalMotion())
    const from = orbitPose()
    const to = walkPose()
    c.beginLanding(from, to)
    const cam = c.transitionCamera!
    const sinPhi = Math.sin(from.phi)
    expect(cam.position.x).toBeCloseTo(from.target.x + from.distance * sinPhi * Math.sin(from.theta), 5)
    expect(cam.position.y).toBeCloseTo(from.target.y + from.distance * Math.cos(from.phi), 5)
    expect(cam.position.z).toBeCloseTo(from.target.z + from.distance * sinPhi * Math.cos(from.theta), 5)
    expect(cam.fov).toBeCloseTo(35, 5)
    const { lastCam } = runToCompletion(c)
    expect(lastCam!.position.x).toBeCloseTo(to.eye.x, 3)
    expect(lastCam!.position.y).toBeCloseTo(to.eye.y, 3)
    expect(lastCam!.position.z).toBeCloseTo(to.eye.z, 3)
    expect(lastCam!.fov).toBeCloseTo(70, 3)
  })

  it('路径中点高于两端连线(控制点抬高防穿地,N1)', () => {
    const c = new ContinuumController(normalMotion())
    const from = orbitPose()
    const to = walkPose()
    c.beginLanding(from, to)
    // 推进到 t≈0.5(缓动后 e=0.5)
    for (let i = 0; i < 30; i++) c.update((TWEEN_MS / 1000) / 60)
    const midY = c.transitionCamera!.position.y
    const y0 = from.target.y + from.distance * Math.cos(from.phi)
    const linearMid = (y0 + to.eye.y) / 2
    expect(midY).toBeGreaterThan(linearMid + 0.5)
  })

  it('reduced-motion:立即落定 walk,无过渡相机,update 一次性返回 landed(F7)', () => {
    const c = new ContinuumController(reducedMotion())
    c.beginLanding(orbitPose(), walkPose())
    expect(c.state).toBe('walk')
    expect(c.transitionCamera).toBeNull()
    expect(c.update(1 / 60)).toBe('landed')
    expect(c.update(1 / 60)).toBeNull()
  })
})

describe('ContinuumController 升空补间(T3)', () => {
  it('lifting 完成返回 lifted,状态落定 orbit,终点 = orbit 球面位,fov 70→35', () => {
    const c = new ContinuumController(normalMotion())
    c.beginLanding(orbitPose(), walkPose())
    runToCompletion(c)
    const to = orbitPose()
    c.beginLifting(walkPose(), to)
    expect(c.state).toBe('lifting')
    const { result, lastCam } = runToCompletion(c)
    expect(result).toBe('lifted')
    expect(c.state).toBe('orbit')
    const sinPhi = Math.sin(to.phi)
    expect(lastCam!.position.x).toBeCloseTo(to.target.x + to.distance * sinPhi * Math.sin(to.theta), 3)
    expect(lastCam!.position.y).toBeCloseTo(to.target.y + to.distance * Math.cos(to.phi), 3)
    expect(lastCam!.fov).toBeCloseTo(35, 3)
  })

  it('reduced-motion:立即落定 orbit,update 一次性返回 lifted', () => {
    const c = new ContinuumController(reducedMotion())
    c.beginLanding(orbitPose(), walkPose())
    c.update(1 / 60) // 取走 landed
    c.beginLifting(walkPose(), orbitPose())
    expect(c.state).toBe('orbit')
    expect(c.update(1 / 60)).toBe('lifted')
  })
})

describe('ContinuumController 边界(T3)', () => {
  it('非过渡态 update 返回 null', () => {
    const c = new ContinuumController(normalMotion())
    expect(c.update(1 / 60)).toBeNull()
  })

  it('cancel:landing 中取消回 orbit 稳定态,相机回收,update 不再返回结果', () => {
    const c = new ContinuumController(normalMotion())
    c.beginLanding(orbitPose(), walkPose())
    c.update(1 / 60)
    c.cancel()
    expect(c.state).toBe('orbit')
    expect(c.transitionCamera).toBeNull()
    expect(c.update(1 / 60)).toBeNull()
  })

  it('lifting 中 cancel 回 walk 稳定态', () => {
    const c = new ContinuumController(normalMotion())
    c.beginLanding(orbitPose(), walkPose())
    runToCompletion(c)
    c.beginLifting(walkPose(), orbitPose())
    c.update(1 / 60)
    c.cancel()
    expect(c.state).toBe('walk')
  })
})

describe('ContinuumController 飞向事件(S3b F6)', () => {
  it('orbit→orbit 补间完成返回 settled,状态落定 orbit,fov 恒 35', () => {
    const c = new ContinuumController(normalMotion())
    const from = orbitPose()
    const to: OrbitPose = { theta: from.theta, phi: from.phi, distance: 24, target: { x: 30.5, y: 4, z: 12.5 } }
    c.beginFlyTo(from, to)
    expect(c.state).toBe('flying')
    expect(c.transitionCamera).not.toBeNull()
    expect(c.transitionCamera!.fov).toBeCloseTo(35, 5)
    const { result, lastCam } = runToCompletion(c)
    expect(result).toBe('settled')
    expect(c.state).toBe('orbit')
    expect(c.transitionCamera).toBeNull()
    // 终点 = 目标 orbit 球面位
    const sinPhi = Math.sin(to.phi)
    expect(lastCam!.position.x).toBeCloseTo(to.target.x + to.distance * sinPhi * Math.sin(to.theta), 3)
    expect(lastCam!.position.y).toBeCloseTo(to.target.y + to.distance * Math.cos(to.phi), 3)
    expect(lastCam!.position.z).toBeCloseTo(to.target.z + to.distance * sinPhi * Math.cos(to.theta), 3)
  })

  it('reduced-motion 直切:无过渡相机,update 取一次 settled', () => {
    const c = new ContinuumController(reducedMotion())
    c.beginFlyTo(orbitPose(), { ...orbitPose(), distance: 24 })
    expect(c.state).toBe('orbit')
    expect(c.transitionCamera).toBeNull()
    expect(c.update(1 / 60)).toBe('settled')
    expect(c.update(1 / 60)).toBeNull()
  })

  it('flying 中 cancel 回 orbit 稳定态', () => {
    const c = new ContinuumController(normalMotion())
    c.beginFlyTo(orbitPose(), { ...orbitPose(), distance: 24 })
    c.update(1 / 60)
    c.cancel()
    expect(c.state).toBe('orbit')
    expect(c.transitionCamera).toBeNull()
  })
})
