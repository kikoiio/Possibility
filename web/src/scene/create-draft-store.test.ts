import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CREATE_DRAFT_STORAGE_KEY,
  CREATE_DRAFT_TTL_MS,
  createCreateDraftStore,
  type CreateDraftStorage,
} from './create-draft-store'

interface Context {
  prompt: string
  selectedPersonIds: string[]
}

interface Draft {
  document: { sections: number[] }
}

function memoryStorage(): CreateDraftStorage<{ draft: Draft; expiresAt: number }> & { value: { draft: Draft; expiresAt: number } | null } {
  const result = {
    value: null as { draft: Draft; expiresAt: number } | null,
    async get() { return result.value },
    async set(value: { draft: Draft; expiresAt: number }) { result.value = structuredClone(value) },
    async remove() { result.value = null },
  }
  return result
}

function memoryLocalStorage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

describe('create draft store', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('stores context in localStorage and expires it after seven days', () => {
    const now = vi.fn(() => 1_000)
    const storage = memoryStorage()
    const localStorage = memoryLocalStorage()
    const store = createCreateDraftStore<Context, Draft>({ storage, localStorage, now })
    const context = { prompt: 'A quiet garden', selectedPersonIds: ['person-1'] }

    expect(store.saveContext(context)).toBe(true)
    expect(JSON.parse(localStorage.getItem(CREATE_DRAFT_STORAGE_KEY)!)).toEqual({
      version: 1,
      expiresAt: 1_000 + CREATE_DRAFT_TTL_MS,
      context,
    })
    expect(storage.value).toBeNull()
    now.mockReturnValue(1_000 + CREATE_DRAFT_TTL_MS)

    expect(store.loadContext()).toBeNull()
    expect(localStorage.getItem(CREATE_DRAFT_STORAGE_KEY)).toBeNull()
  })

  it('stores the document in IndexedDB and overwrites the single saved draft', async () => {
    const storage = memoryStorage()
    const localStorage = memoryLocalStorage()
    const store = createCreateDraftStore<Context, Draft>({ storage, localStorage, now: () => 5 })
    const first = { document: { sections: [1] } }
    const second = { document: { sections: [2, 3] } }

    expect(await store.saveDraft(first)).toBe(true)
    expect(await store.saveDraft(second)).toBe(true)
    await expect(store.loadDraft()).resolves.toEqual(second)
    expect(storage.value).toEqual({ draft: second, expiresAt: 5 + CREATE_DRAFT_TTL_MS })
    expect(localStorage.values.size).toBe(0)
  })

  it('expires drafts independently and silently degrades when persistence fails', async () => {
    const localStorage = memoryLocalStorage()
    const storage = memoryStorage()
    const now = vi.fn(() => 10)
    const store = createCreateDraftStore<Context, Draft>({ storage, localStorage, now })
    const draft = { document: { sections: [1] } }
    expect(await store.saveDraft(draft)).toBe(true)
    now.mockReturnValue(10 + CREATE_DRAFT_TTL_MS)
    await expect(store.loadDraft()).resolves.toBeNull()
    expect(storage.value).toBeNull()

    vi.spyOn(storage, 'set').mockRejectedValue(new Error('quota'))
    await expect(store.saveDraft(draft)).resolves.toBe(false)
    await expect(store.clearDraft()).resolves.toBeUndefined()
    expect(store.saveContext({ prompt: 'x', selectedPersonIds: [] })).toBe(true)
    store.clearContext()
    expect(localStorage.getItem(CREATE_DRAFT_STORAGE_KEY)).toBeNull()
  })
})
