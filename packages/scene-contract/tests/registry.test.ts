import { describe, expect, it } from 'vitest'
import { getCriticalSheets, getDeferredSheets, getTheme, requireTheme, validateRegisteredTheme } from '../src/registry'

describe('theme registry', () => {
  it('resolves both built-in themes and rejects missing IDs', () => {
    expect(getTheme('contemporary-daily-life')?.id).toBe('contemporary-daily-life')
    expect(getTheme('test-minimal')?.id).toBe('test-minimal')
    expect(() => requireTheme('missing')).toThrow('unknown scene theme')
    expect(validateRegisteredTheme('test-minimal')).toEqual([])
  })
  it('classifies theme sheets for critical loading', () => {
    expect(getCriticalSheets('test-minimal')).toEqual(['test'])
    expect(getDeferredSheets('test-minimal')).toEqual([])
  })
})
