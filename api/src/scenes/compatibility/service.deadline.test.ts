import { afterEach, describe, expect, it } from 'vitest'
import {
  createEmptyWorld,
  serialize,
  setBlockMut,
  type SceneValidationBasis,
  type SceneValidationReport,
  type SceneWorkControl,
  type SerializedVoxelDocument,
} from '@possibility/voxel-contract'
import type { Db } from '../../db/client'
import { eq } from 'drizzle-orm'
import { sceneCompatibilityDrafts, sceneCompatibilityRequests, users, worldSceneRevisions, worlds } from '../../db/schema'
import { createTestDb } from '../../test/db'
import { commitScene } from '../repository'
import { confirmCompatibility, createCompatibilityDraft } from './service'
import {
  blockExpiredSceneCompatibilityDraft,
  claimSceneCompatibilityDraftBuild,
  claimSceneCompatibilityRequest,
  createSceneCompatibilityDraft,
  fingerprintSceneCompatibilityDraft,
  publishSceneCompatibilityDraft,
  readSceneCompatibilityDraft,
} from './repository'

const NOW = '2026-10-05T00:00:00.000Z'
const ACTOR = { actorKey: 'deadline-actor', userId: 'deadline-user' }

function control(nowMs: () => number): SceneWorkControl {
  return { signal: new AbortController().signal, nowMs, yieldControl: async () => {} }
}

function collisionDocument(): SerializedVoxelDocument {
  const doc = createEmptyWorld({ width: 8, height: 3, depth: 8 }, 'mist-manor', 'deadline-source')
  for (let z = 0; z < 8; z += 1) for (let x = 0; x < 8; x += 1) setBlockMut(doc, { x, y: 0, z }, 'grass')
  doc.assetPlacements = [{ id: 'decor', assetId: 'veg-flower-a', anchor: [2, 0, 2], rotation: 0, seed: 1 }]
  doc.objects.push({ id: 'keeper', objectType: 'stone-lantern', anchor: { x: 2, y: 0, z: 2 }, rotation: 0 })
  doc.objectCells.push({ objectId: 'keeper', cells: [{ x: 2, y: 0, z: 2 }, { x: 2, y: 1, z: 2 }] })
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

function largeCollisionDocument(): SerializedVoxelDocument {
  const doc = createEmptyWorld({ width: 32, height: 3, depth: 32 }, 'mist-manor', 'deadline-large-source')
  for (let z = 0; z < 32; z += 1) for (let x = 0; x < 32; x += 1) setBlockMut(doc, { x, y: 0, z }, 'grass')
  doc.assetPlacements = [{ id: 'decor', assetId: 'veg-flower-a', anchor: [2, 0, 2], rotation: 0, seed: 1 }]
  doc.objects.push({ id: 'keeper', objectType: 'stone-lantern', anchor: { x: 2, y: 0, z: 2 }, rotation: 0 })
  doc.objectCells.push({ objectId: 'keeper', cells: [{ x: 2, y: 0, z: 2 }, { x: 2, y: 1, z: 2 }] })
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

function wrapAwaitable<T>(value: T, onSettled: () => void): T {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value
  return new Proxy(value as object, {
    get(target, property) {
      const member = Reflect.get(target, property, target)
      if (property === 'then' && typeof member === 'function') {
        return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => member.call(
          target,
          async (result: unknown) => { await new Promise<void>(done => setTimeout(done, 1)); onSettled(); return resolve(result) },
          reject,
        )
      }
      if (typeof member === 'function') return (...args: unknown[]) => wrapAwaitable(member.apply(target, args), onSettled)
      return member
    },
  }) as T
}

function advanceClockAfterFirstSelect(db: Db, advance: () => void): Db {
  let advanced = false
  return new Proxy(db, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver)
      if (property === 'select' && typeof member === 'function') return (...args: unknown[]) => wrapAwaitable(
        Reflect.apply(member, target, args),
        () => { if (!advanced) { advanced = true; advance() } },
      )
      return typeof member === 'function' ? member.bind(target) : member
    },
  }) as Db
}

function advanceClockAfterDraftInsert(db: Db, advance: () => void): Db {
  let advanced = false
  return new Proxy(db, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver)
      if (property === 'insert' && typeof member === 'function') return (...args: unknown[]) => {
        const query = Reflect.apply(member, target, args)
        return wrapAwaitable(query, () => {
          if (!advanced && args[0] === sceneCompatibilityDrafts) { advanced = true; advance() }
        })
      }
      return typeof member === 'function' ? member.bind(target) : member
    },
  }) as Db
}

function validReport(): SceneValidationReport {
  return {
    status: 'valid', issues: [], issueCount: 0, countIsExact: true, stopReason: null,
    checkedSpaceIds: ['single'], pendingSpaceIds: [], workUnitsUsed: 1, elapsedMs: 0,
    ruleNotes: { items: [], total: 0, hasMore: false },
  }
}

describe('scene compatibility draft deadline', () => {
  const fixtures: ReturnType<typeof createTestDb>[] = []
  afterEach(() => { fixtures.splice(0).forEach(f => f.close()) })

  async function seeded(document = collisionDocument()) {
    const f = createTestDb()
    fixtures.push(f)
    await f.db.insert(users).values({ id: ACTOR.userId, username: ACTOR.userId, passwordHash: 'x', createdAt: NOW })
    await f.db.insert(worlds).values({ id: 'w-deadline', userId: ACTOR.userId, name: 'Deadline', description: '' })
    await commitScene(f.db, {
      worldId: 'w-deadline', expectedVersion: 0, requestId: 'seed', document,
      summary: 'deadline fixture', kind: 'initial',
    })
    return f
  }

  it('continues near 10s after a real SQLite read delay, but expires at the boundary before creating a draft', async () => {
    for (const advanceMs of [9_000, 10_000]) {
      const f = await seeded()
      let fakeNow = Date.now()
      const db = advanceClockAfterFirstSelect(f.db, () => { fakeNow += advanceMs })
      const run = createCompatibilityDraft(db, {
        ...ACTOR, worldId: 'w-deadline', draftRequestId: `near-${advanceMs}`, purpose: 'repair-current',
        target: { kind: 'current' }, expectedCurrentVersion: 1, access: { bindings: {
          personIds: [], locations: [], protectedObjects: [], protectedPlacements: [],
          locationBindings: [], personBindings: [], entries: [],
        } },
        budget: { maxDraftWallMs: 10_000 },
        control: control(() => fakeNow),
      })
      if (advanceMs === 9_000) {
        const draft = await run
        expect(draft.status).toBe('ready')
        expect(draft.report?.status).toBe('valid')
      } else {
        await expect(run).rejects.toMatchObject({ code: 'validation-incomplete', status: 409 })
        expect(await f.db.select().from(sceneCompatibilityDrafts)).toHaveLength(0)
      }
      f.close()
      fixtures.splice(fixtures.indexOf(f), 1)
    }
  })

  it('stops a single rule-check operation at 3s while the enclosing draft still has time remaining', async () => {
    const f = await seeded(largeCollisionDocument())
    const startedAt = Date.now()
    let fakeNow = startedAt
    let advanced = false
    const draft = await createCompatibilityDraft(f.db, {
      ...ACTOR, worldId: 'w-deadline', draftRequestId: 'single-operation-deadline', purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: { bindings: {
        personIds: [], locations: [], protectedObjects: [], protectedPlacements: [],
        locationBindings: [], personBindings: [], entries: [],
      } },
      budget: { maxDraftWallMs: 10_000, maxWallMs: 3_000 },
      control: {
        ...control(() => fakeNow),
        yieldControl: async () => {
          if (!advanced) { advanced = true; fakeNow += 3_001 }
        },
      },
    })
    expect(advanced).toBe(true)
    expect(fakeNow - startedAt).toBeLessThan(10_000)
    expect(draft.status).toBe('blocked')
    expect(draft.report).toMatchObject({ status: 'incomplete', stopReason: 'deadline', countIsExact: false })
  })

  it('keeps a timed-out durable draft non-confirmable when its insert returns at the 10s boundary', async () => {
    const f = await seeded()
    let fakeNow = Date.now()
    const db = advanceClockAfterDraftInsert(f.db, () => { fakeNow += 10_000 })
    const draft = await createCompatibilityDraft(db, {
      ...ACTOR, worldId: 'w-deadline', draftRequestId: 'insert-crosses-deadline', purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: { bindings: {
        personIds: [], locations: [], protectedObjects: [], protectedPlacements: [],
        locationBindings: [], personBindings: [], entries: [],
      } },
      budget: { maxDraftWallMs: 10_000 },
      control: control(() => fakeNow),
    })
    expect(draft.status).toBe('building')
    expect(draft.candidate).toBeNull()
    const persisted = await readSceneCompatibilityDraft(f.db, 'w-deadline', draft.id, ACTOR.actorKey)
    expect(persisted).toMatchObject({ status: 'building', candidate: null })
    await expect(confirmCompatibility(f.db, {
      ...ACTOR, worldId: 'w-deadline', draftId: draft.id, requestId: 'cannot-confirm-timeout',
      expectedCurrentVersion: 1, expectedAttempt: 0, access: { bindings: {
        personIds: [], locations: [], protectedObjects: [], protectedPlacements: [],
        locationBindings: [], personBindings: [], entries: [],
      } },
    })).rejects.toMatchObject({ code: 'draft-blocked', status: 409 })
    expect(await f.db.select().from(sceneCompatibilityRequests)).toHaveLength(0)
    expect(await f.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, 'w-deadline'))).toHaveLength(1)
  })

  it('uses SQLite execution time to reject late ready publication and atomically blocks the unconfirmed draft', async () => {
    const f = await seeded()
    const basis: SceneValidationBasis = {
      expectedCurrentVersion: 1, currentContentHash: 'source-hash',
      source: { worldId: 'w-deadline', version: 1, contentHash: 'source-hash' }, candidateHash: null,
      rulesVersion: '', assetManifestHash: '', templateCatalogHash: '', bindingHash: '', contextFingerprint: '', baseline: null,
    }
    const record = {
      actorKey: ACTOR.actorKey, draftRequestId: 'sql-deadline', worldId: 'w-deadline',
      purpose: 'repair-current' as const, target: { kind: 'current' as const }, expectedCurrentVersion: 1, basis,
    }
    const draft = await createSceneCompatibilityDraft(f.db, record)
    const claim = await claimSceneCompatibilityDraftBuild(f.db, {
      worldId: 'w-deadline', draftId: draft.id, actorKey: ACTOR.actorKey,
      inputFingerprint: await fingerprintSceneCompatibilityDraft(record),
    })
    expect(claim.claimed).toBe(true)
    const deadlineAt = new Date(Date.now() - 1_000)
    await expect(publishSceneCompatibilityDraft(f.db, {
      worldId: 'w-deadline', draftId: draft.id, actorKey: ACTOR.actorKey,
      buildLeaseToken: claim.buildLeaseToken!, buildAttempt: claim.buildAttempt,
      status: 'ready', candidate: collisionDocument(), changes: [], report: validReport(), basis, deadlineAt,
    })).rejects.toMatchObject({ code: 'result-unknown' })
    const blocked = await blockExpiredSceneCompatibilityDraft(f.db, {
      worldId: 'w-deadline', draftId: draft.id, actorKey: ACTOR.actorKey,
      buildAttempt: claim.buildAttempt, deadlineAt,
      report: { ...validReport(), status: 'incomplete', countIsExact: false, stopReason: 'deadline' }, basis,
    })
    expect(blocked).toMatchObject({ status: 'blocked', candidate: null, report: { status: 'incomplete', stopReason: 'deadline' } })
    await expect(claimSceneCompatibilityRequest(f.db, {
      worldId: 'w-deadline', draftId: draft.id, requestId: 'expired-claim', actorKey: ACTOR.actorKey,
      expectedCurrentVersion: 1, expectedAttempt: 0,
    })).rejects.toMatchObject({ code: 'draft-blocked' })
    expect(await f.db.select().from(sceneCompatibilityRequests)).toHaveLength(0)
  })

  it('does not overwrite a timed-out draft once a request journal already exists', async () => {
    const f = await seeded()
    const basis: SceneValidationBasis = {
      expectedCurrentVersion: 1, currentContentHash: 'source-hash',
      source: { worldId: 'w-deadline', version: 1, contentHash: 'source-hash' }, candidateHash: null,
      rulesVersion: '', assetManifestHash: '', templateCatalogHash: '', bindingHash: '', contextFingerprint: '', baseline: null,
    }
    const record = {
      actorKey: ACTOR.actorKey, draftRequestId: 'journal-preserved', worldId: 'w-deadline',
      purpose: 'repair-current' as const, target: { kind: 'current' as const }, expectedCurrentVersion: 1, basis,
    }
    const draft = await createSceneCompatibilityDraft(f.db, record)
    const claim = await claimSceneCompatibilityDraftBuild(f.db, {
      worldId: 'w-deadline', draftId: draft.id, actorKey: ACTOR.actorKey,
      inputFingerprint: await fingerprintSceneCompatibilityDraft(record),
    })
    const published = await publishSceneCompatibilityDraft(f.db, {
      worldId: 'w-deadline', draftId: draft.id, actorKey: ACTOR.actorKey,
      buildLeaseToken: claim.buildLeaseToken!, buildAttempt: claim.buildAttempt,
      status: 'ready', candidate: collisionDocument(), changes: [], report: validReport(), basis,
      deadlineAt: new Date(Date.now() + 30_000),
    })
    expect(published.status).toBe('ready')
    const request = await claimSceneCompatibilityRequest(f.db, {
      worldId: 'w-deadline', draftId: draft.id, requestId: 'in-flight', actorKey: ACTOR.actorKey,
      expectedCurrentVersion: 1, expectedAttempt: 0,
    })
    expect(request.claimed).toBe(true)
    expect(await blockExpiredSceneCompatibilityDraft(f.db, {
      worldId: 'w-deadline', draftId: draft.id, actorKey: ACTOR.actorKey,
      buildAttempt: claim.buildAttempt, deadlineAt: new Date(Date.now() - 1_000),
      report: { ...validReport(), status: 'incomplete', countIsExact: false, stopReason: 'deadline' }, basis,
    })).toBeNull()
    expect(await readSceneCompatibilityDraft(f.db, 'w-deadline', draft.id, ACTOR.actorKey)).toMatchObject({ status: 'ready' })
    expect(await f.db.select().from(sceneCompatibilityRequests)).toHaveLength(1)
  })
})
