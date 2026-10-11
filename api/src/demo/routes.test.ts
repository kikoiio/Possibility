import { describe, expect, it } from 'vitest'
import { claimErrorCopy } from './claim-error-copy'

describe('claim HTTP error mapping', () => {
  it('keeps unknown outcomes distinct from deterministic failures', () => {
    expect(claimErrorCopy('unknown').code).toBe('claim_unconfirmed')
    expect(claimErrorCopy('temporary').code).toBe('claim_failed')
  })
})
