import { describe, expect, it } from 'vitest'
import { CameraRig, type OrbitPose } from '../engine/camera'

const pose = (over: Partial<OrbitPose> = {}): OrbitPose => ({
  theta: 0.8, phi: 0.9, distance: 60, target: { x: 10, y: 4, z: -6 }, ...over,
})

describe('CameraRig orbit 位姿(S1 分屏联动)', () => {
  it('setOrbitPose → getOrbitPose 往返一致', () => {
    const rig = new CameraRig()
    rig.setOrbitPose(pose())
    expect(rig.getOrbitPose()).toEqual(pose())
  })

  it('写入越界值按相机边界收敛(phi/distance)', () => {
    const rig = new CameraRig()
    rig.setOrbitPose(pose({ phi: 9, distance: 99999 }))
    const read = rig.getOrbitPose()!
    expect(read.phi).toBeLessThanOrEqual(1.45)
    expect(read.distance).toBeLessThanOrEqual(400)
  })

  it('位姿驱动相机实际位置(与 orbit 参数方程一致)', () => {
    const rig = new CameraRig()
    rig.setOrbitPose(pose())
    rig.update(0)
    const p = pose()
    const sinPhi = Math.sin(p.phi)
    expect(rig.camera.position.x).toBeCloseTo(p.target.x + p.distance * sinPhi * Math.sin(p.theta), 5)
    expect(rig.camera.position.y).toBeCloseTo(p.target.y + p.distance * Math.cos(p.phi), 5)
    expect(rig.camera.position.z).toBeCloseTo(p.target.z + p.distance * sinPhi * Math.cos(p.theta), 5)
  })

  it('walk 模式:getOrbitPose 返回 null,setOrbitPose 被忽略', () => {
    const rig = new CameraRig()
    const walk = {
      mode: 'walk',
      camera: rig.camera,
      update: () => {},
      fitToWorld: () => {},
      playerPosition: { x: 1, y: 1, z: 1 },
    }
    rig.registerWalkStrategy(walk)
    expect(rig.setMode('walk').ok).toBe(true)
    expect(rig.getOrbitPose()).toBeNull()
    rig.setOrbitPose(pose({ theta: 3 }))
    // 切回 orbit 后仍是写入前的位姿(walk 期间的写入被忽略)
    rig.setMode('orbit')
    expect(rig.getOrbitPose()!.theta).not.toBeCloseTo(3, 5)
  })
})
