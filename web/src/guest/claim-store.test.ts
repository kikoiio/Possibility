import { describe, expect, it } from 'vitest'
import { createGuestClaimStore, createInitialGuestClaimContext } from './claim-store'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

describe('guest claim persistent intent', () => {
  it('persistent intent survives a new store instance without raw credentials', () => {
    const storage = new MemoryStorage()
    const context = createInitialGuestClaimContext({ sessionId: 'session-1', worldId: 'world-1', generation: 3 }, { guestToken: 'secret-token' })
    expect(createGuestClaimStore({ storage, getToken: () => 'secret-token' }).write(context)).toEqual({ ok: true })
    const raw = storage.getItem('possibility_guest_claim_context:v1') ?? ''
    expect(raw).not.toContain('secret-token')
    expect(createGuestClaimStore({ storage, getToken: () => 'secret-token' }).read()).toEqual({ kind: 'ready', context })
  })

  it('confirmed receipt cleanup only matches the captured copy and target', () => {
    const storage = new MemoryStorage()
    const clearCalls: string[] = []
    const store = createGuestClaimStore({ storage, getToken: () => 'guest-token', clearToken: () => clearCalls.push('cleared') })
    const context = { ...createInitialGuestClaimContext({ sessionId: 's', worldId: 'w', generation: 0 }, { guestToken: 'guest-token' }), target: { userId: 'u', username: 'alice' }, submitted: true }
    store.write(context)
    expect(store.completeConfirmedClaim({ guestToken: 'other', requestId: context.requestId, targetUserId: 'u' }, { worldId: 'saved', targetUserId: 'u' })).toEqual({ ok: false })
    expect(store.completeConfirmedClaim({ guestToken: 'guest-token', requestId: context.requestId, targetUserId: 'u' }, { worldId: 'saved', targetUserId: 'u' })).toEqual({ ok: true })
    expect(storage.getItem('possibility_guest_claim_context:v1')).toBeNull()
    expect(clearCalls).toEqual(['cleared'])
  })
})
