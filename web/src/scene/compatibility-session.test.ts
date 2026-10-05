import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SceneCompatibilityDraftView,
  SceneCompatibilityRequestResponse,
  SceneInspectionResult,
  SceneValidationBasis,
} from '@possibility/voxel-contract'
import {
  COMPATIBILITY_STORE_KEY,
  createCompatibilityStore,
  type CompatibilityStorage,
} from './compatibility-store'
import { createCompatibilitySession, type CompatibilitySessionClient } from './compatibility-session'

function memoryStorage(): CompatibilityStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  }
}

const scope = { actorKey: 'actor-1', worldId: 'world-1' }
const basis = { source: { worldId: scope.worldId, version: 3, contentHash: 'source-hash' } } as SceneValidationBasis
const inspection = {
  status: 'ready',
  source: basis.source,
  basis,
  report: { status: 'valid', issues: [], issueCount: 0, countIsExact: true, stopReason: null, checkedSpaceIds: [], pendingSpaceIds: [], workUnitsUsed: 1, elapsedMs: 1, ruleNotes: { items: [], total: 0, hasMore: false } },
  canCreateRepairDraft: true,
} satisfies SceneInspectionResult

function draft(): SceneCompatibilityDraftView {
  return {
    id: 'draft-1', worldId: scope.worldId, purpose: 'repair-current', target: { kind: 'current' }, basis,
    status: 'ready', previewSpaces: [{ spaceId: 'main', name: 'Main' }], canConfirm: true,
    changes: { items: [], offset: 0, limit: 0, total: 0, hasMore: false }, report: null,
    createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
  }
}

function client(overrides: Partial<CompatibilitySessionClient> = {}): CompatibilitySessionClient {
  return {
    inspect: vi.fn(async () => inspection),
    createDraft: vi.fn(async () => draft()),
    submit: vi.fn(async () => ({
      status: 'completed', attempt: 1,
      result: { worldId: scope.worldId, version: 4, contentHash: 'result-hash', requestId: 'request-1', outcome: 'repaired-current', source: basis.source, rulesVersion: 'rules-1' },
    } satisfies SceneCompatibilityRequestResponse)),
    query: vi.fn(async (): Promise<SceneCompatibilityRequestResponse> => ({ status: 'missing', retryAllowed: false })),
    recover: vi.fn(async (): Promise<SceneCompatibilityRequestResponse> => ({ status: 'missing', retryAllowed: false })),
    ...overrides,
  }
}

describe('compatibility session', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('continues checking, building, previewing, and completing without storing a candidate', async () => {
    const storage = memoryStorage()
    const session = createCompatibilitySession({ scope, client: client(), store: createCompatibilityStore({ storage }), requestId: () => 'request-1' })
    await session.check({ purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 3 })
    expect(session.snapshot().state).toBe('diagnosed')
    await session.build()
    expect(session.snapshot().state).toBe('preview')
    await session.submit()
    expect(session.snapshot().state).toBe('completed')
    expect(session.snapshot()).not.toHaveProperty('candidate')
    expect(storage.values.get(COMPATIBILITY_STORE_KEY)).not.toContain('candidate')
  })

  it('returns to preview for a retryable not-committed response', async () => {
    const response: SceneCompatibilityRequestResponse = { status: 'not-committed', attempt: 1, nextAttempt: 2, retryAllowed: true }
    const session = createCompatibilitySession({ scope, client: client({ submit: vi.fn(async () => response) }), requestId: () => 'request-1' })
    await session.check({ purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 3 })
    await session.build()
    await session.submit()
    expect(session.snapshot().state).toBe('preview')
    expect(session.snapshot().message).toContain('重试')
  })

  it('marks version and basis failures as conflict', async () => {
    const response: SceneCompatibilityRequestResponse = {
      status: 'not-committed', attempt: 1, retryAllowed: false,
      error: { code: 'scene-changed', message: 'Scene changed', action: 'recheck' },
    }
    const session = createCompatibilitySession({ scope, client: client({ submit: vi.fn(async () => response) }), requestId: () => 'request-1' })
    await session.check({ purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 3 })
    await session.build()
    await session.submit()
    expect(session.snapshot().state).toBe('conflict')
    expect(session.snapshot().failure?.code).toBe('scene-changed')
  })

  it('persists a recoverable snapshot that another session can resume', async () => {
    const storage = memoryStorage()
    const store = createCompatibilityStore({ storage })
    const first = createCompatibilitySession({ scope, client: client(), store, requestId: () => 'request-1' })
    await first.check({ purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 3 })
    await first.build()
    const resumed = createCompatibilitySession({ scope, client: client(), store })
    expect(resumed.snapshot().state).toBe('preview')
    expect(resumed.snapshot().draftId).toBe('draft-1')
  })

  it('resolves a submitting session to completed via queryResult with the real receipt', async () => {
    const pending: SceneCompatibilityRequestResponse = { status: 'submitting', attempt: 1, retryAllowed: false }
    const completed: SceneCompatibilityRequestResponse = {
      status: 'completed', attempt: 1,
      result: { worldId: scope.worldId, version: 4, contentHash: 'result-hash', requestId: 'request-1', outcome: 'repaired-current', source: basis.source, rulesVersion: 'rules-1' },
    }
    const stub = client({ submit: vi.fn(async () => pending), query: vi.fn(async () => completed) })
    const session = createCompatibilitySession({ scope, client: stub, requestId: () => 'request-1' })
    await session.check({ purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 3 })
    await session.build()
    await session.submit()
    expect(session.snapshot().state).toBe('submitting')
    await session.queryResult()
    expect(session.snapshot().state).toBe('completed')
    expect(session.snapshot().receipt?.requestId).toBe('request-1')
    expect(stub.query).toHaveBeenCalledWith({ worldId: scope.worldId, requestId: 'request-1' })
  })

  it('stays submitting when queryResult reports the submit is still processing', async () => {
    const pending: SceneCompatibilityRequestResponse = { status: 'submitting', attempt: 1, retryAllowed: false }
    const stub = client({ submit: vi.fn(async () => pending), query: vi.fn(async () => pending) })
    const session = createCompatibilitySession({ scope, client: stub, requestId: () => 'request-1' })
    await session.check({ purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 3 })
    await session.build()
    await session.submit()
    await session.queryResult()
    expect(session.snapshot().state).toBe('submitting')
    expect(session.snapshot().message).toBe('提交仍在处理中。')
    await expect(session.submit()).rejects.toThrow()
    expect(stub.submit).toHaveBeenCalledTimes(1)
  })

  it('returns to preview with the server named nextAttempt and resubmits with it', async () => {
    const storage = memoryStorage()
    const store = createCompatibilityStore({ storage })
    const pending: SceneCompatibilityRequestResponse = { status: 'submitting', attempt: 1, retryAllowed: false }
    const retryable: SceneCompatibilityRequestResponse = { status: 'not-committed', attempt: 1, nextAttempt: 2, retryAllowed: true }
    const submit = vi.fn(async () => pending)
    const stub = client({ submit, query: vi.fn(async () => retryable) })
    const session = createCompatibilitySession({ scope, client: stub, store, requestId: () => 'request-1' })
    await session.check({ purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 3 })
    await session.build()
    await session.submit()
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ expectedAttempt: 0 }))
    await session.queryResult()
    expect(session.snapshot().state).toBe('preview')
    expect(session.snapshot().nextAttempt).toBe(2)
    expect(store.load(scope)?.nextAttempt).toBe(2)
    await session.submit()
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ expectedAttempt: 2, requestId: 'request-1' }))
  })

  it('moves to unknown when queryResult finds no recoverable record', async () => {
    const pending: SceneCompatibilityRequestResponse = { status: 'submitting', attempt: 1, retryAllowed: false }
    const missing: SceneCompatibilityRequestResponse = { status: 'missing', retryAllowed: false }
    const stub = client({ submit: vi.fn(async () => pending), query: vi.fn(async () => missing) })
    const session = createCompatibilitySession({ scope, client: stub, requestId: () => 'request-1' })
    await session.check({ purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 3 })
    await session.build()
    await session.submit()
    await session.queryResult()
    expect(session.snapshot().state).toBe('unknown')
    expect(session.snapshot().message).toContain('没有')
  })

  it('never resubmits automatically when queryResult fails', async () => {
    const pending: SceneCompatibilityRequestResponse = { status: 'submitting', attempt: 1, retryAllowed: false }
    const submit = vi.fn(async () => pending)
    const query = vi.fn(async () => { throw new Error('network down') })
    const stub = client({ submit, query })
    const session = createCompatibilitySession({ scope, client: stub, requestId: () => 'request-1' })
    await session.check({ purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 3 })
    await session.build()
    await session.submit()
    await expect(session.queryResult()).rejects.toThrow('network down')
    expect(session.snapshot().state).toBe('unknown')
    expect(query).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledTimes(1)
    await expect(session.queryResult()).rejects.toThrow('network down')
    expect(query).toHaveBeenCalledTimes(2)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('sends only one submit for a double click', async () => {
    const submit = vi.fn(async (): Promise<SceneCompatibilityRequestResponse> => ({
      status: 'completed', attempt: 1,
      result: { worldId: scope.worldId, version: 4, contentHash: 'result-hash', requestId: 'request-1', outcome: 'repaired-current', source: basis.source, rulesVersion: 'rules-1' },
    }))
    const session = createCompatibilitySession({ scope, client: client({ submit }), requestId: () => 'request-1' })
    await session.check({ purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 3 })
    await session.build()
    const first = session.submit()
    await expect(session.submit()).rejects.toThrow()
    await first
    expect(submit).toHaveBeenCalledTimes(1)
    expect(session.snapshot().state).toBe('completed')
  })

  it('allocates a fresh draft request after a conflict recheck', async () => {
    const ids = ['request-1', 'request-2']
    const inspect = vi.fn(async () => inspection)
    const createDraft = vi.fn(async () => draft())
    const session = createCompatibilitySession({
      scope,
      client: client({
        inspect,
        createDraft,
        submit: vi.fn(async (): Promise<SceneCompatibilityRequestResponse> => ({
          status: 'not-committed',
          attempt: 1,
          retryAllowed: false,
          error: { code: 'scene-changed', message: 'Scene changed', action: 'recheck' },
        })),
      }),
      requestId: () => ids.shift() ?? 'request-extra',
    })
    await session.check({ purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 3 })
    await session.build()
    await session.submit()
    expect(session.snapshot().state).toBe('conflict')
    await session.check({ purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 4 })
    await session.build()
    expect(createDraft).toHaveBeenLastCalledWith(expect.objectContaining({ draftRequestId: 'request-2' }))
  })
})
