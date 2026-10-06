import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  createEmptyWorld,
  serialize,
  setBlockMut,
  type SceneBindingContext,
  type SceneWorkControl,
  type SerializedVoxelDocument,
} from '@possibility/voxel-contract'
import { createTestDb } from '../../test/db'
import {
  sceneCompatibilityDrafts,
  sceneCompatibilityRequests,
  sceneValidationPolicy,
  users,
  worldSceneRevisions,
  worlds,
} from '../../db/schema'
import { commitScene, readCurrentScene, readSceneVersion } from '../repository'
import { COMPATIBILITY_DRAFT_RETENTION_MS } from './repository'
import {
  createCompatibilityDraft,
  readCompatibilityRequest,
  recoverCompatibilityRequest,
} from './service'
import type { SceneValidationAccess } from './context'

const NOW = new Date('2026-10-06T00:00:00.000Z')
const ACTOR = { actorKey: 'retry-expiry-actor', userId: 'retry-expiry-user' }
const control = (): Partial<SceneWorkControl> => ({
  signal: new AbortController().signal,
  nowMs: () => 0,
  yieldControl: async () => {},
})
const access = (personIds: string[] = []): SceneValidationAccess => ({
  bindings: {
    personIds, locations: [], protectedObjects: [], protectedPlacements: [],
    locationBindings: [], personBindings: [], entries: [],
  } satisfies SceneBindingContext,
})

function validDocument(id: string): SerializedVoxelDocument {
  const doc = createEmptyWorld({ width: 4, height: 3, depth: 4 }, 'mist-manor', id)
  for (let z = 0; z < 4; z += 1) for (let x = 0; x < 4; x += 1) setBlockMut(doc, { x, y: 0, z }, 'grass')
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

function repairableDocument(): SerializedVoxelDocument {
  const doc = createEmptyWorld({ width: 4, height: 3, depth: 4 }, 'mist-manor', 'retry-expiry')
  for (let z = 0; z < 4; z += 1) for (let x = 0; x < 4; x += 1) setBlockMut(doc, { x, y: 0, z }, 'grass')
  doc.assetPlacements = [{ id: 'flower', assetId: 'veg-flower-a', anchor: [1, 0, 1], rotation: 0, seed: 1 }]
  doc.objects.push({ id: 'keeper', objectType: 'stone-lantern', anchor: { x: 1, y: 0, z: 1 }, rotation: 0 })
  doc.objectCells.push({ objectId: 'keeper', cells: [{ x: 1, y: 0, z: 1 }, { x: 1, y: 1, z: 1 }] })
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

describe('A8.6 service retry revocation after known non-commit', () => {
  const fixtures: ReturnType<typeof createTestDb>[] = []
  afterEach(() => {
    vi.useRealTimers()
    fixtures.splice(0).forEach(fixture => fixture.close())
  })

  async function seed(worldId: string) {
    const fixture = createTestDb()
    fixtures.push(fixture)
    await fixture.db.insert(users).values({
      id: ACTOR.userId, username: `user-${worldId}`, passwordHash: 'unused', createdAt: NOW.toISOString(),
    })
    await fixture.db.insert(worlds).values({ id: worldId, userId: ACTOR.userId, name: worldId, description: '' })
    const initial = await commitScene(fixture.db, {
      worldId, expectedVersion: 0, requestId: `seed-${worldId}`, document: repairableDocument(),
      summary: 'initial retry source', kind: 'initial',
    })
    return { fixture, initial }
  }

  async function createKnownNotCommitted(fixture: ReturnType<typeof createTestDb>, worldId: string, accessContext: SceneValidationAccess) {
    const draft = await createCompatibilityDraft(fixture.db, {
      ...ACTOR, worldId, draftRequestId: `draft-${worldId}`, purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: 1, access: accessContext, control: control(),
    })
    if (draft.status !== 'ready') throw new Error('fixture compatibility draft should be ready')
    const requestId = `request-${worldId}`
    const recovered = await recoverCompatibilityRequest(fixture.db, {
      ...ACTOR, worldId, draftId: draft.id, requestId,
      expectedCurrentVersion: 1, expectedAttempt: 0, access: accessContext, control: control(),
    })
    expect(recovered).toMatchObject({ status: 'not-committed', attempt: 0, nextAttempt: 1, retryAllowed: true })
    const request = await fixture.db.select().from(sceneCompatibilityRequests)
      .where(eq(sceneCompatibilityRequests.requestId, requestId)).get()
    expect(request).toMatchObject({ state: 'not-committed', attempt: 0, failureCode: null, resultVersion: null })
    return { draft, requestId, request: request! }
  }

  it.each(['scene version', 'active rules', 'access basis'] as const)(
    'query and recover revoke a previously granted retry when %s changes', async changedBasis => {
      const worldId = `a86-${changedBasis.replaceAll(' ', '-')}`
      const { fixture } = await seed(worldId)
      const policy = { id: 'active', rulesVersion: 'rules-v1', assetManifestHash: 'assets-v1', templateCatalogHash: 'templates-v1', publishedAt: NOW.toISOString() }
      if (changedBasis === 'active rules') await fixture.db.insert(sceneValidationPolicy).values(policy)
      const originalAccess = access()
      const { draft, requestId, request: requestBefore } = await createKnownNotCommitted(fixture, worldId, originalAccess)

      if (changedBasis === 'scene version') {
        await commitScene(fixture.db, {
          worldId, expectedVersion: 1, requestId: `concurrent-${worldId}`, document: validDocument(`new-${worldId}`),
          summary: 'concurrent scene update', kind: 'edit',
        })
      } else if (changedBasis === 'active rules') {
        await fixture.db.update(sceneValidationPolicy).set({ rulesVersion: 'rules-v2' })
          .where(eq(sceneValidationPolicy.id, 'active'))
      }
      const changedAccess = changedBasis === 'access basis' ? access(['new-resident']) : originalAccess
      const currentBeforeRetry = await readCurrentScene(fixture.db, worldId)
      const historyBeforeRetry = await readSceneVersion(fixture.db, worldId, 1)
      const revisionsBeforeRetry = await fixture.db.select().from(worldSceneRevisions)
        .where(eq(worldSceneRevisions.worldId, worldId))
      const retryInput = {
        ...ACTOR, worldId, requestId, draftId: draft.id,
        expectedCurrentVersion: 1, expectedAttempt: 1, access: changedAccess, control: control(),
      }

      const queried = await readCompatibilityRequest(fixture.db, { ...retryInput, access: changedAccess })
      const recovered = await recoverCompatibilityRequest(fixture.db, retryInput)

      const expectedCode = changedBasis === 'scene version' ? 'scene-changed' : 'basis-changed'
      for (const view of [queried, recovered]) {
        expect(view.status).toBe('not-committed')
        if (view.status !== 'not-committed' || !('error' in view)) throw new Error('expected a non-retryable failure')
        expect(view.retryAllowed).toBe(false)
        expect(view.error.code).toBe(expectedCode)
        expect(view.error.action).toBe('recheck')
      }
      expect(await fixture.db.select().from(sceneCompatibilityRequests)
        .where(eq(sceneCompatibilityRequests.requestId, requestId)).get()).toEqual(requestBefore)
      expect(await readCurrentScene(fixture.db, worldId)).toEqual(currentBeforeRetry)
      expect(await readSceneVersion(fixture.db, worldId, 1)).toEqual(historyBeforeRetry)
      expect(await fixture.db.select().from(worldSceneRevisions)
        .where(eq(worldSceneRevisions.worldId, worldId))).toEqual(revisionsBeforeRetry)
    },
  )

  it('query and recover refuse retry at the seven-day draft retention boundary without writing', async () => {
    vi.useFakeTimers({ now: NOW })
    const worldId = 'a86-expired-draft'
    const { fixture } = await seed(worldId)
    const accessContext = access()
    const { draft, requestId, request: requestBefore } = await createKnownNotCommitted(fixture, worldId, accessContext)
    const currentBefore = await readCurrentScene(fixture.db, worldId)
    const historyBefore = await readSceneVersion(fixture.db, worldId, 1)
    const revisionsBefore = await fixture.db.select().from(worldSceneRevisions)
      .where(eq(worldSceneRevisions.worldId, worldId))
    const storedDraft = await fixture.db.select().from(sceneCompatibilityDrafts)
      .where(eq(sceneCompatibilityDrafts.id, draft.id)).get()
    expect(storedDraft?.updatedAt).toBe(NOW.toISOString())
    vi.setSystemTime(new Date(NOW.getTime() + COMPATIBILITY_DRAFT_RETENTION_MS))
    const retryInput = {
      ...ACTOR, worldId, requestId, draftId: draft.id,
      expectedCurrentVersion: 1, expectedAttempt: 1, access: accessContext, control: control(),
    }

    const queried = await readCompatibilityRequest(fixture.db, retryInput)
    const recovered = await recoverCompatibilityRequest(fixture.db, retryInput)

    for (const view of [queried, recovered]) {
      expect(view.status).toBe('not-committed')
      if (view.status !== 'not-committed' || !('error' in view)) throw new Error('expected expired-draft failure')
      expect(view.retryAllowed).toBe(false)
      expect(view.error.code).toBe('draft-unavailable')
      expect(view.error.action).toBe('recheck')
    }
    expect(await fixture.db.select().from(sceneCompatibilityRequests)
      .where(eq(sceneCompatibilityRequests.requestId, requestId)).get()).toEqual(requestBefore)
    expect(await readCurrentScene(fixture.db, worldId)).toEqual(currentBefore)
    expect(await readSceneVersion(fixture.db, worldId, 1)).toEqual(historyBefore)
    expect(await fixture.db.select().from(worldSceneRevisions)
      .where(eq(worldSceneRevisions.worldId, worldId))).toEqual(revisionsBefore)
  })
})
