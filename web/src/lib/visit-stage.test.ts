import { describe, expect, it } from 'vitest'
import { visitStageDescription, visitStageLabel } from './visit-stage'

describe('visit stage copy', () => {
  it('distinguishes first visit, return and unknown history', () => {
    expect(visitStageLabel('first_visit')).toBe('首次到场')
    expect(visitStageDescription('first_visit')).not.toContain('离开')
    expect(visitStageLabel('returning')).toBe('再次到场')
    expect(visitStageDescription('returning')).toContain('离开后')
    expect(visitStageLabel('unknown')).toBe('到场状态待确认')
  })
})
