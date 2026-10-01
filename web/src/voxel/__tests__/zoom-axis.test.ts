import { describe, expect, it } from 'vitest'
import {
  HYSTERESIS, MAX_DISTANCE, MIN_DISTANCE, WALK_BAND_GAIN,
  Z_AFTER_LIFT, Z_ENTER, Z_EXIT, ZoomAxis,
} from '../engine/zoom-axis'

/** 多帧推进直到收敛(指数平滑渐近,200 帧足够 snap) */
function settle(axis: ZoomAxis, frames = 200): void {
  for (let i = 0; i < frames; i++) axis.update(1 / 60)
}

describe('ZoomAxis 映射(T1)', () => {
  it('端点对齐:MIN_DISTANCE↔Z_ENTER,MAX_DISTANCE↔0', () => {
    const axis = new ZoomAxis()
    expect(axis.zoomFromDistance(MIN_DISTANCE)).toBeCloseTo(Z_ENTER, 9)
    expect(axis.zoomFromDistance(MAX_DISTANCE)).toBeCloseTo(0, 9)
    expect(axis.distanceFromZoom(Z_ENTER)).toBeCloseTo(MIN_DISTANCE, 6)
    expect(axis.distanceFromZoom(0)).toBeCloseTo(MAX_DISTANCE, 6)
  })

  it('往返映射误差可忽略且 orbit 段单调(越近刻度越大)', () => {
    const axis = new ZoomAxis()
    let prev = -1
    for (const d of [400, 200, 100, 48, 24, 12, 6]) {
      const z = axis.zoomFromDistance(d)
      expect(z).toBeGreaterThan(prev)
      prev = z
      expect(axis.distanceFromZoom(z)).toBeCloseTo(d, 6)
    }
  })

  it('walk 段输入按 Z_ENTER 防御(距离不低于 MIN)', () => {
    const axis = new ZoomAxis()
    expect(axis.distanceFromZoom(1)).toBeCloseTo(MIN_DISTANCE, 6)
    expect(axis.distanceFromZoom(0.95)).toBeCloseTo(MIN_DISTANCE, 6)
  })
})

describe('ZoomAxis 平滑与 crossing(T1)', () => {
  it('applyDelta 只改目标,update 指数平滑收敛', () => {
    const axis = new ZoomAxis(0.4)
    axis.applyDelta(0.1)
    expect(axis.value).toBeCloseTo(0.4, 9) // 当帧未推进
    settle(axis)
    expect(axis.value).toBeCloseTo(0.5, 4)
  })

  it('orbit 带上穿 Z_ENTER 触发 enter-walk,且不重复触发', () => {
    const axis = new ZoomAxis(0.8)
    axis.applyDelta(0.2) // 目标 1.0
    let crossings = 0
    for (let i = 0; i < 300; i++) {
      if (axis.update(1 / 60) === 'enter-walk') crossings++
    }
    expect(crossings).toBe(1)
    expect(axis.value).toBeCloseTo(1, 4)
  })

  it('walk 带增量有增益:一两次滚轮即下穿 Z_EXIT 触发 exit-walk', () => {
    const axis = new ZoomAxis(0.5)
    axis.setBand('walk')
    axis.unfreeze(1)
    axis.applyDelta(-0.045) // 一档滚轮:walk 带 ×WALK_BAND_GAIN
    let crossing: string | null = null
    for (let i = 0; i < 300 && !crossing; i++) crossing = axis.update(1 / 60)
    // 0.045×4 = 0.18 → 目标 0.82,仍高于 Z_EXIT=0.80:单档不触发
    expect(crossing).toBeNull()
    axis.applyDelta(-0.045) // 第二档:目标 0.64
    for (let i = 0; i < 300 && !crossing; i++) crossing = axis.update(1 / 60)
    expect(crossing).toBe('exit-walk')
    expect(WALK_BAND_GAIN).toBeGreaterThan(1)
  })

  it('滞回:orbit 带下穿 Z_ENTER 不触发任何 crossing', () => {
    const axis = new ZoomAxis(0.9)
    axis.setBand('orbit')
    axis.applyDelta(-0.2)
    let crossing: string | null = null
    for (let i = 0; i < 300; i++) crossing ??= axis.update(1 / 60)
    expect(crossing).toBeNull()
  })

  it('frozen 丢弃 delta 且 update 不推进、不报 crossing', () => {
    const axis = new ZoomAxis(0.84)
    axis.freeze()
    axis.applyDelta(0.2)
    expect(axis.update(1 / 60)).toBeNull()
    settle(axis)
    expect(axis.value).toBeCloseTo(0.84, 9)
    expect(axis.isFrozen).toBe(true)
  })

  it('unfreeze 带 target 同步 current/target(交接后刻度归位)', () => {
    const axis = new ZoomAxis(0.84)
    axis.freeze()
    axis.unfreeze(1)
    expect(axis.isFrozen).toBe(false)
    expect(axis.value).toBe(1)
  })

  it('reset 立即同步并回到 orbit 带(落地失败钳回/文档重载)', () => {
    const axis = new ZoomAxis(0.9)
    axis.setBand('walk')
    axis.freeze()
    axis.reset(Z_AFTER_LIFT)
    expect(axis.value).toBe(Z_AFTER_LIFT)
    expect(axis.isFrozen).toBe(false)
    // 已回 orbit 带:继续拉近可再次触发 enter-walk
    axis.applyDelta(0.2)
    let crossing: string | null = null
    for (let i = 0; i < 300 && !crossing; i++) crossing = axis.update(1 / 60)
    expect(crossing).toBe('enter-walk')
  })

  it('常数关系自洽:Z_EXIT = Z_ENTER − HYSTERESIS,Z_AFTER_LIFT 在滞回带外', () => {
    expect(Z_EXIT).toBeCloseTo(Z_ENTER - HYSTERESIS, 9)
    expect(Z_AFTER_LIFT).toBeCloseTo(Z_ENTER - 2 * HYSTERESIS, 9)
    expect(Z_AFTER_LIFT).toBeLessThan(Z_EXIT)
  })
})
