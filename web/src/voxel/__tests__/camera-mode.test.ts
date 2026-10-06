import { describe, expect, it } from 'vitest'
import { createBlockRegistry, createEmptyWorld, setBlockMut } from '@possibility/voxel-contract'
import { CameraRig } from '../engine/camera'
import { findSpawnNear, WalkCameraStrategy } from '../engine/camera-walk'
import { PLAYER } from '../engine/player'
import { WorldModel } from '../engine/world-model'

const at = (x: number, y: number, z: number) => ({ x, y, z })
const registry = createBlockRegistry('mist-manor')

function flatWorld() {
  const doc = createEmptyWorld({ width: 32, height: 32, depth: 32 }, 'mist-manor', 'test')
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) setBlockMut(doc, at(x, 0, z), 'grass')
  return new WorldModel(doc)
}

describe('findSpawnNear 落点搜索(T10)', () => {
  it('注视点投影:同柱向下找到地面可站立格', () => {
    const spawn = findSpawnNear(flatWorld(), registry, at(10, 12, 10))
    expect(spawn).toEqual(at(10, 1, 10))
  })

  it('避开不参与体素碰撞的家具对象落点', () => {
    const world = flatWorld()
    world.doc.objects.push({ id: 'table', objectType: 'bench', anchor: at(10, 1, 10), rotation: 0 })
    const spawn = findSpawnNear(world, registry, at(10, 3, 10))
    expect(spawn).not.toBeNull()
    expect(Math.max(Math.abs(spawn!.x - 10), Math.abs(spawn!.z - 10))).toBeGreaterThan(2)
  })

  it('注视点在全实心柱:螺旋外扩找到邻近空地', () => {
    const world = flatWorld()
    for (let y = 1; y <= 30; y++) setBlockMut(world.doc, at(10, y, 10), 'stone') // 顶到天的实心柱
    const spawn = findSpawnNear(world, registry, at(10, 3, 10))
    expect(spawn).not.toBeNull()
    expect(spawn!.y).toBe(1)
    expect(Math.max(Math.abs(spawn!.x - 10), Math.abs(spawn!.z - 10))).toBeLessThanOrEqual(2)
  })

  it('半径内全实心:返回 null(不切换)', () => {
    const doc = createEmptyWorld({ width: 16, height: 8, depth: 16 }, 'mist-manor', 'test')
    for (let y = 0; y < 8; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) setBlockMut(doc, at(x, y, z), 'stone')
    expect(findSpawnNear(new WorldModel(doc), registry, at(8, 4, 8))).toBeNull()
  })

  it('Safe Spawn: 避开屋顶瓦片,优先螺旋外扩寻找地面', () => {
    const world = flatWorld()
    // (10, 10) 处有小屋与屋顶瓦片(plaster-wall 为实心墙)
    for (let y = 1; y <= 3; y++) setBlockMut(world.doc, at(10, y, 10), 'plaster-wall')
    setBlockMut(world.doc, at(10, 4, 10), 'roof-tile')
    const spawn = findSpawnNear(world, registry, at(10, 6, 10))
    expect(spawn).not.toBeNull()
    // 落点不得在屋顶 y=5 上，必须外扩落在地面 y=1
    expect(spawn!.y).toBe(1)
    expect(spawn!.x !== 10 || spawn!.z !== 10).toBe(true)
  })
})

describe('WalkCameraStrategy(T10)', () => {
  it('update 后相机位于玩家眼位(脚底 + eye)', () => {
    const strategy = new WalkCameraStrategy(flatWorld(), registry, at(10, 1, 10))
    strategy.update(1 / 60)
    expect(strategy.camera.position.x).toBeCloseTo(10.5, 3)
    expect(strategy.camera.position.z).toBeCloseTo(10.5, 3)
    expect(strategy.camera.position.y).toBeCloseTo(1 + PLAYER.eye, 2)
  })

  it('自由落体 spawned 空中:update 驱动物理落地', () => {
    const strategy = new WalkCameraStrategy(flatWorld(), registry, at(10, 6, 10))
    for (let i = 0; i < 120; i++) strategy.update(1 / 60)
    expect(strategy.player.state.position.y).toBeCloseTo(1, 3)
    expect(strategy.camera.position.y).toBeCloseTo(1 + PLAYER.eye, 2)
  })
})

describe('CameraRig 双模式(T11)', () => {
  it('未注册 walk 策略时 setMode(walk) 失败且不切换', () => {
    const rig = new CameraRig()
    const result = rig.setMode('walk')
    expect(result.ok).toBe(false)
    expect(rig.mode).toBe('orbit')
  })

  it('orbit → walk:切换后相机为 walk 相机,state 跟随玩家', () => {
    const rig = new CameraRig()
    rig.registerWalkStrategy(new WalkCameraStrategy(flatWorld(), registry, at(10, 1, 10)))
    expect(rig.setMode('walk')).toEqual({ ok: true })
    expect(rig.mode).toBe('walk')
    rig.update(1 / 60)
    const state = rig.state
    expect(state.target.x).toBeCloseTo(10.5, 2)
    expect(state.distance).toBe(40)
  })

  it('walk → orbit:注视点跟随玩家当前位置', () => {
    const rig = new CameraRig()
    const walk = new WalkCameraStrategy(flatWorld(), registry, at(10, 1, 10))
    rig.registerWalkStrategy(walk)
    rig.setMode('walk')
    // 玩家向前走动
    for (let i = 0; i < 60; i++) {
      walk.player.step(1 / 60, { moveX: 0, moveZ: 1, jump: false, ascend: false, descend: false })
    }
    expect(rig.setMode('orbit')).toEqual({ ok: true })
    expect(rig.mode).toBe('orbit')
    const target = rig.state.target
    expect(target.z).toBeCloseTo(walk.player.state.position.z, 2)
    expect(target.z).toBeGreaterThan(12) // 确实走了
  })

  it('重复切到当前模式幂等', () => {
    const rig = new CameraRig()
    expect(rig.setMode('orbit')).toEqual({ ok: true })
    expect(rig.mode).toBe('orbit')
  })
})
