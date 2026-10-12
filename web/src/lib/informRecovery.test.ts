import { describe, expect, it } from 'vitest'
import { decideInformRecovery } from './informRecovery'

describe('inform recovery', () => {
  it('distinguishes a committed receipt from an absent command', () => {
    expect(decideInformRecovery('committed').kind).toBe('committed')
    expect(decideInformRecovery('not_found').kind).toBe('retryable')
  })

  it('keeps network uncertainty pending instead of claiming failure', () => {
    expect(decideInformRecovery('unknown')).toMatchObject({ kind: 'pending' })
  })
})
