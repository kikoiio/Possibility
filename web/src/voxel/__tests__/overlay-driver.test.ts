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
