import { describe, expect, it } from 'vitest'
import { createBlockRegistry, createEmptyWorld } from '@possibility/voxel-contract'
import { mapTimeOfDay } from '../engine/day-night'
import { collectSnowQuads, columnTopY, isSkyExposed, WeatherSystem } from '../engine/weather'
import { MotionPreference } from '../engine/motion-preference'
import { WorldModel } from '../engine/world-model'

const at = (x: number, y: number, z: number) => ({ x, y, z })
const registry = createBlockRegistry('mist-manor')

function makeWorld() {
  const doc = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'test')
  const world = new WorldModel(doc)
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) world.setBlock(at(x, 0, z), 'grass')
  return world
}

describe('DayNightCycle.mapTimeOfDay', () => {
  it('noon is brightest, midnight is moonlit dim', () => {
    expect(mapTimeOfDay(0.5).skyLevel).toBe(15)
    expect(mapTimeOfDay(0).skyLevel).toBe(14)
    expect(mapTimeOfDay(0.25).skyLevel).toBeLessThan(15)
    expect(mapTimeOfDay(0.75).skyLevel).toBeLessThan(15)
  })

  it('dusk has a warm tint and night a cool one', () => {
    const dusk = mapTimeOfDay(0.74).bakeEnv.skyTint
    expect(dusk[0]).toBeGreaterThan(dusk[2]) // 红 > 蓝
    const night = mapTimeOfDay(0).bakeEnv.skyTint
    expect(night[2]).toBeGreaterThan(night[0]) // 蓝 > 红
    const noon = mapTimeOfDay(0.5).bakeEnv.skyTint
    expect(Math.abs(noon[0] - noon[2])).toBeLessThan(0.1)
  })

  it('sun direction shifts face shading across the day', () => {
    const morning = mapTimeOfDay(0.3).bakeEnv.faceShade
    const evening = mapTimeOfDay(0.7).bakeEnv.faceShade
    expect(morning.px).not.toBeCloseTo(evening.px, 2)
    expect(mapTimeOfDay(0.5).bakeEnv.faceShade.py).toBeGreaterThan(0.9)
  })

  it('sky color transitions day → dusk → night', () => {
    const day = mapTimeOfDay(0.5).skyColor
    const dusk = mapTimeOfDay(0.74).skyColor
    const night = mapTimeOfDay(0).skyColor
    expect(new Set([day, dusk, night]).size).toBe(3)
  })
})

describe('weather helpers', () => {
  it('columnTopY finds ground and rooftops', () => {
    const world = makeWorld()
    expect(columnTopY(world, registry, 3, 3)).toBe(1)
    world.setBlock(at(3, 1, 3), 'stone')
    world.setBlock(at(3, 2, 3), 'stone')
    expect(columnTopY(world, registry, 3, 3)).toBe(3)
    world.setBlock(at(5, 1, 5), 'water')
    expect(columnTopY(world, registry, 5, 5)).toBe(2) // 水面承雨
  })

  it('isSkyExposed is false under a roof, true in the open', () => {
    const world = makeWorld()
    for (let x = 4; x <= 6; x++) for (let z = 4; z <= 6; z++) world.setBlock(at(x, 4, z), 'roof-tile')
    expect(isSkyExposed(world, registry, 5, 0, 5)).toBe(false) // 屋檐下
    expect(isSkyExposed(world, registry, 8, 0, 8)).toBe(true)
  })

  it('collectSnowQuads covers exposed tops but skips eaves (檐下不积雪)', () => {
    const world = makeWorld()
    for (let x = 4; x <= 6; x++) for (let z = 4; z <= 6; z++) world.setBlock(at(x, 4, z), 'roof-tile')
    const quads = collectSnowQuads(world, registry)
    const all = [...quads.values()].flat()
    // 草地暴露顶面（y=1）大多在列内
    expect(all.some((q) => q.x === 8 && q.y === 1 && q.z === 8)).toBe(true)
    // 屋檐正下方的草地不积雪
    expect(all.some((q) => q.x === 5 && q.y === 1 && q.z === 5)).toBe(false)
    // 瓦顶本身积雪（y=5）
    expect(all.some((q) => q.x === 5 && q.y === 5 && q.z === 5)).toBe(true)
  })
})

describe('MotionPreference', () => {
  it('scales particles and animation to zero when reduced', () => {
    const reduced = new MotionPreference(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList)
    expect(reduced.isReduced()).toBe(true)
    expect(reduced.particleScale()).toBe(0)
    expect(reduced.animationTimeScale()).toBe(0)
    const normal = new MotionPreference(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList)
    expect(normal.particleScale()).toBe(1)
    expect(normal.animationTimeScale()).toBe(1)
  })
})

describe('WeatherSystem intensity lerp', () => {
  it('weather state ramps toward target and back (晴天后效果消退)', () => {
    const world = makeWorld()
    const scene = { add: () => {}, remove: () => {} } as never
    const envCalls: Array<{ fogBoost: number; dim: number }> = []
    const motion = new MotionPreference(() => null)
    const weather = new WeatherSystem(
      scene, world, registry, motion,
      { setWeatherEnv: (m) => envCalls.push(m) },
      () => ({ x: 8, y: 4, z: 8 }),
    )
    weather.setWeather({ rain: 1 })
    for (let i = 0; i < 30; i++) weather.update(1 / 30)
    expect(weather.state.rain).toBeGreaterThan(0.9)
    weather.setWeather({ rain: 0 })
    for (let i = 0; i < 40; i++) weather.update(1 / 30)
    expect(weather.state.rain).toBeLessThan(0.05)
    expect(envCalls.length).toBeGreaterThan(0)
    weather.dispose()
  })
})
