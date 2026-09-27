import { describe, expect, it } from 'vitest'
import { decideChatRecovery } from './chatRecovery'

describe('chat recovery decision', () => {
  it('refreshes completed requests without asking for a retry', () => {
    expect(decideChatRecovery({ status: 'completed', errorCode: null })).toEqual({
      kind: 'completed', refreshHistory: true, requiresNewRequestId: false, message: null,
    })
  })

  it('keeps pending requests recoverable with the same request ID', () => {
    const decision = decideChatRecovery({ status: 'pending', errorCode: null })
    expect(decision.kind).toBe('pending')
    expect(decision.requiresNewRequestId).toBe(false)
    expect(decision.message).toContain('请勿重复发送')
  })

  it.each([
    ['failed' as const, 'worker_lost'],
    ['failed' as const, 'model_incomplete'],
    ['cancelled' as const, 'request_cancelled'],
  ])('requires a new ID after %s', (status, errorCode) => {
    const decision = decideChatRecovery({ status, errorCode })
    expect(decision.kind).toBe('terminal')
    expect(decision.refreshHistory).toBe(true)
    expect(decision.requiresNewRequestId).toBe(true)
    expect(decision.message).toContain('新的请求 ID')
  })
})
