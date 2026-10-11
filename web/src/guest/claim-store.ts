import { clearGuestToken, getGuestToken, isGuestClaimPending, setGuestClaimPending } from '../api/client'

export const GUEST_CLAIM_CONTEXT_KEY = 'possibility_guest_claim_context:v1'
export const GUEST_CLAIM_REQUEST_KEY = 'possibility_guest_claim_request_id'

export type GuestClaimPhase =
  | 'needs-auth' | 'checking' | 'confirm-account' | 'saving' | 'unknown'
  | 'retryable' | 'conflict' | 'unavailable' | 'storage-error' | 'completed'

export interface ClaimSourceBinding {
  sessionId: string
  worldId: string
  generation: number
}

export interface GuestClaimContext {
  version: 1
  source: ClaimSourceBinding & { credentialFingerprint: string }
  requestId: string
  target: { userId: string; username: string } | null
  confirmationRequired: boolean
  submitted: boolean
  expectedEpoch: number
  observedExecutionId: string | null
  phase: GuestClaimPhase
  receipt: { worldId: string; targetUserId: string } | null
}

export type GuestClaimStoreRead =
  | { kind: 'ready'; context: GuestClaimContext }
  | { kind: 'empty' }
  | { kind: 'corrupt' | 'storage-unavailable' }

export interface GuestClaimStore {
  read(): GuestClaimStoreRead
  write(context: GuestClaimContext): { ok: boolean }
  completeConfirmedClaim(
    expected: { guestToken: string; requestId: string; targetUserId: string },
    receipt: { worldId: string; targetUserId: string },
  ): { ok: boolean }
}

export interface GuestClaimStoreOptions {
  storage?: Storage
  getToken?: () => string | null
  clearToken?: () => void
}

/** A stable, non-secret marker used only to keep an intent tied to its source copy. */
export function credentialFingerprint(token: string | null): string {
  if (!token) return ''
  let hash = 2166136261
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `v1-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function defaultStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

function isBinding(value: unknown): value is ClaimSourceBinding {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ClaimSourceBinding>
  return typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0
    && typeof candidate.worldId === 'string' && candidate.worldId.length > 0
    && Number.isInteger(candidate.generation) && (candidate.generation ?? -1) >= 0
}

function parseContext(value: string): GuestClaimContext | null {
  try {
    const raw = JSON.parse(value) as Partial<GuestClaimContext>
    if (raw.version !== 1 || !isBinding(raw.source) || typeof raw.source.credentialFingerprint !== 'string') return null
    if (typeof raw.requestId !== 'string' || !raw.requestId || typeof raw.submitted !== 'boolean') return null
    if (!raw.target || typeof raw.target !== 'object' || typeof raw.target.userId !== 'string' || typeof raw.target.username !== 'string') {
      if (raw.target !== null) return null
    }
    if (!Number.isInteger(raw.expectedEpoch) || (raw.expectedEpoch ?? -1) < 0) return null
    const phases: GuestClaimPhase[] = ['needs-auth', 'checking', 'confirm-account', 'saving', 'unknown', 'retryable', 'conflict', 'unavailable', 'storage-error', 'completed']
    if (!phases.includes(raw.phase as GuestClaimPhase)) return null
    if (raw.observedExecutionId !== null && typeof raw.observedExecutionId !== 'string') return null
    if (raw.receipt !== null && (!raw.receipt || typeof raw.receipt.worldId !== 'string' || typeof raw.receipt.targetUserId !== 'string')) return null
    return raw as GuestClaimContext
  } catch {
    return null
  }
}

export function createInitialGuestClaimContext(
  source: ClaimSourceBinding,
  options: { requestId?: string; confirmationRequired?: boolean; guestToken?: string | null } = {},
): GuestClaimContext {
  return {
    version: 1,
    source: { ...source, credentialFingerprint: credentialFingerprint(options.guestToken ?? getGuestToken()) },
    requestId: options.requestId ?? crypto.randomUUID(),
    target: null,
    confirmationRequired: options.confirmationRequired ?? false,
    submitted: false,
    expectedEpoch: 0,
    observedExecutionId: null,
    phase: 'needs-auth',
    receipt: null,
  }
}

export function createGuestClaimStore(options: GuestClaimStoreOptions = {}): GuestClaimStore {
  const storage = options.storage ?? defaultStorage()
  const readToken = options.getToken ?? getGuestToken
  const removeToken = options.clearToken ?? clearGuestToken

  function read(): GuestClaimStoreRead {
    if (!storage) return { kind: 'storage-unavailable' }
    let raw: string | null
    try { raw = storage.getItem(GUEST_CLAIM_CONTEXT_KEY) } catch { return { kind: 'storage-unavailable' } }
    if (raw) {
      const parsed = parseContext(raw)
      return parsed ? { kind: 'ready', context: parsed } : { kind: 'corrupt' }
    }
    // Keep legacy request identity and pending state visible to the new flow. The source
    // binding is completed by the demo session response before a claim can be sent.
    try {
      const legacyRequest = storage.getItem(GUEST_CLAIM_REQUEST_KEY)
      if (legacyRequest || storage.getItem('possibility_guest_claim_pending') === '1' || isGuestClaimPending()) {
        return { kind: 'corrupt' }
      }
    } catch { return { kind: 'storage-unavailable' } }
    return { kind: 'empty' }
  }

  function write(context: GuestClaimContext): { ok: boolean } {
    if (!storage) return { ok: false }
    try {
      storage.setItem(GUEST_CLAIM_CONTEXT_KEY, JSON.stringify(context))
      storage.setItem(GUEST_CLAIM_REQUEST_KEY, context.requestId)
      if (context.submitted) {
        try { storage.setItem('possibility_guest_claim_pending', '1'); setGuestClaimPending(true) } catch { /* storage.setItem above already succeeded */ }
      }
      return { ok: true }
    } catch {
      return { ok: false }
    }
  }

  function completeConfirmedClaim(
    expected: { guestToken: string; requestId: string; targetUserId: string },
    receipt: { worldId: string; targetUserId: string },
  ): { ok: boolean } {
    if (!storage) return { ok: false }
    let context: GuestClaimContext | null = null
    try {
      const raw = storage.getItem(GUEST_CLAIM_CONTEXT_KEY)
      context = raw ? parseContext(raw) : null
      if (!context || context.requestId !== expected.requestId || context.target?.userId !== expected.targetUserId
        || context.source.credentialFingerprint !== credentialFingerprint(expected.guestToken)) return { ok: false }
      // The receipt is durable before any old credentials or intent markers are removed.
      storage.setItem(GUEST_CLAIM_CONTEXT_KEY, JSON.stringify({ ...context, phase: 'completed', receipt }))
      storage.removeItem(GUEST_CLAIM_CONTEXT_KEY)
      storage.removeItem(GUEST_CLAIM_REQUEST_KEY)
      try { storage.removeItem('possibility_guest_claim_pending') } catch { /* best effort */ }
      try { setGuestClaimPending(false) } catch { /* custom storage may not expose window.localStorage */ }
      if (readToken() === expected.guestToken) removeToken()
      return { ok: true }
    } catch {
      return { ok: false }
    }
  }

  return { read, write, completeConfirmedClaim }
}

export const guestClaimStore = createGuestClaimStore()
