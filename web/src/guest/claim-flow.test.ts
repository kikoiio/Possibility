import { describe, expect, it, vi } from 'vitest'
import type { ClaimStatus } from '../api/client'
import { createGuestClaimFlow } from './claim-flow'
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

function setup() {
  const storage = new MemoryStorage()
  const store = createGuestClaimStore({ storage, getToken: () => 'guest-token', clearToken: () => undefined })
  store.write(createInitialGuestClaimContext({ sessionId: 's', worldId: 'w', generation: 0 }, { guestToken: 'guest-token' }))
  const claim = vi.fn<() => Promise<ClaimStatus>>(async () => ({ kind: 'claimed', worldId: 'saved', replayed: false }))
  const claimStatus = vi.fn<() => Promise<ClaimStatus>>(async () => ({ kind: 'not-started', epoch: 0, safeToSwitch: false }))
  const recoverClaim = vi.fn<() => Promise<ClaimStatus>>(async () => ({ kind: 'retryable', epoch: 1, safeToSwitch: true }))
  return { store, claim, claimStatus, recoverClaim, storage }
}

describe('guest claim authentication entry', () => {
  it('only a successful authentication event starts a claim', async () => {
    const deps = setup()
    const flow = createGuestClaimFlow({ store: deps.store, client: deps, getGuestToken: () => 'guest-token' })
    expect(deps.claim).not.toHaveBeenCalled()
    await flow.afterAuthentication({ id: 'u', username: 'alice' })
    expect(deps.claim).toHaveBeenCalledTimes(1)
    expect(flow.phase).toBe('completed')
  })
})
describe('guest claim save wait boundary', () => {
  it('persists submitted before POST and enters unknown at the 60 second boundary', async () => {
    vi.useFakeTimers()
    const deps = setup()
    let resolveClaim: ((value: Awaited<ReturnType<typeof deps.claim>>) => void) | undefined
    deps.claim.mockImplementationOnce(() => new Promise(resolve => { resolveClaim = resolve }))
    const flow = createGuestClaimFlow({ store: deps.store, client: deps, getGuestToken: () => 'guest-token' })
    const pending = flow.afterAuthentication({ id: 'u', username: 'alice' })
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.parse(deps.storage.getItem('possibility_guest_claim_context:v1')!).submitted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(flow.phase).toBe('unknown')
    resolveClaim?.({ kind: 'claimed', worldId: 'late', replayed: false })
    await pending
    vi.useRealTimers()
  })
})
describe('guest claim safe manual recovery', () => {
  it('recovery updates the version and does not submit a follow-up claim', async () => {
    const deps = setup()
    deps.claim.mockImplementationOnce(async () => ({ kind: 'in-progress', epoch: 0, recoveryAvailable: false, safeToSwitch: false }))
    const flow = createGuestClaimFlow({ store: deps.store, client: deps, getGuestToken: () => 'guest-token' })
    await flow.afterAuthentication({ id: 'u', username: 'alice' })
    deps.claim.mockClear()
    await flow.recover()
    expect(deps.recoverClaim).toHaveBeenCalledTimes(1)
    expect(deps.claim).not.toHaveBeenCalled()
    expect(flow.phase).toBe('retryable')
  })
})
// End of the flow contract tests.
