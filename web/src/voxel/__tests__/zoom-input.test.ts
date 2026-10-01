import { describe, expect, it } from 'vitest'
import { pinchRatioToZoom, wheelDeltaToZoom } from '../engine/zoom-input'

describe('wheelDeltaToZoom(T4)', () => {
  it('方向:deltaY<0(向上滚)= 拉近(正),deltaY>0 = 拉远(负)', () => {
    expect(wheelDeltaToZoom(-100)).toBeGreaterThan(0)
    expect(wheelDeltaToZoom(100)).toBeLessThan(0)
  })

  it('标准一档滚轮(deltaY=±100)给基准步长 0.045', () => {
    expect(wheelDeltaToZoom(-100)).toBeCloseTo(0.045, 9)
    expect(wheelDeltaToZoom(100)).toBeCloseTo(-0.045, 9)
  })

  it('触控板小 deltaY 有最小步长,高频累积自然平滑', () => {
    const small = wheelDeltaToZoom(-10)
    expect(small).toBeGreaterThan(0)
    expect(small).toBeLessThanOrEqual(0.045)
    expect(wheelDeltaToZoom(-1)).toBeCloseTo(wheelDeltaToZoom(-10), 9) // 同为最小步长
  })

  it('极端 deltaY 钳制到上限', () => {
    expect(wheelDeltaToZoom(-10000)).toBeLessThanOrEqual(0.12)
    expect(wheelDeltaToZoom(10000)).toBeGreaterThanOrEqual(-0.12)
  })

  it('deltaY=0 不产生缩放的防御:绝对值 0 给负向最小步长无意义,按实现归为拉远最小步长', () => {
    // 0 不是 <0,走拉远分支;调用方(wheel 事件)不会发 0,此处仅锁定量级
    expect(Math.abs(wheelDeltaToZoom(0))).toBeLessThanOrEqual(0.045)
  })
})

describe('pinchRatioToZoom(T4)', () => {
  it('捏开(ratio>1)= 拉近,捏合(ratio<1)= 拉远', () => {
    expect(pinchRatioToZoom(1.04)).toBeGreaterThan(0)
    expect(pinchRatioToZoom(0.96)).toBeLessThan(0)
  })

  it('量级:每 2% 间距变化 ≈ 0.01 刻度', () => {
    expect(pinchRatioToZoom(1.02)).toBeCloseTo(0.01, 9)
    expect(pinchRatioToZoom(0.98)).toBeCloseTo(-0.01, 9)
  })

  it('单次换算钳制 ±0.08 防跳变', () => {
    expect(pinchRatioToZoom(2)).toBeCloseTo(0.08, 9)
    expect(pinchRatioToZoom(0.1)).toBeCloseTo(-0.08, 9)
  })

  it('ratio=1(未移动)为 0', () => {
    expect(pinchRatioToZoom(1)).toBe(0)
  })
})
