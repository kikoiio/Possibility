import { describe, expect, it } from 'vitest'
import { CLAIM_LEASE_MS } from './claim-repository'

describe('claim publication contract', () => {
  it('uses a lease independent from the browser wait boundary', () => {
    expect(CLAIM_LEASE_MS).toBeGreaterThan(60_000)
  })
})
