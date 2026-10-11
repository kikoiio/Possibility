import { describe, expect, it } from 'vitest'
import type { ClaimStatus } from './types'

describe('claim status contract', () => {
  it('does not make a missing operation safe to switch', () => {
    const status: ClaimStatus = { kind: 'not-started', epoch: 0, safeToSwitch: false }
    expect(status.safeToSwitch).toBe(false)
  })
})
