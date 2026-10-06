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
  cleanupExpiredSceneCompatibilityDrafts,
  COMPATIBILITY_MAX_ROW_BYTES,
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
import { commitScene, SceneConflict } from '../repository'
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

/** Mirrors the JSON object field order passed to the draft INSERT size guard. */
function serializedDraftInsertBytes(values: {
  id: string
  draftRequestId: string
  actorKey: string
  worldId: string
  purpose: string
  targetJson: string
  basisJson: string
  status: string
  candidateJson: string | null
  changesJson: string
  reportJson: string | null
  inputFingerprint: string
  buildLeaseToken: string | null
  buildLeaseUntil: string | null
  buildAttempt: number
  createdAt: string
  updatedAt: string
}): number {
  return new TextEncoder().encode(JSON.stringify(values)).byteLength
}

function serializedStoredDraftBytes(row: typeof sceneCompatibilityDrafts.$inferSelect): number {
  return serializedDraftInsertBytes({
    id: row.id,
    draftRequestId: row.draftRequestId,
    actorKey: row.actorKey,
    worldId: row.worldId,
    purpose: row.purpose,
    targetJson: row.targetJson,
    basisJson: row.basisJson,
    status: row.status,
    candidateJson: row.candidateJson,
    changesJson: row.changesJson,
    reportJson: row.reportJson,
    inputFingerprint: row.inputFingerprint,
    buildLeaseToken: row.buildLeaseToken,
    buildLeaseUntil: row.buildLeaseUntil,
    buildAttempt: row.buildAttempt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
}

function draftInputForSerializedSize(targetBytes: number, draftRequestId: string) {
  const initial = makeDraftInput({
    draftRequestId,
    basis: makeBasis({ contextFingerprint: '' }),
  })
  const makeInsertValues = (input: ReturnType<typeof makeDraftInput>) => ({
    // UUID length is fixed; the generated id has the same encoded length.
    id: 'x'.repeat(36),
    draftRequestId: input.draftRequestId,
    actorKey: input.actorKey,
    worldId: input.worldId,
    purpose: input.purpose,
    targetJson: JSON.stringify(input.target),
    basisJson: JSON.stringify(input.basis),
    status: 'building',
    candidateJson: null,
    changesJson: '[]',
    reportJson: null,
    // SHA-256 fingerprints always have this fixed ASCII length.
    inputFingerprint: `sha256:${'0'.repeat(64)}`,
    buildLeaseToken: null,
    buildLeaseUntil: null,
    buildAttempt: 0,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
  })
  const baseBytes = serializedDraftInsertBytes(makeInsertValues(initial))
  const paddingBytes = targetBytes - baseBytes
  if (paddingBytes < 0) throw new Error('Requested draft row size is smaller than its fixed fields')
  const input = makeDraftInput({
    draftRequestId,
    basis: makeBasis({ contextFingerprint: 'x'.repeat(paddingBytes) }),
  })
  if (serializedDraftInsertBytes(makeInsertValues(input)) !== targetBytes) {
    throw new Error('Unable to construct the requested serialized draft row size')
  }
  return input
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

  describe('serialized compatibility draft row size boundary', () => {
    it('accepts a real serialized draft row of exactly 1,900,000 bytes', async () => {
      const input = draftInputForSerializedSize(COMPATIBILITY_MAX_ROW_BYTES, 'draft-size-limit-fit')
      const created = await createSceneCompatibilityDraft(fixture.db, input)
      const row = await fixture.db.select().from(sceneCompatibilityDrafts)
        .where(eq(sceneCompatibilityDrafts.id, created.id)).get()

      expect(row).toBeTruthy()
      expect(serializedStoredDraftBytes(row!)).toBe(1_900_000)
      expect(await fixture.db.select().from(sceneCompatibilityDrafts).all()).toHaveLength(1)
      expect(await fixture.db.select().from(sceneCompatibilityRequests).all()).toHaveLength(0)
      expect(await revisionCount(fixture)).toBe(0)
    })

    it('rejects a real serialized draft row at 1,900,001 bytes without partial records', async () => {
      const input = draftInputForSerializedSize(COMPATIBILITY_MAX_ROW_BYTES + 1, 'draft-size-limit-over')
      let failure: unknown
      try {
        await createSceneCompatibilityDraft(fixture.db, input)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(SceneCompatibilityRepositoryError)
      expect(failure instanceof Error ? failure.message : '').toContain('超过存储大小限制')

      expect(await fixture.db.select().from(sceneCompatibilityDrafts).all()).toHaveLength(0)
      expect(await fixture.db.select().from(sceneCompatibilityRequests).all()).toHaveLength(0)
      expect(await revisionCount(fixture)).toBe(0)
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

    it('rejects an already-entered attempt 0 after recovery and attempt 1 have committed', async () => {
      const startedAt = new Date()
      const expiredAt = new Date(startedAt.getTime() + 31_000)
      await commitScene(fixture.db, {
        worldId: WORLD, expectedVersion: 0, requestId: 'seed-fenced',
        document: voxelEnvelope(), summary: 'seed', kind: 'initial',
      })
      const { draft } = await createReadyDraft(fixture)
      // Keep this fixture's ready draft inside its real-time retention window.
      await fixture.db.update(sceneCompatibilityDrafts).set({ updatedAt: startedAt.toISOString() })
        .where(eq(sceneCompatibilityDrafts.id, draft.id))
      const first = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { now: startedAt }))
      expect(first.claimed).toBe(true)

      let reachedBatch!: () => void
      let releaseBatch!: () => void
      const atBatch = new Promise<void>(resolve => { reachedBatch = resolve })
      const held = new Promise<void>(resolve => { releaseBatch = resolve })
      let delayed = false
      const oldDb = new Proxy(fixture.db, {
        get(target, property, receiver) {
          if (property === 'batch') return async (statements: Parameters<typeof fixture.db.batch>[0]) => {
            if (!delayed) {
              delayed = true
              reachedBatch()
              await held
            }
            const batch = Reflect.get(target, property, target) as typeof fixture.db.batch
            return batch.call(target, statements)
          }
          return Reflect.get(target, property, receiver)
        },
      }) as typeof fixture.db
      const persist = (claim: typeof first, db: typeof fixture.db) => commitScene(db, {
        worldId: WORLD, expectedVersion: 1, requestId: 'req-1', document: draft.candidate!,
        summary: 'compat confirm', kind: 'compatibility-repair',
        compatibilityJson: JSON.stringify(auditFor(draft, 'req-1')),
        compatibility: {
          draftId: draft.id, requestId: 'req-1', attempt: claim.attempt,
          leaseToken: claim.leaseToken!, leaseUntil: claim.request.leaseUntil!,
        },
        compatibilityCompletion: { actorKey: ACTOR },
      })
      const staleAttempt = persist(first, oldDb)
      await atBatch

      const recovery = await recoverSceneCompatibilityRequest(fixture.db, claimInput(draft.id, {
        expectedAttempt: 1, now: expiredAt,
      }))
      expect(recovery).toMatchObject({ status: 'not-committed', attempt: 0, nextAttempt: 1, retryAllowed: true })
      const retry = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, {
        expectedAttempt: 1, now: new Date(expiredAt.getTime() + 1_000),
      }))
      expect(retry).toMatchObject({ claimed: true, attempt: 1 })
      const committed = await persist(retry, fixture.db)
      await completeSceneCompatibilityRequest(fixture.db, {
        worldId: WORLD, requestId: 'req-1', actorKey: ACTOR, attempt: retry.attempt,
        leaseToken: retry.leaseToken!, resultVersion: committed.version,
      })

      releaseBatch()
      await expect(staleAttempt).rejects.toBeInstanceOf(SceneConflict)
      expect(await revisionCount(fixture)).toBe(2)
      const receipt = await readSceneCompatibilityRequest(fixture.db, WORLD, 'req-1', ACTOR)
      expect(receipt).toMatchObject({ status: 'completed', attempt: 1 })
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

    it('keeps recovery unknown when a same-ID revision has a mismatched or corrupt audit', async () => {
      const { draft } = await createReadyDraft(fixture)
      const mismatchedAudit = auditFor(draft, 'different-request-id')
      await commitScene(fixture.db, {
        worldId: WORLD, expectedVersion: 0, requestId: 'req-bad-audit',
        document: voxelEnvelope(), summary: 'uncertain compatibility write', kind: 'compatibility-repair',
        compatibilityJson: JSON.stringify(mismatchedAudit),
      })
      const before = await revisionCount(fixture)

      const view = await recoverSceneCompatibilityRequest(fixture.db, claimInput(draft.id, {
        requestId: 'req-bad-audit', expectedAttempt: 0, now: at(1),
      }))

      expect(view).toEqual({ status: 'unknown', retryAllowed: false })
      expect(await revisionCount(fixture)).toBe(before)
      expect(await fixture.db.select().from(sceneCompatibilityRequests)
        .where(eq(sceneCompatibilityRequests.requestId, 'req-bad-audit')).get()).toBeUndefined()
    })

    it('returns unknown without a retry grant when request storage reads fail', async () => {
      const { draft } = await createReadyDraft(fixture)
      const before = await revisionCount(fixture)
      const unreadable = new Proxy(fixture.db, {
        get(target, property, receiver) {
          if (property === 'select') return () => { throw new Error('injected storage read failure') }
          return Reflect.get(target, property, receiver)
        },
      }) as typeof fixture.db

      await expect(recoverSceneCompatibilityRequest(unreadable, claimInput(draft.id, {
        requestId: 'req-read-failure', expectedAttempt: 0, now: at(1),
      }))).resolves.toEqual({ status: 'unknown', retryAllowed: false })
      await expect(readSceneCompatibilityRequest(unreadable, WORLD, 'req-read-failure', ACTOR))
        .resolves.toEqual({ status: 'unknown', retryAllowed: false })
      expect(await revisionCount(fixture)).toBe(before)
      expect(await fixture.db.select().from(sceneCompatibilityRequests)
        .where(eq(sceneCompatibilityRequests.requestId, 'req-read-failure')).get()).toBeUndefined()
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
      await expect(claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, {
        requestId: 'req-never', expectedAttempt: 0, now: at(2),
      }))).rejects.toBeInstanceOf(SceneCompatibilityRequestMismatch)
      const nextAttempt = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, {
        requestId: 'req-never', expectedAttempt: 1, now: at(2),
      }))
      expect(nextAttempt).toMatchObject({ claimed: true, attempt: 1 })
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

  describe('A1 namespace replay', () => {
    it('普通编辑与兼容请求同 requestId 不返回对方结果，同用途重发仍命中重放', async () => {
      await commitScene(fixture.db, {
        worldId: WORLD, expectedVersion: 0, requestId: 'ns-seed',
        document: voxelEnvelope(), summary: 'seed', kind: 'initial',
      })
      const edited = await commitScene(fixture.db, {
        worldId: WORLD, expectedVersion: 1, requestId: 'ns-edit',
        document: voxelEnvelope(), summary: 'edit', kind: 'voxel-edit',
      })
      // 同 ID 同用途同内容重发：返回原结果（既有幂等契约不变）
      const replay = await commitScene(fixture.db, {
        worldId: WORLD, expectedVersion: 1, requestId: 'ns-edit',
        document: voxelEnvelope(), summary: 'edit', kind: 'voxel-edit',
      })
      expect(replay.version).toBe(edited.version)
      expect(replay.contentHash).toBe(edited.contentHash)
      expect(await revisionCount(fixture)).toBe(2)
      // 兼容确认以同一 requestId + 同一文档到达：明确拒绝，不得返回普通编辑结果
      const { draft } = await createReadyDraft(fixture)
      const audit = auditFor(draft, 'ns-edit')
      await expect(commitScene(fixture.db, {
        worldId: WORLD, expectedVersion: 1, requestId: 'ns-edit',
        document: voxelEnvelope(), summary: 'compat confirm', kind: 'compatibility-repair',
        compatibilityJson: JSON.stringify(audit),
        compatibility: { draftId: draft.id, requestId: 'ns-edit', attempt: 0, leaseToken: 'lt-0', leaseUntil: '2026-02-01T00:00:30.000Z' },
      })).rejects.toThrow(SceneConflict)
      expect(await revisionCount(fixture)).toBe(2)
    })

    it('兼容请求先行后普通编辑同 ID 同样被拒；同草稿新 attempt 重试命中重放', async () => {
      await commitScene(fixture.db, {
        worldId: WORLD, expectedVersion: 0, requestId: 'ns-seed',
        document: voxelEnvelope(), summary: 'seed', kind: 'initial',
      })
      const { draft } = await createReadyDraft(fixture)
      const compatInput = {
        worldId: WORLD, expectedVersion: 1, requestId: 'ns-compat',
        document: voxelEnvelope(), summary: 'compat confirm', kind: 'compatibility-repair',
        compatibilityJson: JSON.stringify(auditFor(draft, 'ns-compat')),
      }
      const committed = await commitScene(fixture.db, {
        ...compatInput,
        compatibility: { draftId: draft.id, requestId: 'ns-compat', attempt: 0, leaseToken: 'lt-0', leaseUntil: '2026-02-01T00:00:30.000Z' },
      })
      // 普通编辑同 ID 同内容：拒绝
      await expect(commitScene(fixture.db, {
        worldId: WORLD, expectedVersion: 1, requestId: 'ns-compat',
        document: voxelEnvelope(), summary: 'edit', kind: 'voxel-edit',
      })).rejects.toThrow(SceneConflict)
      // 崩溃恢复：同用途同内容以新 attempt/租约重试，返回原修订（租约字段不属于命名空间）
      const retried = await commitScene(fixture.db, {
        ...compatInput,
        compatibility: { draftId: draft.id, requestId: 'ns-compat', attempt: 1, leaseToken: 'lt-1', leaseUntil: '2026-02-01T00:01:30.000Z' },
      })
      expect(retried.version).toBe(committed.version)
      expect(retried.contentHash).toBe(committed.contentHash)
      expect(await revisionCount(fixture)).toBe(2)
      // 同 ID 换成另一份草稿身份：拒绝
      await expect(commitScene(fixture.db, {
        ...compatInput,
        compatibilityJson: JSON.stringify({ ...auditFor(draft, 'ns-compat'), draftId: 'draft-other' }),
        compatibility: { draftId: 'draft-other', requestId: 'ns-compat', attempt: 0, leaseToken: 'lt-2', leaseUntil: '2026-02-01T00:00:30.000Z' },
      })).rejects.toThrow(SceneConflict)
    })
  })

  describe('A1 draft expiry', () => {
    const WEEK_S = 7 * 24 * 60 * 60

    it('refuses to claim an expired draft and creates no request row or revision', async () => {
      const { draft } = await createReadyDraft(fixture)
      // 草稿最后更新于 at(2);恰好 7 天后即到期(边界 inclusive)
      await expect(claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { now: at(2 + WEEK_S) })))
        .rejects.toMatchObject({ code: 'draft-unavailable' })
      expect(await fixture.db.select().from(sceneCompatibilityRequests).all()).toHaveLength(0)
      expect(await revisionCount(fixture)).toBe(0)
    })

    it('claims a draft inside its retention window', async () => {
      const { draft } = await createReadyDraft(fixture)
      const claim = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { now: at(2 + WEEK_S - 1) }))
      expect(claim.claimed).toBe(true)
      expect(claim.attempt).toBe(0)
    })

    it('still replays a completed request after its draft has expired', async () => {
      await commitScene(fixture.db, {
        worldId: WORLD, expectedVersion: 0, requestId: 'seed-1',
        document: voxelEnvelope(), summary: 'seed', kind: 'initial',
      })
      const { draft } = await createReadyDraft(fixture)
      const claim = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { now: at(3) }))
      const committed = await commitScene(fixture.db, {
        worldId: WORLD, expectedVersion: 1, requestId: 'req-1',
        document: draft.candidate!, summary: 'compat confirm', kind: 'compatibility-repair',
        compatibilityJson: JSON.stringify(auditFor(draft, 'req-1')),
        compatibility: {
          draftId: draft.id, requestId: 'req-1', attempt: claim.attempt,
          leaseToken: claim.leaseToken!, leaseUntil: claim.request.leaseUntil!,
        },
      })
      await completeSceneCompatibilityRequest(fixture.db, {
        worldId: WORLD, requestId: 'req-1', actorKey: ACTOR,
        attempt: claim.attempt, leaseToken: claim.leaseToken!, resultVersion: committed.version, now: at(4),
      })
      // 草稿已过期,但已完成请求的重放不被到期拦截,也不新增修订
      const replay = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { now: at(4 + WEEK_S) }))
      expect(replay.claimed).toBe(false)
      const view = await readSceneCompatibilityRequest(fixture.db, WORLD, 'req-1', ACTOR, at(4 + WEEK_S))
      expect(view.status).toBe('completed')
      expect(await revisionCount(fixture)).toBe(2)
    })

    it('recover refuses nextAttempt for an expired draft and creates no retired row', async () => {
      const { draft } = await createReadyDraft(fixture)
      const view = await recoverSceneCompatibilityRequest(fixture.db, claimInput(draft.id, {
        requestId: 'req-never', expectedAttempt: 0, now: at(2 + WEEK_S),
      }))
      expect(view.status).toBe('not-committed')
      if (view.status !== 'not-committed' || !('error' in view)) throw new Error('unreachable')
      expect(view.retryAllowed).toBe(false)
      expect(view.error.code).toBe('draft-unavailable')
      expect(view.error.action).toBe('recheck')
      expect(await fixture.db.select().from(sceneCompatibilityRequests).all()).toHaveLength(0)
    })

    it('recover fences the expired lease of an expired draft but refuses the retry grant', async () => {
      const { draft } = await createReadyDraft(fixture)
      await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { now: at(3) }))
      const before = await revisionCount(fixture)
      const view = await recoverSceneCompatibilityRequest(fixture.db, claimInput(draft.id, {
        expectedAttempt: 1, now: at(2 + WEEK_S),
      }))
      expect(view.status).toBe('not-committed')
      if (view.status !== 'not-committed' || !('error' in view)) throw new Error('unreachable')
      expect(view.retryAllowed).toBe(false)
      expect(view.error.code).toBe('draft-unavailable')
      const row = await fixture.db.select().from(sceneCompatibilityRequests)
        .where(eq(sceneCompatibilityRequests.requestId, 'req-1')).get()
      expect(row?.state).toBe('not-committed')
      expect(row?.leaseToken).toBeNull()
      expect(await revisionCount(fixture)).toBe(before)
    })

    it('cleans up to ten expired unsubmitted drafts per world and keeps journaled or fresh drafts', async () => {
      // 11 条过期未提交草稿
      for (let i = 0; i < 11; i += 1) {
        await createSceneCompatibilityDraft(fixture.db, makeDraftInput({ draftRequestId: `old-${i}` }))
      }
      // 过期但有提交中请求日志 → 不清
      const submitting = await createReadyDraft(fixture, { draftRequestId: 'journaled-submitting' })
      await claimSceneCompatibilityRequest(fixture.db, claimInput(submitting.draft.id, { requestId: 'req-sub', now: at(3) }))
      // 过期但有失败(未知排查用)请求日志 → 不清
      const failed = await createReadyDraft(fixture, { draftRequestId: 'journaled-failed' })
      const failedClaim = await claimSceneCompatibilityRequest(fixture.db, claimInput(failed.draft.id, { requestId: 'req-fail', now: at(3) }))
      await failSceneCompatibilityRequest(fixture.db, {
        worldId: WORLD, requestId: 'req-fail', actorKey: ACTOR,
        attempt: failedClaim.attempt, leaseToken: failedClaim.leaseToken!, failureCode: 'storage-failure', now: at(4),
      })
      // 未到期草稿 → 不清
      await createSceneCompatibilityDraft(fixture.db, makeDraftInput({ draftRequestId: 'fresh-1', now: at(2 * 24 * 3600) }))
      // 另一世界的过期草稿 → 不在本世界清理范围
      await fixture.db.insert(worlds).values({ id: 'w2', userId: 'u1', name: 'Other', description: '' })
      await createSceneCompatibilityDraft(fixture.db, makeDraftInput({ worldId: 'w2', draftRequestId: 'old-w2' }))

      const cleanupNow = at(8 * 24 * 3600)
      const first = await cleanupExpiredSceneCompatibilityDrafts(fixture.db, WORLD, cleanupNow)
      expect(first).toBe(8)
      const remaining = await fixture.db.select({ id: sceneCompatibilityDrafts.id }).from(sceneCompatibilityDrafts)
        .where(eq(sceneCompatibilityDrafts.worldId, WORLD)).all()
      expect(remaining).toHaveLength(6)
      const second = await cleanupExpiredSceneCompatibilityDrafts(fixture.db, WORLD, cleanupNow)
      expect(second).toBe(3)
      const after = await fixture.db.select({ id: sceneCompatibilityDrafts.id }).from(sceneCompatibilityDrafts)
        .where(eq(sceneCompatibilityDrafts.worldId, WORLD)).all()
      expect(after).toHaveLength(3)
      const otherWorld = await fixture.db.select({ id: sceneCompatibilityDrafts.id }).from(sceneCompatibilityDrafts)
        .where(eq(sceneCompatibilityDrafts.worldId, 'w2')).all()
      expect(otherWorld).toHaveLength(1)
    })
  })

  describe('A1 expired lease read fence', () => {
    it('fences an expired submitting lease and grants the next attempt when no revision landed', async () => {
      const { draft } = await createReadyDraft(fixture)
      await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id))
      const before = await revisionCount(fixture)
      const view = await readSceneCompatibilityRequest(fixture.db, WORLD, 'req-1', ACTOR, at(31))
      expect(view).toEqual({ status: 'not-committed', attempt: 0, nextAttempt: 1, retryAllowed: true })
      expect(await revisionCount(fixture)).toBe(before)
      const row = await fixture.db.select().from(sceneCompatibilityRequests)
        .where(eq(sceneCompatibilityRequests.requestId, 'req-1')).get()
      expect(row?.state).toBe('not-committed')
      expect(row?.leaseToken).toBeNull()
      // 读取栅栏授予的 nextAttempt 可立即重取执行权
      const retry = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { expectedAttempt: 1, now: at(32) }))
      expect(retry.claimed).toBe(true)
      expect(retry.attempt).toBe(1)
    })

    it('keeps submitting while the lease is still valid and does not fence', async () => {
      const { draft } = await createReadyDraft(fixture)
      const claim = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id))
      const view = await readSceneCompatibilityRequest(fixture.db, WORLD, 'req-1', ACTOR, at(1))
      expect(view).toEqual({ status: 'submitting', attempt: 0, retryAllowed: false })
      const row = await fixture.db.select().from(sceneCompatibilityRequests)
        .where(eq(sceneCompatibilityRequests.requestId, 'req-1')).get()
      expect(row?.state).toBe('submitting')
      expect(row?.leaseToken).toBe(claim.leaseToken)
    })

    it('returns completed when the revision landed even though the lease expired', async () => {
      await commitScene(fixture.db, {
        worldId: WORLD, expectedVersion: 0, requestId: 'seed-1',
        document: voxelEnvelope(), summary: 'seed', kind: 'initial',
      })
      const { draft } = await createReadyDraft(fixture)
      const claim = await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { now: at(3) }))
      // 修订落库但请求行仍停留在 submitting(完成回执丢失的场景)
      const committed = await commitScene(fixture.db, {
        worldId: WORLD, expectedVersion: 1, requestId: 'req-1',
        document: draft.candidate!, summary: 'compat confirm', kind: 'compatibility-repair',
        compatibilityJson: JSON.stringify(auditFor(draft, 'req-1')),
        compatibility: {
          draftId: draft.id, requestId: 'req-1', attempt: claim.attempt,
          leaseToken: claim.leaseToken!, leaseUntil: claim.request.leaseUntil!,
        },
      })
      const view = await readSceneCompatibilityRequest(fixture.db, WORLD, 'req-1', ACTOR, at(34))
      expect(view.status).toBe('completed')
      if (view.status !== 'completed') throw new Error('unreachable')
      expect(view.result.version).toBe(committed.version)
      expect(view.result.requestId).toBe('req-1')
    })

    it('does not grant a retry through read once the fenced draft has expired', async () => {
      const WEEK_S = 7 * 24 * 60 * 60
      const { draft } = await createReadyDraft(fixture)
      await claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { now: at(3) }))
      const view = await readSceneCompatibilityRequest(fixture.db, WORLD, 'req-1', ACTOR, at(2 + WEEK_S))
      expect(view.status).toBe('not-committed')
      if (view.status !== 'not-committed' || !('error' in view)) throw new Error('unreachable')
      expect(view.retryAllowed).toBe(false)
      expect(view.error.code).toBe('draft-unavailable')
      expect(view.error.action).toBe('recheck')
      // 草稿已过期:被授予的旧 attempt 也无法再取得执行权
      await expect(claimSceneCompatibilityRequest(fixture.db, claimInput(draft.id, { expectedAttempt: 1, now: at(3 + WEEK_S) })))
        .rejects.toMatchObject({ code: 'draft-unavailable' })
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
