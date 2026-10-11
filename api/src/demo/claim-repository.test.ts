import { describe, expect, it } from 'vitest'
import { candidateWorldIdFor } from './claim-repository'

describe('claim repository primitives', () => {
  it('derives a stable candidate id from the execution request and source', async () => {
    const first = await candidateWorldIdFor('claim:one', 'sandbox-one')
    const second = await candidateWorldIdFor('claim:one', 'sandbox-one')
    const other = await candidateWorldIdFor('claim:two', 'sandbox-one')
    expect(first).toBe(second)
    expect(other).not.toBe(first)
  })
})
