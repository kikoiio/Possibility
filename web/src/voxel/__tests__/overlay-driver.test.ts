import { describe, expect, it } from 'vitest'
import type { SceneLifeOverlay } from '@possibility/scene-contract'
import { mapSimTime, mapWeather, OverlayDriver, type OverlayEngineSink } from '../bridge/overlay-driver'
import type { ResidentRenderState } from '../engine'

function sink() {
  const calls: { times: number[]; weathers: unknown[]; residents: ResidentRenderState[][]; simNows: string[] } = { times: [], weathers: [], residents: [], simNows: [] }
  const engine: OverlayEngineSink = {
    setTimeOfDay: (t) => { calls.times.push(t) },
    setWeather: (w) => { calls.weathers.push(w) },
    syncResidents: (s) => { calls.residents.push(s) },
    setSimNow: (iso) => { calls.simNows.push(iso) },
  }
  return { engine, calls }
}

const overlay = (over: Partial<SceneLifeOverlay>): SceneLifeOverlay => ({
  timelineId: 't1', simNow: '2026-09-29T14:30:00Z', weather: null, timeOfDay: 'day',
  persons: [], locationStates: [], ...over,
})

describe('OverlayDriver', () => {
  it('maps simNow to world time (AC6 产品侧)', () => {
    expect(mapSimTime('day', '2026-09-29T12:00:00Z')).toBe(0.5)
    expect(mapSimTime('night', '2026-09-29T00:00:00Z')).toBe(0)
    expect(mapSimTime('dusk', '2026-09-29T18:30:00Z')).toBeCloseTo(0.77, 2)
    expect(mapSimTime('night', 'not a date')).toBe(0)
  })

  it('maps weather strings to engine weather (AC7 产品侧)', () => {
    expect(mapWeather('小雨')).toEqual({ rain: 1 })
    expect(mapWeather('snow')).toEqual({ snow: 1 })
    expect(mapWeather('浓雾')).toEqual({ fog: 1 })
    expect(mapWeather('晴')).toEqual({})
    expect(mapWeather(null)).toEqual({})
  })

  it('drives time, weather and residents from an overlay', () => {
    const { engine, calls } = sink()
    const driver = new OverlayDriver({
      engine,
      resolveLocation: (name) => (name === '主楼' ? { x: 23, y: 1, z: 24 } : null),
      spawnFallback: { x: 5, y: 1, z: 5 },
    })
    driver.apply(overlay({
      weather: '细雨',
      persons: [
        { personId: 'p1', locationName: '主楼', activity: '整理书架', mood: '' },
        { personId: 'p2', locationName: '温室', activity: '浇花', mood: '' },
      ],
    }))
    expect(calls.times).toHaveLength(1)
    expect(calls.weathers).toEqual([{ rain: 1 }])
    expect(calls.residents[0]).toHaveLength(2)
    // 首次同步：落在地点上（destination null = 原地）
    expect(calls.residents[0][0]).toMatchObject({ personId: 'p1', at: { x: 23, y: 1, z: 24 }, destination: null, activity: '整理书架' })
    // 地点解析失败 → 兜底出生点
    expect(calls.residents[0][1].at).toEqual({ x: 5, y: 1, z: 5 })
  })

  it('subsequent overlays turn location changes into walk destinations (AC9 产品侧)', () => {
    const { engine, calls } = sink()
    const driver = new OverlayDriver({
      engine,
      resolveLocation: (name) => (name === '主楼' ? { x: 23, y: 1, z: 24 } : { x: 8, y: 1, z: 12 }),
      spawnFallback: { x: 5, y: 1, z: 5 },
    })
    driver.apply(overlay({ persons: [{ personId: 'p1', locationName: '主楼', activity: '休息', mood: '' }] }))
    driver.apply(overlay({ persons: [{ personId: 'p1', locationName: '庭院', activity: '散步', mood: '' }] }))
    expect(calls.residents[1][0].destination).toEqual({ x: 8, y: 1, z: 12 })
  })
})

describe('OverlayDriver setSimNow 透传(S3b F5)', () => {
  it('apply 时把 overlay.simNow 原样透传给引擎', () => {
    const { engine, calls } = sink()
    const driver = new OverlayDriver({
      engine,
      resolveLocation: () => null,
      spawnFallback: { x: 0, y: 0, z: 0 },
    })
    driver.apply(overlay({}))
    expect(calls.simNows).toEqual(['2026-09-29T14:30:00Z'])
  })
})

describe('OverlayDriver 环境漫步(S4 F5 / AC6)', () => {
  const at = { x: 23, y: 1, z: 24 }

  function driverWith(sinkOpts: { resolveStandable?: (c: typeof at) => typeof at | null; reducedMotion?: () => boolean }) {
    const { engine, calls } = sink()
    const driver = new OverlayDriver({
      engine,
      resolveLocation: () => at,
      spawnFallback: { x: 5, y: 1, z: 5 },
      ...(sinkOpts.resolveStandable ? { resolveStandable: sinkOpts.resolveStandable } : {}),
      ...(sinkOpts.reducedMotion ? { reducedMotion: sinkOpts.reducedMotion } : {}),
    })
    return { driver, calls }
  }

  const person = (simNow: string) => overlay({ simNow, persons: [{ personId: 'p1', locationName: '主楼', activity: '休息', mood: '' }] })

  it('首次落位不漫步;地点未变的后续同步给确定性漫步目的地', () => {
    const { driver, calls } = driverWith({ resolveStandable: (c) => c })
    driver.apply(person('2026-10-15T10:00:00Z'))
    expect(calls.residents[0][0].destination).toBeNull() // 首次直接落位
    driver.apply(person('2026-10-15T10:05:00Z'))
    const dest = calls.residents[1][0].destination
    expect(dest).not.toBeNull()
    expect(Math.hypot(dest!.x - at.x, dest!.z - at.z)).toBeGreaterThanOrEqual(2)
    // 同槽位同轨迹:重复同步目的地不变(不抖动)
    driver.apply(person('2026-10-15T10:10:00Z'))
    expect(calls.residents[2][0].destination).toEqual(dest)
    // 跨槽位换站
    driver.apply(person('2026-10-15T10:35:00Z'))
    expect(calls.residents[3][0].destination).not.toEqual(dest)
  })

  it('日程驱动移动优先:地点变化时让位(漫步不干扰寻路)', () => {
    const { engine, calls } = sink()
    const driver = new OverlayDriver({
      engine,
      resolveLocation: (name) => (name === '主楼' ? at : { x: 8, y: 1, z: 12 }),
      spawnFallback: { x: 5, y: 1, z: 5 },
      resolveStandable: (c) => c,
    })
    driver.apply(overlay({ simNow: '2026-10-15T10:00:00Z', persons: [{ personId: 'p1', locationName: '主楼', activity: '休息', mood: '' }] }))
    driver.apply(overlay({ simNow: '2026-10-15T10:05:00Z', persons: [{ personId: 'p1', locationName: '庭院', activity: '散步', mood: '' }] }))
    expect(calls.residents[1][0].destination).toEqual({ x: 8, y: 1, z: 12 })
  })

  it('reduced-motion 降级:目的地 = 锚点(静止)', () => {
    const { driver, calls } = driverWith({ resolveStandable: (c) => c, reducedMotion: () => true })
    driver.apply(person('2026-10-15T10:00:00Z'))
    driver.apply(person('2026-10-15T10:05:00Z'))
    expect(calls.residents[1][0].destination).toEqual(at)
  })

  it('漫步落点不可走 → 停在锚点;未配 resolveStandable → 不漫步', () => {
    const blocked = driverWith({ resolveStandable: () => null })
    blocked.driver.apply(person('2026-10-15T10:00:00Z'))
    blocked.driver.apply(person('2026-10-15T10:05:00Z'))
    expect(blocked.calls.residents[1][0].destination).toEqual(at)

    const noResolver = driverWith({})
    noResolver.driver.apply(person('2026-10-15T10:00:00Z'))
    noResolver.driver.apply(person('2026-10-15T10:05:00Z'))
    expect(noResolver.calls.residents[1][0].destination).toEqual(at)
  })
})
