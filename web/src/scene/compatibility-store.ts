import type {
  CompatibilityPurpose,
  SceneCompatibilityDraftView,
  SceneCompatibilityFailureView,
  SceneCommitReceipt,
  SceneEditPreflightResult,
  SceneInspectionResult,
  SceneSourceRef,
  SceneTarget,
  SceneValidationBasis,
} from '@possibility/voxel-contract'

export const COMPATIBILITY_STORE_KEY = 'possibility:scene-compatibility:v1'
export const COMPATIBILITY_STORE_VERSION = 1

export const COMPATIBILITY_STATES = [
  'idle',
  'checking',
  'diagnosed',
  'building',
  'preview',
  'submitting',
  'unknown',
  'conflict',
  'completed',
] as const

export type CompatibilityState = typeof COMPATIBILITY_STATES[number]

export interface CompatibilityScope {
  actorKey: string
  worldId: string
}

/**
 * Only data needed to resume the compatibility journey belongs here.
 * In particular, this type has no scene document, credentials, or API key.
 */
export interface CompatibilityContinuation {
  version: typeof COMPATIBILITY_STORE_VERSION
  scope: CompatibilityScope
  state: CompatibilityState
  requestId: string | null
  draftId: string | null
  purpose: CompatibilityPurpose | null
  target: SceneTarget | null
  expectedCurrentVersion: number | null
  /** Next submit attempt confirmed by the server; null until a retryable not-committed response names it. */
  nextAttempt: number | null
  source: SceneSourceRef | null
  basis: SceneValidationBasis | null
  inspection: CompatibilityInspection | null
  draft: CompatibilityDraftSummary | null
  failure: SceneCompatibilityFailureView | null
  receipt: SceneCommitReceipt | null
  message: string | null
  updatedAt: string
}

export type CompatibilityInspection = Extract<SceneInspectionResult, { status: 'ready' }>

/** A view-only draft summary; it intentionally cannot carry `candidate`. */
export type CompatibilityDraftSummary = Omit<SceneCompatibilityDraftView, 'basis'> & {
  basis: SceneValidationBasis
}

export interface CompatibilityStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface CompatibilityStore {
  load(scope: CompatibilityScope): CompatibilityContinuation | null
  save(continuation: CompatibilityContinuation): boolean
  clear(scope: CompatibilityScope): void
}

export interface CompatibilityStoreOptions {
  storage?: CompatibilityStorage
  now?: () => Date
}

type StoredEnvelope = {
  version: typeof COMPATIBILITY_STORE_VERSION
  records: Record<string, CompatibilityContinuation>
}

function browserStorage(): CompatibilityStorage | null {
  try {
    return globalThis.localStorage
  } catch {
    return null
  }
}

function scopeKey(scope: CompatibilityScope): string {
  return `${scope.actorKey}\u0000${scope.worldId}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasForbiddenPayload(value: unknown, seen = new Set<unknown>()): boolean {
  if (!isObject(value) && !Array.isArray(value)) return false
  if (seen.has(value)) return false
  seen.add(value)
  if (isObject(value)) {
    for (const key of Object.keys(value)) {
      if (key === 'candidate' || key === 'document' || key === 'credentials' || key === 'apiKey' || key === 'token') return true
      if (hasForbiddenPayload(value[key], seen)) return true
    }
  } else {
    for (const item of value) if (hasForbiddenPayload(item, seen)) return true
  }
  return false
}

function readEnvelope(storage: CompatibilityStorage): StoredEnvelope {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(COMPATIBILITY_STORE_KEY) ?? '')
    if (!isObject(parsed) || parsed.version !== COMPATIBILITY_STORE_VERSION || !isObject(parsed.records)) {
      return { version: COMPATIBILITY_STORE_VERSION, records: {} }
    }
    const records: Record<string, CompatibilityContinuation> = {}
    for (const [key, value] of Object.entries(parsed.records)) {
      if (!hasForbiddenPayload(value)) records[key] = value as CompatibilityContinuation
    }
    return { version: COMPATIBILITY_STORE_VERSION, records }
  } catch {
    return { version: COMPATIBILITY_STORE_VERSION, records: {} }
  }
}

/**
 * On authentication identity changes, discard private draft/preview metadata.
 * Keep only an unresolved submit identity so the same actor can recover a result
 * after signing back in; the value is still scoped by actor and world and contains
 * no candidate, scene document, or credential.
 */
export function pruneCompatibilityContinuationsForAuthChange(storage = browserStorage()): void {
  if (!storage) return
  try {
    const envelope = readEnvelope(storage)
    for (const [key, record] of Object.entries(envelope.records)) {
      if (!isContinuation(record) || (record.state !== 'submitting' && record.state !== 'unknown')) {
        delete envelope.records[key]
      }
    }
    if (Object.keys(envelope.records).length === 0) storage.removeItem(COMPATIBILITY_STORE_KEY)
    else storage.setItem(COMPATIBILITY_STORE_KEY, JSON.stringify(envelope))
  } catch {
    // Authentication changes must not be blocked by best-effort private metadata cleanup.
  }
}

function isContinuation(value: unknown): value is CompatibilityContinuation {
  if (!isObject(value) || value.version !== COMPATIBILITY_STORE_VERSION || !isObject(value.scope)) return false
  if (typeof value.scope.actorKey !== 'string' || typeof value.scope.worldId !== 'string') return false
  return typeof value.state === 'string' && (COMPATIBILITY_STATES as readonly string[]).includes(value.state)
    && typeof value.updatedAt === 'string'
}

/** Older v1 records predate `nextAttempt`; default it instead of bumping the store version. */
function normalizeContinuation(record: CompatibilityContinuation): CompatibilityContinuation {
  return { ...record, nextAttempt: typeof record.nextAttempt === 'number' ? record.nextAttempt : null }
}

export function createCompatibilityStore(options: CompatibilityStoreOptions = {}): CompatibilityStore {
  const storage = options.storage ?? browserStorage()
  const now = options.now ?? (() => new Date())

  return {
    load(scope) {
      if (!storage) return null
      const record = readEnvelope(storage).records[scopeKey(scope)]
      if (!isContinuation(record) || record.scope.actorKey !== scope.actorKey || record.scope.worldId !== scope.worldId) return null
      return structuredClone(normalizeContinuation(record))
    },
    save(continuation) {
      if (!storage || hasForbiddenPayload(continuation)) return false
      try {
        const envelope = readEnvelope(storage)
        envelope.records[scopeKey(continuation.scope)] = {
          ...structuredClone(continuation),
          version: COMPATIBILITY_STORE_VERSION,
          updatedAt: continuation.updatedAt || now().toISOString(),
        }
        storage.setItem(COMPATIBILITY_STORE_KEY, JSON.stringify(envelope))
        return true
      } catch {
        return false
      }
    },
    clear(scope) {
      if (!storage) return
      try {
        const envelope = readEnvelope(storage)
        delete envelope.records[scopeKey(scope)]
        if (Object.keys(envelope.records).length === 0) storage.removeItem(COMPATIBILITY_STORE_KEY)
        else storage.setItem(COMPATIBILITY_STORE_KEY, JSON.stringify(envelope))
      } catch {
        // Continuation persistence is best effort.
      }
    },
  }
}

/** Build an empty continuation without exposing storage internals to callers. */
export function emptyCompatibilityContinuation(scope: CompatibilityScope, now = new Date()): CompatibilityContinuation {
  return {
    version: COMPATIBILITY_STORE_VERSION,
    scope: { ...scope },
    state: 'idle',
    requestId: null,
    draftId: null,
    purpose: null,
    target: null,
    expectedCurrentVersion: null,
    nextAttempt: null,
    source: null,
    basis: null,
    inspection: null,
    draft: null,
    failure: null,
    receipt: null,
    message: null,
    updatedAt: now.toISOString(),
  }
}

/** Convert a server draft view to the metadata-only shape accepted by the store. */
export function toCompatibilityDraftSummary(draft: SceneCompatibilityDraftView): CompatibilityDraftSummary {
  return structuredClone(draft)
}

/** Convert an edit preflight result into an inspection-like diagnostic when needed. */
export function preflightSource(result: SceneEditPreflightResult): SceneSourceRef | null {
  return result.status === 'valid' ? result.basis.source : null
}
