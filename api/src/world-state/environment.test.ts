import { describe, expect, it } from 'vitest'
import {
  ENVIRONMENT_VALUE_OPTIONS,
  accessBlocked,
  normalizeEnvironmentCondition,
  normalizeEnvironmentValue,
  projectEnvironment,
  projectEnvironmentValues,
} from './environment'

const factJson = (condition: string, value: string, location: string | null = null) =>
  JSON.stringify({ location, condition, value })

describe('D3 finite environment projection', () => {
  it('freezes the supported values for every condition', () => {
    expect(ENVIRONMENT_VALUE_OPTIONS.weather.map(option => option.value)).toEqual(['clear', 'rain', 'fog'])
    expect(ENVIRONMENT_VALUE_OPTIONS.lighting.map(option => option.value)).toEqual(['day', 'dusk', 'night'])
    expect(ENVIRONMENT_VALUE_OPTIONS.access.map(option => option.value)).toEqual(['open', 'closed'])
  })

  it('rejects unknown conditions and arbitrary values', () => {
    expect(normalizeEnvironmentCondition('temperature')).toBeNull()
    expect(normalizeEnvironmentValue('weather', 'hail')).toBeNull()
    expect(normalizeEnvironmentValue('weather', 'storm')).toBeNull()
    expect(normalizeEnvironmentValue('lighting', 'morning')).toBeNull()
    expect(normalizeEnvironmentValue('lighting', 'bright')).toBeNull()
    expect(normalizeEnvironmentValue('access', 'restricted')).toBeNull()
    expect(normalizeEnvironmentValue('weather', 'rain')).toBe('rain')
    expect(normalizeEnvironmentValue('lighting', 'dusk')).toBe('dusk')
    expect(normalizeEnvironmentValue('access', 'closed')).toBe('closed')
  })

  it('projects each legal enum consistently and ignores unsupported facts', () => {
    const projection = projectEnvironment([
      { subjectId: 'Cafe:weather', valueJson: factJson('weather', 'rain', 'Cafe') },
      { subjectId: 'Cafe:lighting', valueJson: factJson('lighting', 'dusk', 'Cafe') },
      { subjectId: 'Cafe:access', valueJson: factJson('access', 'closed', 'Cafe') },
      { subjectId: 'Library:weather', valueJson: factJson('weather', 'fog', 'Library') },
      { subjectId: 'Library:weather', valueJson: factJson('weather', 'hail', 'Library') },
    ])
    expect(projection.locations.Cafe.weather).toMatchObject({ value: 'rain', label: '降雨' })
    expect(projection.locations.Cafe.lighting).toMatchObject({ value: 'dusk', label: '黄昏' })
    expect(projection.locations.Cafe.access).toMatchObject({ value: 'closed', label: '封闭' })
    expect(projection.locations.Library.weather).toMatchObject({ value: 'fog', label: '雾' })
    expect(accessBlocked(projection, 'Cafe')).toBe(true)
    expect(accessBlocked(projection, 'Library')).toBe(false)
  })

  it('uses the same DTO for parsed current values and world-scoped facts', () => {
    const projection = projectEnvironmentValues([
      { subjectId: 'world:weather', value: { location: null, condition: 'weather', value: 'clear' } },
      { subjectId: 'world:lighting', value: { location: null, condition: 'lighting', value: 'night' } },
    ])
    expect(projection.world.weather).toMatchObject({ location: 'world', value: 'clear', label: '晴朗' })
    expect(projection.world.lighting).toMatchObject({ location: 'world', value: 'night', label: '黑夜' })
  })
})
