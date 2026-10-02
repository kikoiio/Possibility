export const CREATE_DRAFT_STORAGE_KEY = 'possibility:world-create:v1'
export const CREATE_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000

const DATABASE_NAME = 'possibility-world-create'
const OBJECT_STORE_NAME = 'drafts'
const DRAFT_SLOT = 'current'
const ENVELOPE_VERSION = 1

interface Envelope {
  version: number
  expiresAt: number
}

export interface CreateDraftStorage<T> {
  get(): Promise<T | null>
  set(draft: T): Promise<void>
  remove(): Promise<void>
}

export interface CreateDraftStoreOptions<TDraft> {
  storage?: CreateDraftStorage<{ draft: TDraft; expiresAt: number }>
  localStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  now?: () => number
}

export interface CreateDraftStore<TContext, TDraft> {
  loadContext(): TContext | null
  saveContext(context: TContext): boolean
  clearContext(): void
  loadDraft(): Promise<TDraft | null>
  saveDraft(draft: TDraft): Promise<boolean>
  clearDraft(): Promise<void>
}

function browserLocalStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return globalThis.localStorage
  } catch {
    return null
  }
}

export function createIndexedDbDraftStorage<T>(): CreateDraftStorage<T> {
  function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let factory: IDBFactory
      try {
        factory = globalThis.indexedDB
      } catch (error) {
        reject(error)
        return
      }
      if (!factory) {
        reject(new Error('IndexedDB is unavailable'))
        return
      }

      let request: IDBOpenDBRequest
      try {
        request = factory.open(DATABASE_NAME, 1)
      } catch (error) {
        reject(error)
        return
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(OBJECT_STORE_NAME)) {
          request.result.createObjectStore(OBJECT_STORE_NAME)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Unable to open draft storage'))
      request.onblocked = () => reject(new Error('Draft storage upgrade is blocked'))
    })
  }

  async function run<TValue>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<TValue>,
  ): Promise<TValue> {
    const database = await openDatabase()
    try {
      return await new Promise<TValue>((resolve, reject) => {
        try {
          const transaction = database.transaction(OBJECT_STORE_NAME, mode)
          const request = operation(transaction.objectStore(OBJECT_STORE_NAME))
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error ?? new Error('Draft storage request failed'))
          transaction.onabort = () => reject(transaction.error ?? new Error('Draft storage transaction aborted'))
        } catch (error) {
          reject(error)
        }
      })
    } finally {
      database.close()
    }
  }

  return {
    async get() {
      const value = await run('readonly', store => store.get(DRAFT_SLOT))
      return value === undefined ? null : value as T
    },
    async set(draft) {
      await run('readwrite', store => store.put(draft, DRAFT_SLOT))
    },
    async remove() {
      await run('readwrite', store => store.delete(DRAFT_SLOT))
    },
  }
}

export function createCreateDraftStore<TContext, TDraft>(options: CreateDraftStoreOptions<TDraft> = {}): CreateDraftStore<TContext, TDraft> {
  const storage = options.storage ?? createIndexedDbDraftStorage<{ draft: TDraft; expiresAt: number }>()
  const localStorage = options.localStorage ?? browserLocalStorage()
  const now = options.now ?? Date.now

  function readLocal(): { context: TContext; envelope: Envelope } | null {
    if (!localStorage) return null
    try {
      const raw = localStorage.getItem(CREATE_DRAFT_STORAGE_KEY)
      if (!raw) return null
      const value: unknown = JSON.parse(raw)
      if (typeof value !== 'object' || value === null) return null
      const record = value as { version?: unknown; expiresAt?: unknown; context?: unknown }
      if (record.version !== ENVELOPE_VERSION || !Number.isFinite(record.expiresAt)
        || typeof record.context !== 'object' || record.context === null) return null
      return { context: record.context as TContext, envelope: record as Envelope }
    } catch {
      return null
    }
  }

  function clearContext(): void {
    try { localStorage?.removeItem(CREATE_DRAFT_STORAGE_KEY) } catch { /* Draft persistence is optional. */ }
  }

  return {
    loadContext() {
      const saved = readLocal()
      if (!saved) {
        clearContext()
        return null
      }
      if (saved.envelope.expiresAt <= now()) {
        clearContext()
        return null
      }
      return saved.context
    },
    saveContext(context: TContext) {
      if (!localStorage) return false
      try {
        localStorage.setItem(CREATE_DRAFT_STORAGE_KEY, JSON.stringify({
          version: ENVELOPE_VERSION,
          expiresAt: now() + CREATE_DRAFT_TTL_MS,
          context,
        }))
        return true
      } catch {
        clearContext()
        return false
      }
    },
    clearContext,
    async loadDraft(): Promise<TDraft | null> {
      try {
        const saved = await storage.get()
        if (!saved) return null
        if (!Number.isFinite(saved.expiresAt) || saved.expiresAt <= now()) {
          await storage.remove()
          return null
        }
        return saved.draft
      } catch { return null }
    },
    async saveDraft(draft: TDraft) {
      try {
        await storage.set({ draft, expiresAt: now() + CREATE_DRAFT_TTL_MS })
        return true
      } catch { return false }
    },
    async clearDraft() {
      try { await storage.remove() } catch { /* Draft persistence is optional. */ }
    },
  }
}
