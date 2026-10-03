import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ValidationIssue, VoxelDocument } from '@possibility/voxel-contract'

const contract = vi.hoisted(() => ({
  applyEdits: vi.fn(),
  createBlockRegistry: vi.fn(),
  validateDocument: vi.fn(),
  validateWalkability: vi.fn(),
}))

vi.mock('@possibility/voxel-contract', async importOriginal => {
  const original = await importOriginal<typeof import('@possibility/voxel-contract')>()
  return {
    ...original,
    applyEdits: contract.applyEdits,
    createBlockRegistry: contract.createBlockRegistry,
    validateDocument: contract.validateDocument,
    validateWalkability: contract.validateWalkability,
  }
})

import { normalizeWorldDocument } from './normalize'

describe('normalizeWorldDocument repair bound', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stops after three clearance repair passes and hands the remaining issue back', () => {
    const points = [
      { x: 1, y: 1, z: 1 },
      { x: 2, y: 1, z: 1 },
      { x: 3, y: 1, z: 1 },
      { x: 4, y: 1, z: 1 },
    ]
    const issues = (indexes: number[]): ValidationIssue[] => indexes.map(index => ({
      code: 'walk-clearance',
      message: 'low passage',
      at: points[index]!,
    } as ValidationIssue))
    const validationPasses = [
      issues([0, 1, 2, 3]),
      issues([1, 2, 3]),
      issues([2, 3]),
      issues([3]),
    ]
    let document = { theme: 'mist-manor', size: { width: 8, height: 4, depth: 8 } } as VoxelDocument

    contract.createBlockRegistry.mockReturnValue({})
    contract.validateDocument.mockReturnValue([])
    contract.validateWalkability.mockImplementation(() => validationPasses.shift() ?? [])
    contract.applyEdits.mockImplementation(() => {
      document = { ...document }
      return { document }
    })

    const result = normalizeWorldDocument(document)

    expect(contract.applyEdits).toHaveBeenCalledTimes(3)
    expect(contract.validateWalkability).toHaveBeenCalledTimes(4)
    expect(result.repairable).toBe(false)
    expect(result.fixes).toEqual([
      'walk-clearance:4->3',
      'walk-clearance:3->2',
      'walk-clearance:2->1',
    ])
  })
})
