import { describe, expect, it } from 'vitest'
import { createBlockRegistry, createEmptyWorld, setBlockMut } from '@possibility/voxel-contract'
import { PlayerBody, PLAYER, type MoveInput } from '../engine/player'
import { WorldModel } from '../engine/world-model'

const at = (x: number, y: number, z: number) => ({ x, y, z })
const registry = createBlockRegistry('mist-manor')

/** 32×32 平地(草方块 y=0) */
function flatWorld() {
  const doc = createEmptyWorld({ width: 32, height: 32, depth: 32 }, 'mist-manor', 'test')
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) setBlockMut(doc, at(x, 0, z), 'grass')
  return new WorldModel(doc)
}

const idle: MoveInput = { moveX: 0, moveZ: 0, jump: false, ascend: false, descend: false }
const DT = 1 / 60

function runSteps(body: PlayerBody, n: number, input: MoveInput = idle) {
  for (let i = 0; i < n; i++) body.step(DT, input)
}

describe('PlayerBody 核心物理(T8)', () => {
  it('平地行走:水平移动,y 不变,保持落地', () => {
    const body = new PlayerBody(flatWorld(), registry, at(5, 1, 5))
    runSteps(body, 60, { ...idle, moveZ: 1 })
    expect(body.state.position.z).toBeGreaterThan(6)
    expect(body.state.position.y).toBeCloseTo(1, 3)
    expect(body.state.onGround).toBe(true)
  })

  it('撞实心墙被挡:停在墙面外一个半宽处', () => {
    const world = flatWorld()
    for (let y = 1; y <= 2; y++) for (let z = 0; z < 32; z++) setBlockMut(world.doc, at(10, y, z), 'stone')
    const body = new PlayerBody(world, registry, at(5, 1, 5))
    runSteps(body, 300, { ...idle, moveX: 1 })
    expect(body.state.position.x).toBeLessThanOrEqual(10 - PLAYER.width / 2 + 1e-3)
    expect(body.state.position.x).toBeGreaterThan(9)
  })

  it('自由落体:重力加速,落到地面停住', () => {
    const body = new PlayerBody(flatWorld(), registry, at(5, 6, 5))
    runSteps(body, 120)
    expect(body.state.position.y).toBeCloseTo(1, 3)
    expect(body.state.onGround).toBe(true)
  })

  it('跳跃:腾空后落地,可回到地面', () => {
    const body = new PlayerBody(flatWorld(), registry, at(5, 1, 5))
    runSteps(body, 10) // 先落地
    body.step(DT, { ...idle, jump: true })
    expect(body.state.onGround).toBe(false)
    let peak = 0
    for (let i = 0; i < 120; i++) {
      body.step(DT, idle)
      peak = Math.max(peak, body.state.position.y)
    }
    expect(peak).toBeGreaterThan(1.8)          // 跳起超过 0.8 格
    expect(body.state.position.y).toBeCloseTo(1, 3)
    expect(body.state.onGround).toBe(true)
  })

  it('终端速度封顶:高空下落 vy 不超过 terminal', () => {
    const body = new PlayerBody(flatWorld(), registry, at(5, 30, 5))
    for (let i = 0; i < 240; i++) {
      body.step(DT, idle)
      expect(body.state.velocity.y).toBeGreaterThanOrEqual(-PLAYER.terminal)
    }
    expect(body.state.position.y).toBeCloseTo(1, 3)
  })
})

describe('PlayerBody 台阶/飞行/边界(T9)', () => {
  it('连续 1 格高差楼梯:无跳跃自动登顶', () => {
    const world = flatWorld()
    setBlockMut(world.doc, at(10, 1, 5), 'stone')                 // 第一级
    setBlockMut(world.doc, at(11, 1, 5), 'stone')
    setBlockMut(world.doc, at(11, 2, 5), 'stone')                 // 第二级
    const body = new PlayerBody(world, registry, at(5, 1, 5))
    let peak = 0
    for (let i = 0; i < 300; i++) {
      body.step(DT, { ...idle, moveX: 1 })
      peak = Math.max(peak, body.state.position.y)
    }
    expect(peak).toBeCloseTo(3, 1)                                // 途中站上第二级顶面
    expect(body.state.position.x).toBeGreaterThan(11)             // 翻越楼梯继续向前
  })

  it('2 格高差上不去:台阶辅助不生效,跳也够不着', () => {
    const world = flatWorld()
    for (let y = 1; y <= 2; y++) setBlockMut(world.doc, at(10, y, 5), 'stone')
    const body = new PlayerBody(world, registry, at(8, 1, 5))
    // 边走边跳也上不去 2 格(jump 8.5 / gravity 28 → 跳高约 1.29)
    runSteps(body, 300, { ...idle, moveX: 1, jump: true })
    expect(body.state.position.y).toBeLessThan(2)
  })

  it('飞行:无重力,可升可降可悬停;退出飞行恢复重力', () => {
    const body = new PlayerBody(flatWorld(), registry, at(5, 1, 5))
    runSteps(body, 30)
    body.setFlying(true)
    runSteps(body, 60, { ...idle, ascend: true })
    const high = body.state.position.y
    expect(high).toBeGreaterThan(5)
    runSteps(body, 60, idle)                                      // 悬停
    expect(body.state.position.y).toBeCloseTo(high, 3)
    runSteps(body, 30, { ...idle, descend: true })
    expect(body.state.position.y).toBeLessThan(high)
    body.setFlying(false)
    runSteps(body, 300, idle)
    expect(body.state.position.y).toBeCloseTo(1, 3)               // 恢复重力落地
    expect(body.state.onGround).toBe(true)
  })

  it('世界边界:走出边界被钳制', () => {
    const body = new PlayerBody(flatWorld(), registry, at(2, 1, 2))
    runSteps(body, 300, { ...idle, moveX: -1 })
    expect(body.state.position.x).toBeCloseTo(PLAYER.width / 2, 3)
    runSteps(body, 600, { ...idle, moveZ: 1 })
    expect(body.state.position.z).toBeCloseTo(32 - PLAYER.width / 2, 3)
  })
})
