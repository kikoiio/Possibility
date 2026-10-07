import { afterEach, expect, it } from 'vitest'
import { applyEdits, createEmptyWorld, serialize, type SerializedVoxelDocument } from '@possibility/voxel-contract'
import { eq } from 'drizzle-orm'
import { commitTimelineScene } from './repository'
import { scenesRoutes } from './routes'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { timelineSceneHeads, timelineSceneRevisions, timelines } from '../db/schema'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

function scene(block: 'grass' | 'stone'): SerializedVoxelDocument {
  const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'timeline-route')
  const document = applyEdits(base, [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block },
  ]).document
  return JSON.parse(serialize(document)) as SerializedVoxelDocument
}

function worldScene(block: 'grass' | 'stone', shift = 0): SerializedVoxelDocument {
  const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'timeline-write')
  const doc = applyEdits(base, [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block },
    { kind: 'place-object', objectId: 'cafe-marker', objectType: 'stone-lantern', anchor: { x: 3 + shift, y: 1, z: 3 }, rotation: 0 },
    { kind: 'place-object', objectId: 'library-marker', objectType: 'stone-lantern', anchor: { x: 9 + shift, y: 1, z: 9 }, rotation: 0 },
  ]).document
  return JSON.parse(serialize({ ...doc, locations: [
    { name: 'Cafe', objectId: 'cafe-marker' }, { name: 'Library', objectId: 'library-marker' },
  ] })) as SerializedVoxelDocument
}

const headers = { Authorization: 'Bearer owner-token' }

it('reads only the authorized timeline scope and never falls back for an explicit unknown timeline', async () => {
  fixture = await createWorldFixture()
  const { db, env } = fixture
  const forkCreatedAt = new Date(Date.now() + 1_000).toISOString()
  await db.insert(timelines).values([
    { id: 'home-child', worldId: 'home-world', parentTimelineId: 'home-main', simNow: WORLD_TIME, createdAt: forkCreatedAt },
    { id: 'home-sibling', worldId: 'home-world', parentTimelineId: 'home-main', simNow: WORLD_TIME, createdAt: forkCreatedAt },
  ])
  const root = await commitTimelineScene(db, { worldId: 'home-world', timelineId: 'home-main', expectedVersion: 0,
    requestId: 'route-root-v1', document: scene('grass'), summary: 'root', kind: 'initial' })
  await commitTimelineScene(db, { worldId: 'home-world', timelineId: 'home-child', expectedVersion: 0,
    requestId: 'route-child-fork-v1', document: root.document, summary: 'fork snapshot', kind: 'fork-restore' })
  const child = await commitTimelineScene(db, { worldId: 'home-world', timelineId: 'home-child', expectedVersion: 1,
    requestId: 'route-child-v1', document: scene('stone'), summary: 'child', kind: 'voxel-edit' })
  await commitTimelineScene(db, { worldId: 'home-world', timelineId: 'home-sibling', expectedVersion: 0,
    requestId: 'route-sibling-v1', document: root.document, summary: 'fork snapshot', kind: 'fork-restore' })

  const mainRead = await scenesRoutes.request('/worlds/home-world/scene', { headers }, env)
  expect(mainRead.status).toBe(200)
  expect(await mainRead.json()).toMatchObject({ status: 'ready', timelineId: 'home-main', id: root.id, version: 1 })

  const childRead = await scenesRoutes.request('/worlds/home-world/scene?timelineId=home-child', { headers }, env)
  expect(childRead.status).toBe(200)
  expect(await childRead.json()).toMatchObject({ status: 'ready', timelineId: 'home-child', id: child.id, version: 2,
    document: scene('stone') })

  const unknown = await scenesRoutes.request('/worlds/home-world/scene?timelineId=missing-line', { headers }, env)
  expect(unknown.status).toBe(404)
  expect(await unknown.json()).toMatchObject({ errorCode: 'timeline-missing' })
  const unknownWrite = await scenesRoutes.request('/worlds/home-world/scene/voxel-revision', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'unknown-line-write', expectedVersion: 0, timelineId: 'missing-line', document: scene('stone') }),
  }, env)
  expect(unknownWrite.status).toBe(404)
  expect(await db.select().from(timelineSceneHeads).where(eq(timelineSceneHeads.timelineId, 'home-main'))).toHaveLength(1)
  expect(await db.select().from(timelines).where(eq(timelines.id, 'home-sibling')).get()).toBeDefined()
})

it('limits scene history and version reads to visible lineage, and allows archived history reads', async () => {
  fixture = await createWorldFixture()
  const { db, env } = fixture
  const forkCreatedAt = new Date(Date.now() + 1_000).toISOString()
  await db.insert(timelines).values([
    { id: 'home-child', worldId: 'home-world', parentTimelineId: 'home-main', simNow: WORLD_TIME, createdAt: forkCreatedAt },
    { id: 'home-sibling', worldId: 'home-world', parentTimelineId: 'home-main', simNow: WORLD_TIME, createdAt: forkCreatedAt },
  ])
  const rootV1 = await commitTimelineScene(db, { worldId: 'home-world', timelineId: 'home-main', expectedVersion: 0,
    requestId: 'route-history-root-v1', document: scene('grass'), summary: 'before fork', kind: 'initial' })
  await db.update(timelineSceneRevisions).set({ createdAt: '2026-10-01T00:00:00.000Z' }).where(eq(timelineSceneRevisions.id, rootV1.id))
  await db.update(timelines).set({ createdAt: '2026-10-02T00:00:00.000Z' }).where(eq(timelines.id, 'home-child'))
  const rootV2 = await commitTimelineScene(db, { worldId: 'home-world', timelineId: 'home-main', expectedVersion: 1,
    requestId: 'route-history-root-v2', document: scene('stone'), summary: 'after fork', kind: 'voxel-edit' })
  await db.update(timelineSceneRevisions).set({ createdAt: '2026-10-03T00:00:00.000Z' }).where(eq(timelineSceneRevisions.id, rootV2.id))
  await commitTimelineScene(db, { worldId: 'home-world', timelineId: 'home-child', expectedVersion: 0,
    requestId: 'route-history-child-fork-v1', document: rootV1.document, summary: 'fork snapshot', kind: 'fork-restore' })
  const childV2 = await commitTimelineScene(db, { worldId: 'home-world', timelineId: 'home-child', expectedVersion: 1,
    requestId: 'route-history-child-v2', document: scene('stone'), summary: 'child edit', kind: 'voxel-edit' })
  await db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, 'home-child'))

  const history = await scenesRoutes.request('/worlds/home-world/scene/revisions?timelineId=home-child&limit=1', { headers }, env)
  expect(history.status).toBe(200)
  expect(await history.json()).toMatchObject({
    revisions: [expect.objectContaining({ revisionId: childV2.id, originTimelineId: 'home-child', origin: 'current' })],
    hasMore: true,
    nextCursor: expect.any(String),
  })
  const visibleAncestor = await scenesRoutes.request(`/worlds/home-world/scene/revisions/${encodeURIComponent(rootV1.id)}?timelineId=home-child`, { headers }, env)
  expect(visibleAncestor.status).toBe(200)
  expect(await visibleAncestor.json()).toMatchObject({ id: rootV1.id, sourceTimelineId: 'home-main', source: 'ancestor' })
  const selectedLineVersion = await scenesRoutes.request('/worlds/home-world/scene/revisions/2?timelineId=home-child', { headers }, env)
  expect(selectedLineVersion.status).toBe(200)
  expect(await selectedLineVersion.json()).toMatchObject({ id: childV2.id, timelineId: 'home-child', version: 2 })
  const invisibleParentFuture = await scenesRoutes.request('/worlds/home-world/scene/revisions?timelineId=home-child', { headers }, env)
  expect(JSON.stringify(await invisibleParentFuture.json())).not.toContain(rootV2.id)
})

it('rejects unsupported representations, unknown spaces, and access to another owner’s timeline', async () => {
  fixture = await createWorldFixture()
  const { db, env } = fixture
  await commitTimelineScene(db, { worldId: 'home-world', timelineId: 'home-main', expectedVersion: 0,
    requestId: 'route-boundary-v1', document: scene('grass'), summary: 'root', kind: 'initial' })

  const unsupported = await scenesRoutes.request('/worlds/home-world/scene?representation=native2d', { headers }, env)
  expect(unsupported.status).toBe(422)
  expect(await unsupported.json()).toMatchObject({ errorCode: 'format-unsupported' })
  const unknownSpace = await scenesRoutes.request('/worlds/home-world/scene?spaceId=not-a-space', { headers }, env)
  expect(unknownSpace.status).toBe(404)
  expect(await unknownSpace.json()).toMatchObject({ errorCode: 'space-missing' })
  const otherOwner = await scenesRoutes.request('/worlds/other-world/scene?timelineId=other-main', { headers }, env)
  expect(otherOwner.status).toBe(404)
})

it('saves within an explicit child scope with CAS and replay, then restores a visible ancestor only', async () => {
  fixture = await createWorldFixture()
  const { db, env } = fixture
  const forkCreatedAt = new Date(Date.now() + 1_000).toISOString()
  await db.insert(timelines).values([
    { id: 'home-child', worldId: 'home-world', parentTimelineId: 'home-main', simNow: WORLD_TIME, createdAt: forkCreatedAt },
    { id: 'home-sibling', worldId: 'home-world', parentTimelineId: 'home-main', simNow: WORLD_TIME, createdAt: forkCreatedAt },
  ])
  const parent = await commitTimelineScene(db, { worldId: 'home-world', timelineId: 'home-main', expectedVersion: 0,
    requestId: 'route-write-parent', document: worldScene('grass'), summary: 'parent', kind: 'initial' })
  await commitTimelineScene(db, { worldId: 'home-world', timelineId: 'home-child', expectedVersion: 0,
    requestId: 'route-write-child-root', document: parent.document, summary: 'fork', kind: 'fork-restore' })
  await commitTimelineScene(db, { worldId: 'home-world', timelineId: 'home-sibling', expectedVersion: 0,
    requestId: 'route-write-sibling-root', document: parent.document, summary: 'fork', kind: 'fork-restore' })

  const save = (requestId: string, expectedVersion: number, document: SerializedVoxelDocument) => scenesRoutes.request(
    '/worlds/home-world/scene/voxel-revision', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, expectedVersion, timelineId: 'home-child', representation: 'voxel', document }) }, env)
  const editedDoc = worldScene('stone', 1)
  const savedResponse = await save('route-child-edit', 1, editedDoc)
  expect(savedResponse.status).toBe(200)
  const saved = await savedResponse.json() as { id: string; version: number; timelineId: string; document: SerializedVoxelDocument }
  expect(saved).toMatchObject({ version: 2, timelineId: 'home-child', document: editedDoc })

  const replay = await save('route-child-edit', 0, saved.document)
  expect(replay.status).toBe(200)
  expect(await replay.json()).toMatchObject({ id: saved.id, version: 2 })
  const stale = await save('route-stale-edit', 1, worldScene('grass', 2))
  expect(stale.status).toBe(409)

  const siblingRead = await scenesRoutes.request('/worlds/home-world/scene?timelineId=home-sibling', { headers }, env)
  expect(await siblingRead.json()).toMatchObject({ status: 'ready', version: 1, document: parent.document })
  const invisible = await scenesRoutes.request(`/worlds/home-world/scene/revisions/${encodeURIComponent(saved.id)}?timelineId=home-sibling`, { headers }, env)
  expect(invisible.status).toBe(404)

  const restore = await scenesRoutes.request('/worlds/home-world/scene/restore', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'route-child-restore-parent', expectedVersion: 2, timelineId: 'home-child', targetRevisionId: parent.id }),
  }, env)
  expect(restore.status).toBe(200)
  expect(await restore.json()).toMatchObject({ timelineId: 'home-child', version: 3, document: parent.document })
  await db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, 'home-child'))
  const archivedRead = await scenesRoutes.request('/worlds/home-world/scene?timelineId=home-child', { headers }, env)
  expect(archivedRead.status).toBe(200)
  expect(await archivedRead.json()).toMatchObject({ status: 'ready', version: 3 })
  const archivedRestore = await scenesRoutes.request('/worlds/home-world/scene/restore', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'route-archived-restore', expectedVersion: 3, timelineId: 'home-child', targetRevisionId: parent.id }),
  }, env)
  expect(archivedRestore.status).toBe(409)
  expect(await archivedRestore.json()).toMatchObject({ errorCode: 'timeline-archived' })
})
