import { afterEach, describe, expect, it, vi } from 'vitest'
import { authApi, demoApi, getGuestToken, setGuestToken, setToken } from './client'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

afterEach(() => { vi.restoreAllMocks() })

describe('explicit claim identity', () => {
  it('does not attach guest identity to login and preserves it on authentication failure', async () => {
    const storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    setGuestToken('guest-token')
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('X-Possibility-Guest')).toBe(false)
      return { ok: false, status: 401, json: async () => ({ error: '密码错误' }) } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(authApi.login({ username: 'alice', password: 'wrong' })).rejects.toMatchObject({ status: 401 })
    expect(getGuestToken()).toBe('guest-token')
  })

  it('sends account and source copy identities to status, claim and recover', async () => {
    const storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    setToken('account-token'); setGuestToken('guest-token')
    const requests: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {})
      return { ok: true, status: 200, json: async () => ({ kind: 'retryable', epoch: 1, safeToSwitch: true }) } as Response
    }))
    const binding = { sessionId: 's', worldId: 'w', generation: 2 }
    await demoApi.claimStatus({ requestId: 'r', expectedBinding: binding })
    await demoApi.claim({ requestId: 'r', expectedEpoch: 0, expectedBinding: binding })
    await demoApi.recoverClaim({ requestId: 'r', observedEpoch: 0, observedExecutionId: null, expectedBinding: binding })
    for (const request of requests) {
      const headers = new Headers(request.headers)
      expect(headers.get('Authorization')).toBe('Bearer account-token')
      expect(headers.get('X-Possibility-Guest')).toBe('guest-token')
    }
    expect(new Headers(requests[0].headers).get('Cache-Control')).toBeNull()
  })
})
// End of the explicit identity client tests.
