import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyEdits, createEmptyWorld, serialize } from '@possibility/voxel-contract'
import type {
  SceneRepairAudit,
  SceneValidationBasis,
  SceneValidationReport,
  SerializedVoxelDocument,
} from '@possibility/voxel-contract'
import {
  cancelSceneCompatibilityDraft,
  claimSceneCompatibilityDraftBuild,
  claimSceneCompatibilityRequest,
  completeSceneCompatibilityRequest,
  createSceneCompatibilityDraft,
  failSceneCompatibilityRequest,
  fingerprintSceneCompatibilityDraft,
  publishSceneCompatibilityDraft,
  readSceneCompatibilityRequest,
  recoverSceneCompatibilityRequest,
  SceneCompatibilityLeaseLost,
  SceneCompatibilityRepositoryCorruption,
  SceneCompatibilityRepositoryError,
  SceneCompatibilityRequestMismatch,
  toSceneCompatibilityDraftView,
  toSceneCompatibilityRequestView,
} from './repository'
import { commitScene } from '../repository'
import { createTestDb } from '../../test/db'
import {
  sceneCompatibilityDrafts,
  sceneCompatibilityRequests,
  users,
  worldSceneRevisions,
  worlds,
} from '../../db/schema'

const T0 = new Date('2026-02-01T00:00:00.000Z')
const T0_ISO = T0.toISOString()
const WORLD = 'w1'
const ACTOR = 'actor-1'

function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000)
}

type Fixture = ReturnType<typeof createTestDb>

/** 合法体素信封:平地 + 可选摆放 op(与 routes.test.ts 同一构造) */
function voxelEnvelope(...ops: Parameters<typeof applyEdits>[1]): SerializedVoxelDocument {
  const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'compat-repo')
  const doc = applyEdits(base, [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
    ...ops,
  ]).document
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

function makeBasis(overrides: Partial<SceneValidationBasis> = {}): SceneValidationBasis {
  return {
    expectedCurrentVersion: 1,
    currentContentHash: 'hash-current-v1',
    source: { worldId: WORLD, version: 1, contentHash: 'hash-current-v1' },
    candidateHash: null,
    rulesVersion: 'rules-1',
    assetManifestHash: 'assets-1',
    templateCatalogHash: 'templates-1',
    bindingHash: 'bindings-1',
    contextFingerprint: 'context-1',
    baseline: null,
    ...overrides,
  }
}

function validReport(): SceneValidationReport {
  return {
    status: 'valid',
    issues: [],
    issueCount: 0,
    countIsExact: true,
    stopReason: null,
    checkedSpaceIds: ['single'],
    pendingSpaceIds: [],
    workUnitsUsed: 10,
    elapsedMs: 5,
    ruleNotes: { items: [], total: 0, hasMore: false },
  }
}

function makeDraftInput(overrides: Record<string, unknown> = {}) {
  return {
    actorKey: ACTOR,
    worldId: WORLD,
    draftRequestId: 'draft-req-1',
    purpose: 'repair-current' as const,
    target: { kind: 'current' as const },
    expectedCurrentVersion: 1,
    basis: makeBasis(),
    now: T0,
    ...overrides,
  }
}

/** auditFor 的 service.ts 形状:{ purpose, source, basis, changes, draftId, requestId } */
function auditFor(draft: { purpose: SceneRepairAudit['purpose']; basis: SceneValidationBasis; changes: SceneRepairAudit['changes']; id: string }, requestId: string): SceneRepairAudit {
  return { purpose: draft.purpose, source: draft.basis.source, basis: draft.basis, changes: draft.changes, draftId: draft.id, requestId }
}

async function seedWorld(fixture: Fixture): Promise<void> {
  await fixture.db.insert(users).values({ id: 'u1', username: 'u1', passwordHash: 'unused', createdAt: T0_ISO })
  await fixture.db.insert(worlds).values({ id: WORLD, userId: 'u1', name: 'Compat world', description: 'repo tests' })
}

/** 建一个 ready 草稿:create → claim build → publish ready(有效候选+有效报告) */
async function createReadyDraft(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  const input = makeDraftInput(overrides)
  const draft = await createSceneCompatibilityDraft(fixture.db, input)
  const inputFingerprint = await fingerprintSceneCompatibilityDraft(input)
  const claim = await claimSceneCompatibilityDraftBuild(fixture.db, {
    worldId: WORLD, draftId: draft.id, actorKey: input.actorKey, inputFingerprint, now: T0,
  })
  expect(claim.claimed).toBe(true)
  const published = await publishSceneCompatibilityDraft(fixture.db, {
    worldId: WORLD,
    draftId: draft.id,
    actorKey: input.actorKey,
    buildLeaseToken: claim.buildLeaseToken!,
    buildAttempt: claim.buildAttempt,
    status: 'ready',
    candidate: voxelEnvelope(),
    changes: [],
    report: validReport(),
    now: at(2),
  })
  expect(published.status).toBe('ready')
  return { draft: published, input }
}

function claimInput(draftId: string, overrides: Record<string, unknown> = {}) {
  return {
    worldId: WORLD,
    draftId,
    requestId: 'req-1',
    expectedCurrentVersion: 1,
    expectedAttempt: 0,
    actorKey: ACTOR,
    now: T0,
    ...overrides,
  }
}

async function revisionCount(fixture: Fixture): Promise<number> {
  const rows = await fixture.db.select({ id: worldSceneRevisions.id }).from(worldSceneRevisions)
    .where(eq(worldSceneRevisions.worldId, WORLD)).all()
  return rows.length
}

/** 递归收集 JSON 序列化后的全部键名 */
function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into)
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      into.add(key)
      collectKeys(item, into)
    }
  }
  return into
}

describe('scene compatibility repository', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = createTestDb()
    await seedWorld(fixture)
  })

  afterEach(() => {
    fixture.close()
  })

  describe('draft idempotency', () => {
    it('returns the same draft for identical identity and input fingerprint without inserting a second row', async () => {
      const input = makeDraftInput()
      const first = await createSceneCompatibilityDraft(fixture.db, input)
      const second = await createSceneCompatibilityDraft(fixture.db, { ...input, now: at(10) })
      expect(second.id).toBe(first.id)
      expect(second.status).toBe('building')
      const rows = await fixture.db.select().from(sceneCompatibilityDrafts).all()
      expect(rows).toHaveLength(1)
    })

    it('rejects the same draftRequestId carrying a different input fingerprint', async () => {
      await createSceneCompatibilityDraft(fixture.db, makeDraftInput())
      await expect(createSceneCompatibilityDraft(fixture.db, makeDraftInput({ expectedCurrentVersion: 2 })))
        .rejects.toBeInstanceOf(SceneCompatibilityRequestMismatch)
      await expect(createSceneCompatibilityDraft(fixture.db, makeDraftInput({ basis: makeBasis({ rulesVersion: 'rules-2' }) })))
        .rejects.toBeInstanceOf(SceneCompatibilityRequestMismatch)
      const rows = await fixture.db.select().from(sceneCompatibilityDrafts).all()
      expect(rows).toHaveLength(1)
    })

    it('rejects purpose/target mismatches before touching storage', async () => {
      await expect(createSceneCompatibilityDraft(fixture.db, makeDraftInput({ target: { kind: 'history', version: 1 } })))
        .rejects.toBeInstanceOf(SceneCompatibilityRepositoryError)
      await expect(createSceneCompatibilityDraft(fixture.db, makeDraftInput({
        purpose: 'restore-history', target: { kind: 'current' },
      }))).rejects.toBeInstanceOf(SceneCompatibilityRepositoryError)
    })
  })

  describe('draft build lease', () => {
    it('grants one fixed lease per window and fences attempts monotonically', async () => {
      const input = makeDraftInput()
      const draft = await createSceneCompatibilityDraft(fixture.db, input)
      const inputFingerprint = await fingerprintSceneCompatibilityDraft(input)
      const claimAt = (now: Date) => claimSceneCompatibilityDraftBuild(fixture.db, {
        worldId: WORLD, draftId: draft.id, actorKey: ACTOR, inputFingerprint, now,
      })

      const first = await claimAt(T0)
      expect(first.claimed).toBe(true)
      expect(first.buildAttempt).toBe(1)
      expect(first.buildLeaseToken).toBeTruthy()

      const tooSoon = await claimAt(at(1))
      expect(tooSoon.claimed).toBe(false)
      expect(tooSoon.buildLeaseToken).toBeNull()
      expect(tooSoon.buildAttempt).toBe(1)

      const afterExpiry = await claimAt(at(31))
      expect(afterExpiry.claimed).toBe(true)
      expect(afterExpiry.buildAttempt).toBe(2)
      expect(afterExpiry.buildLeaseToken).toBeTruthy()
      expect(afterExpiry.buildLeaseToken).not.toBe(first.buildLeaseToken)
    })

    it('refuses to publish once the fixed lease has expired', async () => {
      const input = makeDraftInput()
      const draft = await createSceneCompatibilityDraft(fixture.db, input)
      const inputFingerprint = await fingerprintSceneCompatibilityDraft(input)
      const claim = await claimSceneCompatibilityDraftBuild(fixture.db, {
        worldId: WORLD, draftId: draft.id, actorKey: ACTOR, inputFingerprint, now: T0,
      })
      await expect(publishSceneCompatibilityDraft(fixture.db, {
        worldId: WORLD,
        draftId: draft.id,
        actorKey: ACTOR,
        buildLeaseToken: claim.buildLeaseToken!,
        buildAttempt: claim.buildAttempt,
        status: 'ready',
        candidate: voxelEnvelope(),
        changes: [],
        report: validReport(),
        now: at(31),
      })).rejects.toBeInstanceOf(SceneCompatibilityLeaseLost)
    })
  })

  describe('stale build publication', () => {
    it('rejects publishing with a stale (buildLeaseToken, buildAttempt) after a re-claim', async () => {
      const input = makeDraftInput()
      const draft = await createSceneCompatibilityDraft(fixture.db, input)
      const inputFingerprint = await fingerprintSceneCompatibilityDraft(input)
      const claimAt = (now: Date) => claimSceneCompatibilityDraftBuild(fixture.db, {
        worldId: WORLD, draftId: draft.id, actorKey: ACTOR, inputFingerprint, now,
      })
      const stale = await claimAt(T0)
      const fresh = await claimAt(at(31))
      expect(fresh.claimed).toBe(true)

      await expect(publishSceneCompatibilityDraft(fixture.db, {
        worldId: WORLD,
        draftId: draft.id,
        actorKey: ACTOR,
        buildLeaseToken: stale.buildLeaseToken!,
        buildAttempt: stale.buildAttempt,
        status: 'blocked',
        changes: [],
        report: validReport(),
        now: at(32),
      })).rejects.toBeInstanceOf(SceneCompatibilityLeaseLost)

      const published = await publishSceneCompatibilityDraft(fixture.db, {
        worldId: WORLD,
        draftId: draft.id,
        actorKey: ACTOR,
        buildLeaseToken: fresh.buildLeaseToken!,
        buildAttempt: fresh.buildAttempt,
        status: 'ready',
        candidate: voxelEnvelope(),
        changes: [],
        report: validReport(),
        now: at(32),
      })
      expect(published.status).toBe('ready')

      // 已离开 building 状态的草稿不再发放构建租约
      const afterPublish = await claimAt(at(33))
      expect(afterPublish.claimed).toBe(false)
      expect(afterPublish.draft.status).toBe('ready')
    })

    it('rejects every publish after the draft is cancelled', async () => {
      const input = makeDraftInput()
      const draft = await createSceneCompatibilityDraft(fixture.db, input)
      const inputFingerprint = await fingerprintSceneCompatibilityDraft(input)
      const claim = await claimSceneCompatibilityDraftBuild(fixture.db, {
        worldId: WORLD, draftId: draft.id, actorKey: ACTOR, inputFingerprint, now: T0,
      })
      const cancelled = await cancelSceneCompatibilityDraft(fixture.db, WORLD, draft.id, ACTOR, at(1))
      expect(cancelled?.status).toBe('cancelled')
      await expect(publishSceneCompatibilityDraft(fixture.db, {
        worldId: WORLD,
        draftId: draft.id,
        actorKey: ACTOR,
        buildLeaseToken: claim.buildLeaseToken!,
        buildAttempt: claim.buildAttempt,
        status: 'blocked',
        changes: [],
        report: validReport(),
        now: at(2),
      })).rejects.toBeInstanceOf(SceneCompatibilityLeaseLost)
    })

    it('rejects publishing status ready without a complete valid candidate and report', async () => {
      const input = makeDraftInput()
      const draft = await createSceneCompatibilityDraft(fixture.db, input)
      const inputFingerprint = await fingerprintSceneCompatibilityDraft(input)
      const claim = await claimSceneCompatibilityDraftBuild(fixture.db, {
        worldId: WORLD, draftId: draft.id, actorKey: ACTOR, inputFingerprint, now: T0,
      })
      const publish = (overrides: Record<string, unknown>) => publishSceneCompatibilityDraft(fixture.db, {
        worldId: WORLD,
        draftId: draft.id,
        actorKey: ACTOR,
        buildLeaseToken: claim.buildLeaseToken!,
        buildAttempt: claim.buildAttempt,
        status: 'ready',
        changes: [],
        now: at(1),
        ...overrides,
      } as Parameters<typeof publishSceneCompatibilityDraft>[1])
      // 无候选
      await expect(publish({ candidate: null, report: validReport() }))
        .rejects.toBeInstanceOf(SceneCompatibilityRepositoryError)
      // 有候选但报告非 valid
      await expect(publish({ candidate: voxelEnvelope(), report: { ...validReport(), status: 'invalid' } }))
        .rejects.toBeInstanceOf(SceneCompatibilityRepositoryError)
      // 有候选但无报告
      await expect(publish({ candidate: voxelEnvelope(), report: null }))
        .rejects.toBeInstanceOf(SceneCompatibilityRepositoryError)
    })
  })

  describe('request attempt fencing', () => {
    it('requires expectedAttempt 0 for the first claim and rejects replays while the lease is valid', async () => {
      const { draft } = await createReadyDraft(fixture)
      await expect(claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { expectedAttempt: 1 })))
        .rejects.toBeInstanceOf(SceneCompatibilityRequestMismatch)

      const first = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id))
      expect(first.claimed).toBe(true)
      expect(first.attempt).toBe(0)
      expect(first.leaseToken).toBeTruthy()

      const replay = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { now: at(1) }))
      expect(replay.claimed).toBe(false)
      expect(replay.leaseToken).toBeNull()
      expect(replay.attempt).toBe(0)

      // 租约过期后不能直接重取,必须先恢复请求
      await expect(claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { now: at(31) })))
        .rejects.toBeInstanceOf(SceneCompatibilityLeaseLost)
    })

    it('grants retry only to the server-issued next attempt and never reuses an old attempt', async () => {
      const { draft } = await createReadyDraft(fixture)
      const first = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id))
      const failed = await failSceneCompatibilityRequest(fixture.db, {
        worldId: WORLD, requestId: 'req-1', actorKey: ACTOR,
        attempt: first.attempt, leaseToken: first.leaseToken!, failureCode: 'storage-failure', now: at(1),
      })
      expect(failed.state).toBe('not-committed')
      expect(failed.attempt).toBe(0)

      // attempt 0 已被用尽,不能复用
      await expect(claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { expectedAttempt: 0, now: at(2) })))
        .rejects.toBeInstanceOf(SceneCompatibilityRequestMismatch)
      // 跳号同样拒绝
      await expect(claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { expectedAttempt: 2, now: at(2) })))
        .rejects.toBeInstanceOf(SceneCompatibilityRequestMismatch)

      const retry = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { expectedAttempt: 1, now: at(2) }))
      expect(retry.claimed).toBe(true)
      expect(retry.attempt).toBe(1)

      await failSceneCompatibilityRequest(fixture.db, {
        worldId: WORLD, requestId: 'req-1', actorKey: ACTOR,
        attempt: retry.attempt, leaseToken: retry.leaseToken!, failureCode: 'scene-changed', now: at(3),
      })
      // 旧 attempt 永久不能复用
      await expect(claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { expectedAttempt: 1, now: at(4) })))
        .rejects.toBeInstanceOf(SceneCompatibilityRequestMismatch)
    })

    it('rejects a different actorKey or different draftId occupying the same request identity', async () => {
      const first = await createReadyDraft(fixture)
      await claimSceneCompatibilityRequest(fixture.db, claimInput(first.draft.id))

      // 另一 actor 用自己的 ready 草稿占用同一 requestId
      const other = await createReadyDraft(fixture, { actorKey: 'actor-2', draftRequestId: 'draft-req-2' })
      await expect(claimSceneCompatibilityRequest(fixture.db, claimInput(other.draft.id, { actorKey: 'actor-2', now: at(1) })))
        .rejects.toBeInstanceOf(SceneCompatibilityRequestMismatch)

      // 同一 actor 换草稿占用同一 requestId
      const second = await createReadyDraft(fixture, { draftRequestId: 'draft-req-3' })
      await expect(claimSceneCompatibilityRequest(fixture.db, claimInput(second.draft.id, { now: at(1) })))
        .rejects.toBeInstanceOf(SceneCompatibilityRequestMismatch)
    })
  })

  describe('unknown-result recovery', () => {
    it('returns submitting without granting a retry while the lease is still valid', async () => {
      const { draft } = await createReadyDraft(fixture)
      await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id))
      const before = await revisionCount(fixture)
      const view = await recoverSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { now: at(1) }))
      expect(view).toEqual({ status: 'submitting', attempt: 0, retryAllowed: false })
      expect(await revisionCount(fixture)).toBe(before)
    })

    it('fences an expired lease and reports not-committed with the next attempt when no revision landed', async () => {
      const { draft } = await createReadyDraft(fixture)
      await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id))
      const before = await revisionCount(fixture)
      const view = await recoverSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { expectedAttempt: 1, now: at(31) }))
      expect(view).toEqual({ status: 'not-committed', attempt: 0, nextAttempt: 1, retryAllowed: true })
      expect(await revisionCount(fixture)).toBe(before)

      const row = await fixture.db.select().from(sceneCompatibilityRequests)
        .where(eq(sceneCompatibilityRequests.requestId, 'req-1')).get()
      expect(row?.state).toBe('not-committed')
      expect(row?.leaseToken).toBeNull()

      // 恢复授予的 nextAttempt 可以立即重取执行权
      const retry = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { expectedAttempt: 1, now: at(32) }))
      expect(retry.claimed).toBe(true)
      expect(retry.attempt).toBe(1)
    })

    it('rebuilds a completed result when the request row is missing but a matching revision exists', async () => {
      const { draft } = await createReadyDraft(fixture)
      const audit = auditFor(draft, 'req-lost')
      const committed = await commitScene(fixture.db, {
        worldId: WORLD, expectedVersion: 0, requestId: 'req-lost',
        document: voxelEnvelope(), summary: 'compat seed', kind: 'compatibility-repair',
        compatibilityJson: JSON.stringify(audit),
      })
      const before = await revisionCount(fixture)
      const view = await recoverSceneCompatibilityRequest(fixture.db, claimInput(draft.id, {
        requestId: 'req-lost', expectedAttempt: 0, now: at(1),
      }))
      expect(view.status).toBe('completed')
      if (view.status !== 'completed') throw new Error('unreachable')
      expect(view.attempt).toBe(0)
      expect(view.result.version).toBe(committed.version)
      expect(view.result.contentHash).toBe(committed.contentHash)
      expect(view.result.outcome).toBe('repaired-current')
      expect(view.result.audit.requestId).toBe('req-lost')
      // recover 全程不新增修订
      expect(await revisionCount(fixture)).toBe(before)
    })

    it('creates a retired attempt-0 row and grants nextAttempt 1 when both row and revision are missing', async () => {
      const { draft } = await createReadyDraft(fixture)
      const before = await revisionCount(fixture)
      const view = await recoverSceneCompatibilityRequest(fixture.db, claimInput(draft.id, {
        requestId: 'req-never', expectedAttempt: 0, now: at(1),
      }))
      expect(view).toEqual({ status: 'not-committed', attempt: 0, nextAttempt: 1, retryAllowed: true })
      expect(await revisionCount(fixture)).toBe(before)

      const row = await fixture.db.select().from(sceneCompatibilityRequests)
        .where(eq(sceneCompatibilityRequests.requestId, 'req-never')).get()
      expect(row).toMatchObject({ attempt: 0, state: 'not-committed', leaseToken: null, resultVersion: null })
    })
  })

  describe('immutable revision result reconstruction', () => {
    async function runFullFlow() {
      await commitScene(fixture.db, {
        worldId: WORLD, expectedVersion: 0, requestId: 'seed-1',
        document: voxelEnvelope(), summary: 'seed', kind: 'initial',
      })
      const { draft } = await createReadyDraft(fixture)
      const claim = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { now: at(3) }))
      expect(claim.claimed).toBe(true)
      const audit = auditFor(draft, 'req-1')
      const committed = await commitScene(fixture.db, {
        worldId: WORLD, expectedVersion: 1, requestId: 'req-1',
        document: draft.candidate!, summary: 'compat confirm', kind: 'compatibility-repair',
        compatibilityJson: JSON.stringify(audit),
        compatibility: {
          draftId: draft.id, requestId: 'req-1', attempt: claim.attempt,
          leaseToken: claim.leaseToken!, leaseUntil: claim.request.leaseUntil!,
        },
      })
      const completed = await completeSceneCompatibilityRequest(fixture.db, {
        worldId: WORLD, requestId: 'req-1', actorKey: ACTOR,
        attempt: claim.attempt, leaseToken: claim.leaseToken!, resultVersion: committed.version, now: at(4),
      })
      expect(completed.state).toBe('completed')
      return { draft, committed }
    }

    it('rebuilds the completed result from the immutable scene revision', async () => {
      const { committed } = await runFullFlow()
      const view = await readSceneCompatibilityRequest(fixture.db, WORLD, 'req-1', ACTOR)
      expect(view.status).toBe('completed')
      if (view.status !== 'completed') throw new Error('unreachable')
      expect(view.attempt).toBe(0)
      expect(view.result.version).toBe(committed.version)
      expect(view.result.contentHash).toBe(committed.contentHash)
      expect(view.result.requestId).toBe('req-1')
      expect(view.result.outcome).toBe('repaired-current')
      expect(view.result.audit.draftId).toBeTruthy()
      expect(view.result.audit.requestId).toBe('req-1')
    })

    it('stays completed after the draft row is deleted', async () => {
      const { draft, committed } = await runFullFlow()
      // 请求行持有 draft_id 外键(ON DELETE no action),测试夹具临时放开 FK 以模拟草稿留存期到期被清除
      fixture.sqlite.exec('PRAGMA foreign_keys = OFF')
      await fixture.db.delete(sceneCompatibilityDrafts).where(eq(sceneCompatibilityDrafts.id, draft.id))
      fixture.sqlite.exec('PRAGMA foreign_keys = ON')
      const view = await readSceneCompatibilityRequest(fixture.db, WORLD, 'req-1', ACTOR)
      expect(view.status).toBe('completed')
      if (view.status !== 'completed') throw new Error('unreachable')
      expect(view.result.version).toBe(committed.version)
      expect(view.result.contentHash).toBe(committed.contentHash)
    })

    it('reports unknown when the request row is completed but the revision is missing', async () => {
      const { draft } = await createReadyDraft(fixture)
      const claim = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { now: at(1) }))
      await completeSceneCompatibilityRequest(fixture.db, {
        worldId: WORLD, requestId: 'req-1', actorKey: ACTOR,
        attempt: claim.attempt, leaseToken: claim.leaseToken!, resultVersion: 99, now: at(2),
      })
      const view = await readSceneCompatibilityRequest(fixture.db, WORLD, 'req-1', ACTOR)
      expect(view).toEqual({ status: 'unknown', retryAllowed: false })
    })
  })

  describe('public DTO redaction', () => {
    it('omits candidate, actor identity, lease and fingerprint fields from the draft view', async () => {
      const { draft } = await createReadyDraft(fixture)
      const view = toSceneCompatibilityDraftView(draft)
      const serialized = JSON.parse(JSON.stringify(view)) as Record<string, unknown>
      const keys = collectKeys(serialized)
      for (const forbidden of ['candidate', 'candidateJson', 'actorKey', 'draftRequestId', 'leaseToken', 'buildLease', 'buildLeaseToken', 'buildLeaseUntil', 'inputFingerprint', 'requestFingerprint']) {
        expect(keys.has(forbidden), `draft view leaks ${forbidden}`).toBe(false)
      }
      expect(serialized.id).toBe(draft.id)
      expect(serialized.status).toBe('ready')
      expect(serialized.canConfirm).toBe(true)
    })

    it('never leaks the lease token on a submitting request view', async () => {
      const { draft } = await createReadyDraft(fixture)
      const claim = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id))
      const view = toSceneCompatibilityRequestView(claim.request)
      expect(view).toEqual({ status: 'submitting', attempt: 0, retryAllowed: false })
      const keys = collectKeys(JSON.parse(JSON.stringify(view)))
      for (const forbidden of ['leaseToken', 'leaseUntil', 'actorKey', 'requestFingerprint', 'resultVersion', 'failureCode']) {
        expect(keys.has(forbidden), `request view leaks ${forbidden}`).toBe(false)
      }
    })

    it('refuses to serialize a completed request view that was not rebuilt from the revision', async () => {
      const { draft } = await createReadyDraft(fixture)
      const claim = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id))
      const completed = await completeSceneCompatibilityRequest(fixture.db, {
        worldId: WORLD, requestId: 'req-1', actorKey: ACTOR,
        attempt: claim.attempt, leaseToken: claim.leaseToken!, resultVersion: 1, now: at(1),
      })
      expect(() => toSceneCompatibilityRequestView(completed)).toThrow(SceneCompatibilityRepositoryCorruption)
    })

    it('renders a not-committed failure view without internal fields', async () => {
      const { draft } = await createReadyDraft(fixture)
      const claim = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id))
      const failed = await failSceneCompatibilityRequest(fixture.db, {
        worldId: WORLD, requestId: 'req-1', actorKey: ACTOR,
        attempt: claim.attempt, leaseToken: claim.leaseToken!, failureCode: 'scene-changed', now: at(1),
      })
      const view = toSceneCompatibilityRequestView(failed)
      expect(view.status).toBe('not-committed')
      if (view.status !== 'not-committed' || !('error' in view)) throw new Error('unreachable')
      expect(view.retryAllowed).toBe(false)
      expect(view.error.code).toBe('scene-changed')
      const keys = collectKeys(JSON.parse(JSON.stringify(view)))
      for (const forbidden of ['leaseToken', 'leaseUntil', 'actorKey', 'requestFingerprint']) {
        expect(keys.has(forbidden), `failure view leaks ${forbidden}`).toBe(false)
      }
    })
  })
})
