import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyEdits, createEmptyWorld, serialize, type SerializedVoxelDocument } from '@possibility/voxel-contract'
import { compatibilityRoutes } from './routes'
import { commitScene, readCurrentScene } from '../repository'
import { createWorldFixture } from '../../test/world-fixture'
import { sceneCompatibilityRequests, worldSceneRevisions, worlds } from '../../db/schema'

const owner = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }

function repairableEnvelope(): SerializedVoxelDocument {
  const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'retry-expiry-route')
  const doc = applyEdits(base, [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
    { kind: 'place-object', objectId: 'lantern', objectType: 'stone-lantern', anchor: { x: 2, y: 1, z: 2 }, rotation: 0 },
    { kind: 'place-asset', assetId: 'veg-flower-a', placementId: 'flower', anchor: { x: 2, y: 1, z: 2 }, rotation: 0 },
  ]).document
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

describe('A8.6 request permission change', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createWorldFixture>>> = []
  afterEach(() => fixtures.splice(0).forEach(fixture => fixture.close()))

  it('denies query and recover after world ownership changes and preserves the not-committed request', async () => {
    const fixture = await createWorldFixture()
    fixtures.push(fixture)
    const seeded = await commitScene(fixture.db, {
      worldId: 'home-world', expectedVersion: 0, requestId: 'a86-permission-seed',
      document: repairableEnvelope(), summary: 'retry permission source', kind: 'initial',
    })
    const base = '/worlds/home-world/scene/compatibility'
    const createdResponse = await compatibilityRoutes.request(`${base}/drafts`, {
      method: 'POST', headers: owner,
      body: JSON.stringify({
        draftRequestId: 'a86-permission-draft', purpose: 'repair-current',
        target: { kind: 'current' }, expectedCurrentVersion: 1,
      }),
    }, fixture.env)
    expect(createdResponse.status).toBe(200)
    const draft = await createdResponse.json() as { id: string; status: string }
    expect(draft.status).toBe('ready')

    const requestId = 'a86-permission-request'
    const initialRecovery = await compatibilityRoutes.request(`${base}/requests/${requestId}/recover`, {
      method: 'POST', headers: owner,
      body: JSON.stringify({ draftId: draft.id, expectedCurrentVersion: 1, expectedAttempt: 0 }),
    }, fixture.env)
    expect(initialRecovery.status).toBe(200)
    expect(await initialRecovery.json()).toMatchObject({
      status: 'not-committed', attempt: 0, nextAttempt: 1, retryAllowed: true,
    })
    const requestBefore = await fixture.db.select().from(sceneCompatibilityRequests)
      .where(eq(sceneCompatibilityRequests.requestId, requestId)).get()
    expect(requestBefore).toMatchObject({ state: 'not-committed', attempt: 0, resultVersion: null })

    await fixture.db.update(worlds).set({ userId: 'other' }).where(eq(worlds.id, 'home-world'))
    const rowsBeforeRetry = await fixture.db.select().from(worldSceneRevisions)
      .where(eq(worldSceneRevisions.worldId, 'home-world'))
    const queried = await compatibilityRoutes.request(`${base}/requests/${requestId}`, { headers: owner }, fixture.env)
    const recovered = await compatibilityRoutes.request(`${base}/requests/${requestId}/recover`, {
      method: 'POST', headers: owner,
      body: JSON.stringify({ draftId: draft.id, expectedCurrentVersion: 1, expectedAttempt: 1 }),
    }, fixture.env)

    expect(queried.status).toBe(404)
    expect(recovered.status).toBe(404)
    expect(await fixture.db.select().from(sceneCompatibilityRequests)
      .where(eq(sceneCompatibilityRequests.requestId, requestId)).get()).toEqual(requestBefore)
    expect(await readCurrentScene(fixture.db, 'home-world')).toEqual(seeded)
    expect(await fixture.db.select().from(worldSceneRevisions)
      .where(eq(worldSceneRevisions.worldId, 'home-world'))).toEqual(rowsBeforeRetry)
  })
})
