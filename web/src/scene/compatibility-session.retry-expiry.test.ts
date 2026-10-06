import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SceneCompatibilityDraftView,
  SceneCompatibilityRequestResponse,
  SceneInspectionResult,
  SceneValidationBasis,
} from '@possibility/voxel-contract'
import { createCompatibilitySession, type CompatibilitySessionClient } from './compatibility-session'

const scope = { actorKey: 'retry-actor', worldId: 'retry-world' }
const source = { worldId: scope.worldId, version: 3, contentHash: 'source-v3' }
const basis = { source } as SceneValidationBasis
const target = { kind: 'history', version: 2 } as const
const inspection = {
  status: 'ready', source, basis,
  report: {
    status: 'valid', issues: [], issueCount: 0, countIsExact: true, stopReason: null,
    checkedSpaceIds: ['main'], pendingSpaceIds: [], workUnitsUsed: 1, elapsedMs: 1,
    ruleNotes: { items: [], total: 0, hasMore: false },
  },
  canCreateRepairDraft: true,
} satisfies SceneInspectionResult

function inspectionAt(version: number): SceneInspectionResult {
  const nextSource = { ...source, version, contentHash: `source-v${version}` }
  return { ...inspection, source: nextSource, basis: { ...basis, source: nextSource } }
}

function draft(id: string): SceneCompatibilityDraftView {
  return {
    id, worldId: scope.worldId, purpose: 'restore-history', target, basis,
    status: 'ready', previewSpaces: [{ spaceId: 'main', name: 'Main' }], canConfirm: true,
    changes: { items: [], offset: 0, limit: 0, total: 0, hasMore: false }, report: null,
    createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z',
  }
}

function client(overrides: Partial<CompatibilitySessionClient> = {}): CompatibilitySessionClient {
  return {
    inspect: vi.fn(async () => inspection),
    createDraft: vi.fn(async () => draft('draft-1')),
    submit: vi.fn(async (): Promise<SceneCompatibilityRequestResponse> => ({
      status: 'not-committed', attempt: 0, retryAllowed: false,
      error: { code: 'basis-changed', message: 'Rules or permissions changed; recheck preview.', action: 'recheck' },
    })),
    query: vi.fn(async (): Promise<SceneCompatibilityRequestResponse> => ({ status: 'missing', retryAllowed: false })),
    recover: vi.fn(async (): Promise<SceneCompatibilityRequestResponse> => ({ status: 'missing', retryAllowed: false })),
    ...overrides,
  }
}

describe('A8.6 conflict re-preview input retention', () => {
  afterEach(() => vi.restoreAllMocks())

  it('retains the chosen restore target on conflict and requires a fresh preview with a new request id', async () => {
    const ids = ['request-1', 'request-2']
    const inspect = vi.fn(async (input: Parameters<CompatibilitySessionClient['inspect']>[0]): Promise<SceneInspectionResult> =>
      inspectionAt(input.expectedCurrentVersion))
    const createDraft = vi.fn(async (input: Parameters<CompatibilitySessionClient['createDraft']>[0]) =>
      draft(input.draftRequestId === 'request-1' ? 'draft-1' : 'draft-2'))
    const submit = vi.fn(async (): Promise<SceneCompatibilityRequestResponse> => ({
      status: 'not-committed', attempt: 0, retryAllowed: false,
      error: { code: 'basis-changed', message: 'Rules or permissions changed; recheck preview.', action: 'recheck' },
    }))
    const stub = client({ inspect, createDraft, submit })
    const session = createCompatibilitySession({ scope, client: stub, requestId: () => ids.shift() ?? 'unexpected-request' })

    await session.check({ purpose: 'restore-history', target, expectedCurrentVersion: 3 })
    await session.build()
    await session.submit()
    expect(session.snapshot()).toMatchObject({
      state: 'conflict', requestId: 'request-1', draftId: 'draft-1',
      purpose: 'restore-history', target, expectedCurrentVersion: 3,
      failure: { code: 'basis-changed' },
    })
    expect(submit).toHaveBeenCalledTimes(1)

    // A conflict does not silently resubmit. The user explicitly checks again using the same chosen target.
    await session.check({ purpose: 'restore-history', target, expectedCurrentVersion: 4 })
    expect(session.snapshot()).toMatchObject({
      state: 'diagnosed', requestId: 'request-2', draftId: null,
      purpose: 'restore-history', target, expectedCurrentVersion: 4,
    })
    await session.build()

    expect(inspect).toHaveBeenLastCalledWith({
      worldId: scope.worldId, purpose: 'restore-history', target, expectedCurrentVersion: 4,
    })
    expect(createDraft).toHaveBeenLastCalledWith({
      draftRequestId: 'request-2', worldId: scope.worldId, purpose: 'restore-history', target, expectedCurrentVersion: 4,
    })
    expect(session.snapshot()).toMatchObject({ state: 'preview', requestId: 'request-2', draftId: 'draft-2', target })
    expect(submit).toHaveBeenCalledTimes(1)
  })
})
