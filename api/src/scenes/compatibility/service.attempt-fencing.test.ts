import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  createEmptyWorld,
  setBlockMut,
  serialize,
  type SerializedVoxelDocument,
  type SceneWorkControl,
} from '@possibility/voxel-contract'
import { createTestDb } from '../../test/db'
import {
  sceneCompatibilityRequests,
  users,
  worldSceneRevisions,
  worlds,
} from '../../db/schema'
import { commitScene, readCurrentScene } from '../repository'
import { confirmCompatibility, createCompatibilityDraft, recoverCompatibilityRequest } from './service'
import type { SceneValidationAccess } from './context'

const ACTOR = { actorKey: 'actor-fencing', userId: 'u' }
const WORLD = 'attempt-fencing-world'
const REQUEST = 'attempt-fencing-request'
const NOW = '2026-10-05T00:00:00.000Z'

const control = (): Partial<SceneWorkControl> => ({
  signal: new AbortController().signal,
  nowMs: () => 0,
  yieldControl: async () => {},
})

const access = (): SceneValidationAccess => ({
  bindings: {
    personIds: [], locations: [], protectedObjects: [], protectedPlacements: [],
    locationBindings: [], personBindings: [], entries: [],
  },
})

function collisionDocument(): SerializedVoxelDocument {
  const doc = createEmptyWorld({ width: 4, height: 3, depth: 4 }, 'mist-manor', 'attempt-fencing-seed')
  for (let z = 0; z < 4; z += 1) for (let x = 0; x < 4; x += 1) setBlockMut(doc, { x, y: 0, z }, 'grass')
  doc.assetPlacements = [{ id: 'asset-1', assetId: 'veg-flower-a', anchor: [1, 0, 1], rotation: 0, seed: 1 }]
  doc.objects.push({ id: 'keeper', objectType: 'stone-lantern', anchor: { x: 1, y: 0, z: 1 }, rotation: 0 })
  doc.objectCells.push({ objectId: 'keeper', cells: [{ x: 1, y: 0, z: 1 }, { x: 1, y: 1, z: 1 }] })
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

describe('scene compatibility A8.4 service attempt fencing', () => {
  const fixtures: ReturnType<typeof createTestDb>[] = []
  afterEach(() => { fixtures.splice(0).forEach(f => f.close()) })

  it('recovers while attempt 0 is in its save batch, then permits the same request at server-issued attempt 1 after it exits', async () => {
    const f = createTestDb()
    fixtures.push(f)
    await f.db.insert(users).values({ id: 'u', username: 'u', passwordHash: 'x', createdAt: NOW })
    await f.db.insert(worlds).values({ id: WORLD, userId: 'u', name: 'attempt fencing', description: '' })
    const seeded = await commitScene(f.db, {
      worldId: WORLD, expectedVersion: 0, requestId: 'attempt-fencing-seed',
      document: collisionDocument(), summary: 'seed', kind: 'initial',
    })
    const draft = await createCompatibilityDraft(f.db, {
      ...ACTOR, worldId: WORLD, draftRequestId: 'attempt-fencing-draft', purpose: 'repair-current',
      target: { kind: 'current' }, expectedCurrentVersion: seeded.version, access: access(), control: control(),
    })
    if (draft.status !== 'ready') throw new Error('A8.4 draft fixture must be ready')

    let reachedBatch!: () => void
    let releaseBatch!: () => void
    const atBatch = new Promise<void>(resolve => { reachedBatch = resolve })
    const held = new Promise<void>(resolve => { releaseBatch = resolve })
    let delayed = false
    const delayedDb = new Proxy(f.db, {
      get(target, property, receiver) {
        if (property === 'batch') return async (statements: Parameters<typeof f.db.batch>[0]) => {
          if (!delayed) {
            delayed = true
            reachedBatch()
            await held
          }
          const batch = Reflect.get(target, property, target) as typeof f.db.batch
          return batch.call(target, statements)
        }
        return Reflect.get(target, property, receiver)
      },
    }) as typeof f.db

    const confirmInput = {
      ...ACTOR, worldId: WORLD, draftId: draft.id, requestId: REQUEST,
      expectedCurrentVersion: seeded.version, expectedAttempt: 0, access: access(), control: control(),
    }
    const oldAttempt = confirmCompatibility(delayedDb, confirmInput)
    try {
      await atBatch
      await f.db.update(sceneCompatibilityRequests).set({ leaseUntil: '2000-01-01T00:00:00.000Z' })
        .where(eq(sceneCompatibilityRequests.requestId, REQUEST))

      const recovered = await recoverCompatibilityRequest(f.db, {
        ...confirmInput, expectedAttempt: 1,
      })
      expect(recovered).toMatchObject({ status: 'not-committed', attempt: 0, nextAttempt: 1, retryAllowed: true })

      await expect(confirmCompatibility(f.db, { ...confirmInput, expectedAttempt: 1 }))
        .rejects.toMatchObject({ code: 'service-busy' })
      expect(await readCurrentScene(f.db, WORLD)).toEqual(seeded)
      expect((await f.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, WORLD))).length).toBe(1)
    } finally {
      releaseBatch()
    }

    const oldResult = await oldAttempt
    expect(oldResult.status).toBe('not-committed')
    expect(await readCurrentScene(f.db, WORLD)).toEqual(seeded)
    expect((await f.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, WORLD))).length).toBe(1)

    const retry = await confirmCompatibility(f.db, { ...confirmInput, expectedAttempt: 1 })
    expect(retry.status).toBe('completed')
    if (retry.status !== 'completed') return
    expect(retry.attempt).toBe(1)
    expect(retry.result.version).toBe(2)
    expect((await f.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, WORLD))).length).toBe(2)
    expect(await f.db.select().from(sceneCompatibilityRequests).where(eq(sceneCompatibilityRequests.requestId, REQUEST)).get())
      .toMatchObject({ state: 'completed', attempt: 1, resultVersion: 2 })
  })
})
