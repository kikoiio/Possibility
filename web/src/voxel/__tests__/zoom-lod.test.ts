import { describe, expect, it } from 'vitest'
import {
  TIER_BOUNDARY_1, TIER_BOUNDARY_2, TIER_HYSTERESIS, TIER_PARAMS, ZoomLod,
  type ZoomTier,
} from '../engine/zoom-lod'

function drive(lod: ZoomLod, zoom: number, frames = 3): void {
  // 多次 update 容许逐帧翻档(实现为每帧最多一档)
  for (let i = 0; i < frames; i++) lod.update(zoom)
}

describe('ZoomLod 档位划分(T2)', () => {
  it('三区划分:overview / district / close', () => {
    const lod = new ZoomLod()
    drive(lod, 0.2)
    expect(lod.tier).toBe('overview')
    drive(lod, 0.55)
    expect(lod.tier).toBe('district')
    drive(lod, 0.9)
    expect(lod.tier).toBe('close')
  })

  it('首次 update 直接落定不回调(避免启动期抖动)', () => {
    const lod = new ZoomLod()
    let calls = 0
    lod.onTierChange = () => { calls++ }
    lod.update(0.9)
    expect(lod.tier).toBe('close')
    expect(calls).toBe(0)
  })

  it('params 随 tier 同步;三档参数覆盖五个旋钮', () => {
    const lod = new ZoomLod()
    drive(lod, 0.1)
    expect(lod.params).toEqual(TIER_PARAMS.overview)
    for (const tier of ['overview', 'district', 'close'] as ZoomTier[]) {
      const p = TIER_PARAMS[tier]
      expect(Object.keys(p).sort()).toEqual(
        ['bloomScale', 'fogScale', 'particleDensity', 'shadowMapScale', 'swayScale'].sort(),
      )
    }
    // 全貌档必须可观测降级(AC6):至少三项与近距档不同
    const diff = (Object.keys(TIER_PARAMS.close) as (keyof typeof TIER_PARAMS.close)[])
      .filter((k) => TIER_PARAMS.overview[k] !== TIER_PARAMS.close[k])
    expect(diff.length).toBeGreaterThanOrEqual(3)
  })
})

describe('ZoomLod 滞回(T2)', () => {
  it('边界 ±滞回带 内往复不翻档、不回调', () => {
    const lod = new ZoomLod()
    drive(lod, TIER_BOUNDARY_1 - 0.1) // overview
    const seen: ZoomTier[] = []
    lod.onTierChange = (t) => seen.push(t)
    // 在边界两侧滞回带内反复:未越过 边界+H
    for (let i = 0; i < 10; i++) {
      drive(lod, TIER_BOUNDARY_1 + TIER_HYSTERESIS - 0.005, 1)
      drive(lod, TIER_BOUNDARY_1 - 0.02, 1)
    }
    expect(seen).toEqual([])
    expect(lod.tier).toBe('overview')
  })

  it('升档须越过 边界+H,降档须越过 边界−H,各回调一次', () => {
    const lod = new ZoomLod()
    drive(lod, 0.5) // district
    const seen: ZoomTier[] = []
    lod.onTierChange = (t) => seen.push(t)
    drive(lod, TIER_BOUNDARY_2 + TIER_HYSTERESIS - 0.001)
    expect(lod.tier).toBe('district')
    drive(lod, TIER_BOUNDARY_2 + TIER_HYSTERESIS + 0.001)
    expect(lod.tier).toBe('close')
    drive(lod, TIER_BOUNDARY_2 - TIER_HYSTERESIS + 0.001)
    expect(lod.tier).toBe('close')
    drive(lod, TIER_BOUNDARY_2 - TIER_HYSTERESIS - 0.001)
    expect(lod.tier).toBe('district')
    expect(seen).toEqual(['close', 'district'])
  })

  it('滞回带宽度符合常量', () => {
    expect(TIER_HYSTERESIS).toBeCloseTo(0.03, 9)
    expect(TIER_BOUNDARY_2).toBeGreaterThan(TIER_BOUNDARY_1 + 2 * TIER_HYSTERESIS)
  })
})
