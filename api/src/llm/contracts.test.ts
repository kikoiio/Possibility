import { describe, expect, it } from 'vitest'
import { LLM_CONTRACT_VERSIONS, LlmContractError, llmError, parseContractObject, requireNumber,
  requireString } from './contracts'

describe('LLM contract errors', () => {
  it('keeps stable error codes while preserving the original cause', () => {
    const original = new Error('transport detail')
    const wrapped = llmError(original, 'provider_error')
    expect(wrapped).toMatchObject({ name: 'LlmContractError', code: 'provider_error', message: 'transport detail' })
    expect(wrapped.cause).toBe(original)
    expect(llmError(new LlmContractError('truncated', 'cut off'))).toMatchObject({ code: 'truncated' })
  })

  it('requires a pure JSON object at a versioned contract boundary', () => {
    expect(parseContractObject('{"ok":true}', LLM_CONTRACT_VERSIONS.beat)).toEqual({ ok: true })
    expect(() => parseContractObject('prefix {"ok":true}', LLM_CONTRACT_VERSIONS.beat))
      .toThrow(expect.objectContaining({ code: 'invalid_json' }))
    expect(() => parseContractObject('[]', LLM_CONTRACT_VERSIONS.beat))
      .toThrow(expect.objectContaining({ code: 'contract_violation' }))
  })

  it('does not coerce schema field types or out-of-range business values', () => {
    expect(requireString(' text ', 'content', LLM_CONTRACT_VERSIONS.summary, 20)).toBe('text')
    expect(() => requireString(123, 'content', LLM_CONTRACT_VERSIONS.summary, 20))
      .toThrow(expect.objectContaining({ code: 'contract_violation' }))
    expect(() => requireNumber('7', 'importance', LLM_CONTRACT_VERSIONS.summary, 1, 10))
      .toThrow(expect.objectContaining({ code: 'contract_violation' }))
  })
})
