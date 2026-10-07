import { describe, expect, it } from 'vitest'
import { applyEdits, createEmptyWorld, serialize, type SerializedVoxelDocument } from '@possibility/voxel-contract'
import app from '../index'
import { guestSessions, timelineSceneRevisions, timelines } from '../db/schema'
import { hashGuestToken } from '../access/middleware'
import { createWorldFixture } from '../test/world-fixture'
import { loadMapBootstrap } from './bootstrap'
import { saveMapResume } from './resume'
import { commitTimelineScene } from '../scenes/repository'
import { eq } from 'drizzle-orm'

function mapScene(block: 'grass' | 'stone'): SerializedVoxelDocument {
  const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'map-bootstrap-scope')
  return JSON.parse(serialize(applyEdits(base, [{ kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block }]).document))
}

describe('map bootstrap', () => {
  it('serves a guest bootstrap only for its current sandbox and restores guest resume state', async () => {
    const fixture = await createWorldFixture()
    const now = '2026-09-21T08:00:00.000Z'
    await fixture.db.insert(guestSessions).values({
      id: 'guest-session', tokenHash: await hashGuestToken('guest-token'), ownerUserId: 'owner',
      currentSandboxWorldId: 'home-world', generation: 0, status: 'active',
      expiresAt: '2099-01-01T00:00:00.000Z', createdAt: now, updatedAt: now,
    })
    const headers = { 'X-Possibility-Guest': 'guest-token' }
    const bootstrap = await app.request('/api/worlds/home-world/map/bootstrap', { headers }, fixture.env)
    expect(bootstrap.status).toBe(200)
    expect(await bootstrap.json()).toMatchObject({
      access: { observe: true, participate: true, editScene: false, persist: false },
      scene: { status: 'missing' },
      resume: { worldId: 'home-world', timelineId: 'home-main', spaceId: 'exterior', mode: 'life' },
    })
    expect((await app.request('/api/worlds/other-world/map/bootstrap', { headers }, fixture.env)).status).toBe(404)

    const saved = await app.request('/api/worlds/home-world/map/resume', {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timelineId: 'home-main', spaceId: 'exterior', mode: 'possibility' }),
    }, fixture.env)
    expect(saved.status).toBe(200)
    const restored = await app.request('/api/worlds/home-world/map/bootstrap', { headers }, fixture.env)
    expect(await restored.json()).toMatchObject({
      resume: { worldId: 'home-world', timelineId: 'home-main', spaceId: 'exterior', mode: 'possibility' },
    })
    const crossWorldResume = await app.request('/api/worlds/other-world/map/resume', {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timelineId: 'other-main', spaceId: 'exterior', mode: 'life' }),
    }, fixture.env)
    expect(crossWorldResume.status).toBe(404)
    fixture.close()
  })

  it('returns world-backed presentation only to its owner', async () => {
    const fixture = await createWorldFixture()
    const own = await loadMapBootstrap(fixture.db, 'home-world', 'owner')
    expect(own?.world?.world.id).toBe('home-world')
    expect(own?.scene.status).toBe('missing')
    expect(own?.presentation.locations.map(location => location.name)).toEqual(['Cafe', 'Library'])
    expect(await loadMapBootstrap(fixture.db, 'home-world', 'other')).toBeNull()
    expect(await loadMapBootstrap(fixture.db, 'missing-world', 'owner')).toBeNull()
  })

  it('fails closed when the selected timeline does not belong to the world', async () => {
    const fixture = await createWorldFixture()
    expect(await loadMapBootstrap(fixture.db, 'home-world', 'owner', 'other-main')).toBeNull()
  })

  it('anchors bootstrap geometry to the selected line and never borrows main geometry for an empty child', async () => {
    const fixture = await createWorldFixture()
    const { db } = fixture
    const now = '2026-09-21T08:00:00.000Z'
    const mainV1 = await commitTimelineScene(db, { worldId: 'home-world', timelineId: 'home-main', expectedVersion: 0,
      requestId: 'bootstrap-main-v1', document: mapScene('grass'), summary: 'main root', kind: 'initial' })
    await db.update(timelineSceneRevisions).set({ createdAt: '2026-09-01T00:00:00.000Z' }).where(eq(timelineSceneRevisions.id, mainV1.id))
    await db.insert(timelines).values([
      { id: 'bootstrap-child', worldId: 'home-world', parentTimelineId: 'home-main', simNow: now, createdAt: '2026-09-02T00:00:00.000Z' },
      { id: 'bootstrap-empty-child', worldId: 'home-world', parentTimelineId: 'home-main', simNow: now, createdAt: '2026-09-02T00:00:00.000Z' },
    ])
    await commitTimelineScene(db, { worldId: 'home-world', timelineId: 'bootstrap-child', expectedVersion: 0,
      requestId: 'bootstrap-child-v1', document: mainV1.document, summary: 'fork snapshot', kind: 'fork-restore' })
    await commitTimelineScene(db, { worldId: 'home-world', timelineId: 'home-main', expectedVersion: 1,
      requestId: 'bootstrap-main-v2', document: mapScene('stone'), summary: 'main later', kind: 'voxel-edit' })

    const child = await loadMapBootstrap(db, 'home-world', 'owner', 'bootstrap-child')
    expect(child?.scene).toMatchObject({ status: 'ready', document: mainV1.document })
    const emptyChild = await loadMapBootstrap(db, 'home-world', 'owner', 'bootstrap-empty-child')
    expect(emptyChild?.scene).toEqual({ status: 'missing' })
    const main = await loadMapBootstrap(db, 'home-world', 'owner')
    expect(main?.scene).toMatchObject({ status: 'ready', document: mapScene('stone') })
    fixture.close()
  })

  it('persists and restores the last valid map context for its owner', async () => {
    const fixture = await createWorldFixture()
    expect(await saveMapResume(fixture.db, { userId: 'owner', worldId: 'home-world', timelineId: 'home-main', spaceId: 'exterior', mode: 'possibility' })).toBe(true)
    expect(await saveMapResume(fixture.db, { userId: 'other', worldId: 'home-world', timelineId: 'home-main', spaceId: 'exterior', mode: 'life' })).toBe(false)
    const restored = await loadMapBootstrap(fixture.db, 'home-world', 'owner')
    expect(restored?.resume).toMatchObject({ timelineId: 'home-main', spaceId: 'exterior', mode: 'possibility' })
  })
})
