import { afterEach, expect, it } from 'vitest'
import { createEmptyWorld, serialize, type SerializedVoxelDocument } from '@possibility/voxel-contract'
import { eq } from 'drizzle-orm'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { persons, timelines, worldPersons, worldSceneRevisions, worldScenes } from '../db/schema'
import { commitTimelineScene } from './repository'
import { scenesRoutes } from './routes'
import { readSceneRepairContext } from './repair'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }

function scene(): SerializedVoxelDocument {
  return JSON.parse(serialize(createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'repair-scope')))
}

async function seedRepairContext() {
  fixture = await createWorldFixture()
  const { db } = fixture
  await db.insert(persons).values({ id: 'repair-resident', userId: 'owner', name: 'Repair resident', modelJson: '{}', createdAt: WORLD_TIME })
  await db.insert(worldPersons).values({ worldId: 'home-world', personId: 'repair-resident', joinedAt: WORLD_TIME })
  return fixture
}

it('bridges legacy scene reads only for omitted timeline scope and returns stable revision ids', async () => {
  const { db, env } = await seedRepairContext()
  await db.insert(worldSceneRevisions).values({ id: 'legacy-repair-scene-v1', worldId: 'home-world', version: 1,
    parentVersion: null, requestId: 'legacy-repair-scene', contentHash: 'legacy-hash', documentJson: JSON.stringify(scene()),
    summary: 'legacy', kind: 'initial', createdAt: WORLD_TIME })
  await db.insert(worldScenes).values({ worldId: 'home-world', currentVersion: 1, themeId: 'mist-manor', updatedAt: WORLD_TIME })

  const implicit = await readSceneRepairContext(db, 'owner', 'home-world')
  expect(implicit).toMatchObject({ sceneStatus: 'ready', revisionId: 'legacy-repair-scene-v1', scope: { timelineId: 'home-main' } })
  const current = await scenesRoutes.request('/worlds/home-world/scene', { headers }, env)
  expect(current.status).toBe(200)
  expect(await current.json()).toMatchObject({ status: 'ready', id: 'legacy-repair-scene-v1', revisionId: 'legacy-repair-scene-v1' })
  const implicitHistory = await scenesRoutes.request('/worlds/home-world/scene/revisions', { headers }, env)
  expect(await implicitHistory.json()).toMatchObject({ revisions: [{ version: 1, kind: 'initial' }] })
  const explicitHistory = await scenesRoutes.request('/worlds/home-world/scene/revisions?timelineId=home-main', { headers }, env)
  expect(await explicitHistory.json()).toMatchObject({ scope: { timelineId: 'home-main' }, revisions: [] })
  const implicitVersion = await scenesRoutes.request('/worlds/home-world/scene/revisions/1', { headers }, env)
  expect(implicitVersion.status).toBe(200)
  expect(await implicitVersion.json()).toMatchObject({ id: 'legacy-repair-scene-v1', revisionId: 'legacy-repair-scene-v1', version: 1 })
  const explicitVersion = await scenesRoutes.request('/worlds/home-world/scene/revisions/legacy-repair-scene-v1?timelineId=home-main', { headers }, env)
  expect(explicitVersion.status).toBe(404)

  const explicitMain = await readSceneRepairContext(db, 'owner', 'home-world', { timelineId: 'home-main' })
  expect(explicitMain).toMatchObject({ sceneStatus: 'missing', revisionId: null, scope: { timelineId: 'home-main' } })
  const currentForUnknown = await scenesRoutes.request('/worlds/home-world/scene?timelineId=missing', { headers }, env)
  expect(currentForUnknown.status).toBe(404)
  const unknown = await scenesRoutes.request('/worlds/home-world/scene/repair-context?timelineId=missing', { headers }, env)
  expect(unknown.status).toBe(404)
  expect((await unknown.json())).toMatchObject({ errorCode: 'timeline-missing' })
  const unknownDraft = await scenesRoutes.request('/worlds/home-world/scene/repair-draft', { method: 'POST', headers,
    body: JSON.stringify({ requestId: 'unknown-repair-draft', prompt: 'garden', timelineId: 'missing' }) }, env)
  expect(unknownDraft.status).toBe(404)
  expect(await unknownDraft.json()).toMatchObject({ errorCode: 'timeline-missing' })
})

it('reads timeline current scene for repair status, exposes revisionId, and refuses archived draft writes', async () => {
  const { db, env } = await seedRepairContext()
  const revision = await commitTimelineScene(db, { worldId: 'home-world', timelineId: 'home-main', expectedVersion: 0,
    requestId: 'repair-scoped-current', document: scene(), summary: 'scene', kind: 'initial' })
  const ready = await scenesRoutes.request('/worlds/home-world/scene', { headers }, env)
  expect(ready.status).toBe(200)
  expect(await ready.json()).toMatchObject({ status: 'ready', id: revision.id, revisionId: revision.id })
  const repair = await scenesRoutes.request('/worlds/home-world/scene/repair-context', { headers }, env)
  expect(repair.status).toBe(409)
  expect(await repair.json()).toMatchObject({ errorCode: 'scene_exists' })
  expect(await readSceneRepairContext(db, 'owner', 'home-world')).toMatchObject({ sceneStatus: 'ready', revisionId: revision.id })

  await db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, 'home-main'))
  const archivedRead = await readSceneRepairContext(db, 'owner', 'home-world', { timelineId: 'home-main' })
  expect(archivedRead).toMatchObject({ timelineStatus: 'archived', sceneStatus: 'ready', revisionId: revision.id })
  const draft = await scenesRoutes.request('/worlds/home-world/scene/repair-draft', { method: 'POST', headers,
    body: JSON.stringify({ requestId: 'archived-repair-draft', prompt: 'add a garden', timelineId: 'home-main' }) }, env)
  expect(draft.status).toBe(409)
  expect(await draft.json()).toMatchObject({ errorCode: 'timeline-archived' })
})
