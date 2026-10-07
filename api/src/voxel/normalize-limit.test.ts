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

  it('follows newly exposed clearance issues within the bounded repair passes', () => {
    const points = Array.from({ length: 20 }, (_, x) => ({ x, y: 1, z: 1 }))
    const issues = (indexes: number[]): ValidationIssue[] => indexes.map(index => ({
      code: 'walk-clearance',
      message: 'low passage',
      at: points[index]!,
    } as ValidationIssue))
    const validationPasses = [...Array.from({ length: 20 }, (_, index) => issues([index])), []]
    let document = { theme: 'mist-manor', size: { width: 8, height: 4, depth: 8 } } as VoxelDocument

    contract.createBlockRegistry.mockReturnValue({})
    contract.validateDocument.mockReturnValue([])
    contract.validateWalkability.mockImplementation(() => validationPasses.shift() ?? [])
    contract.applyEdits.mockImplementation(() => {
      document = { ...document }
      return { document }
    })

    const result = normalizeWorldDocument(document)

    expect(contract.applyEdits).toHaveBeenCalledTimes(20)
    expect(contract.validateWalkability).toHaveBeenCalledTimes(21)
    expect(result.repairable).toBe(true)
    expect(result.fixes).toHaveLength(20)
    expect(result.fixes.at(-1)).toBe('walk-clearance:1->0')
  })

  it('rejects a clearance edit that introduces a different validation issue', () => {
    const document = { theme: 'mist-manor', size: { width: 8, height: 4, depth: 8 } } as VoxelDocument
    const candidate = { ...document }
    contract.createBlockRegistry.mockReturnValue({})
    contract.validateDocument.mockReturnValue([])
    contract.validateWalkability.mockReturnValueOnce([{
      code: 'walk-clearance', message: 'low passage', at: { x: 1, y: 1, z: 1 },
    } as ValidationIssue]).mockReturnValueOnce([{
      code: 'walk-connectivity', message: 'unreachable carrier', at: { x: 2, y: 1, z: 2 },
    } as ValidationIssue])
    contract.applyEdits.mockReturnValue({ document: candidate })

    const result = normalizeWorldDocument(document)

    expect(result).toEqual({ document, fixes: [], repairable: false })
    expect(contract.applyEdits).toHaveBeenCalledTimes(1)
  })
})
