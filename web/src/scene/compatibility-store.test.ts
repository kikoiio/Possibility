import { describe, expect, it } from 'vitest'
import {
  COMPATIBILITY_STORE_KEY,
  COMPATIBILITY_STORE_VERSION,
  createCompatibilityStore,
  emptyCompatibilityContinuation,
  pruneCompatibilityContinuationsForAuthChange,
  type CompatibilityContinuation,
  type CompatibilityStorage,
} from './compatibility-store'

function memoryStorage(overrides: Partial<CompatibilityStorage> = {}): CompatibilityStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
    ...overrides,
  }
}

const scope = { actorKey: 'actor-1', worldId: 'world-1' }
const scopeKey = `${scope.actorKey}${String.fromCharCode(0)}${scope.worldId}`

describe('compatibility store', () => {
  it('does not read records owned by another actor or world', () => {
    const storage = memoryStorage()
    const store = createCompatibilityStore({ storage })
    expect(store.save(emptyCompatibilityContinuation(scope))).toBe(true)
    expect(store.load({ actorKey: 'actor-2', worldId: scope.worldId })).toBeNull()
    expect(store.load({ actorKey: scope.actorKey, worldId: 'world-2' })).toBeNull()
    expect(store.load(scope)).not.toBeNull()
  })

  it('treats corrupted JSON as no record instead of throwing', () => {
    const storage = memoryStorage()
    storage.setItem(COMPATIBILITY_STORE_KEY, '{not-json')
    const store = createCompatibilityStore({ storage })
    expect(() => store.load(scope)).not.toThrow()
    expect(store.load(scope)).toBeNull()
    storage.setItem(COMPATIBILITY_STORE_KEY, JSON.stringify({ version: 1, records: { bad: { candidate: { full: true } } } }))
    expect(store.load(scope)).toBeNull()
  })

  it('returns false on quota or write failure and keeps the in-memory input untouched', () => {
    const storage = memoryStorage({
      setItem: () => { throw new DOMException('quota exceeded', 'QuotaExceededError') },
    })
    const store = createCompatibilityStore({ storage })
    const continuation = emptyCompatibilityContinuation(scope)
    continuation.state = 'preview'
    continuation.requestId = 'request-1'
    const before = structuredClone(continuation)
    expect(store.save(continuation)).toBe(false)
    expect(continuation).toEqual(before)
    expect(continuation.state).toBe('preview')
    expect(store.load(scope)).toBeNull()
  })

  it('clears only the current scope and keeps other records', () => {
    const storage = memoryStorage()
    const store = createCompatibilityStore({ storage })
    const other = { actorKey: 'actor-2', worldId: scope.worldId }
    expect(store.save(emptyCompatibilityContinuation(scope))).toBe(true)
    expect(store.save(emptyCompatibilityContinuation(other))).toBe(true)
    store.clear(scope)
    expect(store.load(scope)).toBeNull()
    expect(store.load(other)).not.toBeNull()
  })

  it('keeps different accounts isolated after sign-out and sign-in', () => {
    const storage = memoryStorage()
    const store = createCompatibilityStore({ storage })
    const first = emptyCompatibilityContinuation(scope)
    first.state = 'preview'
    expect(store.save(first)).toBe(true)
    store.clear(scope)
    const second = emptyCompatibilityContinuation({ actorKey: 'actor-2', worldId: scope.worldId })
    expect(store.save(second)).toBe(true)
    expect(store.load({ actorKey: 'actor-2', worldId: scope.worldId })?.state).toBe('idle')
    expect(store.load(scope)).toBeNull()
    expect(JSON.parse(storage.values.get(COMPATIBILITY_STORE_KEY)!).records[scopeKey]).toBeUndefined()
  })

  it('clears private preview state on identity change but retains only unresolved submit identities', () => {
    const storage = memoryStorage()
    const store = createCompatibilityStore({ storage })
    const preview = { ...emptyCompatibilityContinuation(scope), state: 'preview' as const, requestId: 'preview-request' }
    const pending = { ...emptyCompatibilityContinuation({ actorKey: 'actor-2', worldId: 'world-2' }), state: 'unknown' as const, requestId: 'unknown-request' }
    const completed = { ...emptyCompatibilityContinuation({ actorKey: 'actor-3', worldId: 'world-3' }), state: 'completed' as const, requestId: 'completed-request' }
    expect(store.save(preview)).toBe(true)
    expect(store.save(pending)).toBe(true)
    expect(store.save(completed)).toBe(true)

    pruneCompatibilityContinuationsForAuthChange(storage)

    expect(store.load(scope)).toBeNull()
    expect(store.load(pending.scope)?.requestId).toBe('unknown-request')
    expect(store.load(completed.scope)).toBeNull()
    const serialized = storage.values.get(COMPATIBILITY_STORE_KEY) ?? ''
    expect(serialized).not.toContain('preview-request')
    expect(serialized).not.toContain('completed-request')
    expect(serialized).toContain('unknown-request')
  })

  it('isolates actor/world records and never persists forbidden payloads', () => {
    const storage = memoryStorage()
    const store = createCompatibilityStore({ storage, now: () => new Date('2026-10-05T00:00:00.000Z') })
    const continuation = emptyCompatibilityContinuation(scope)
    expect(store.save(continuation)).toBe(true)
    expect(store.load(scope)).toEqual(continuation)
    expect(store.load({ actorKey: 'actor-2', worldId: scope.worldId })).toBeNull()

    const forbidden = { ...continuation, receipt: { document: { secret: true } } } as unknown as typeof continuation
    expect(store.save(forbidden)).toBe(false)
    expect(JSON.parse(storage.values.get(COMPATIBILITY_STORE_KEY)!).records[scopeKey]).toEqual(continuation)
  })

  it('defaults nextAttempt to null when loading older v1 records', () => {
    const storage = memoryStorage()
    const legacy = emptyCompatibilityContinuation(scope) as unknown as Record<string, unknown>
    delete legacy.nextAttempt
    storage.setItem(COMPATIBILITY_STORE_KEY, JSON.stringify({
      version: COMPATIBILITY_STORE_VERSION,
      records: { [scopeKey]: legacy },
    }))
    const store = createCompatibilityStore({ storage })
    const loaded = store.load(scope)
    expect(loaded).not.toBeNull()
    expect(loaded?.nextAttempt).toBeNull()
    expect(loaded?.version).toBe(COMPATIBILITY_STORE_VERSION)
  })

  it('round-trips nextAttempt through save and load', () => {
    const storage = memoryStorage()
    const store = createCompatibilityStore({ storage })
    const continuation: CompatibilityContinuation = {
      ...emptyCompatibilityContinuation(scope),
      state: 'preview',
      requestId: 'request-1',
      nextAttempt: 2,
    }
    expect(store.save(continuation)).toBe(true)
    expect(store.load(scope)?.nextAttempt).toBe(2)
  })
})
