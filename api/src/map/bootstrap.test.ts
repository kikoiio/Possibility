import { describe, expect, it } from 'vitest'
import app from '../index'
import { guestSessions } from '../db/schema'
import { hashGuestToken } from '../access/middleware'
import { createWorldFixture } from '../test/world-fixture'
import { loadMapBootstrap } from './bootstrap'
import { saveMapResume } from './resume'

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

  it('persists and restores the last valid map context for its owner', async () => {
    const fixture = await createWorldFixture()
    expect(await saveMapResume(fixture.db, { userId: 'owner', worldId: 'home-world', timelineId: 'home-main', spaceId: 'exterior', mode: 'possibility' })).toBe(true)
    expect(await saveMapResume(fixture.db, { userId: 'other', worldId: 'home-world', timelineId: 'home-main', spaceId: 'exterior', mode: 'life' })).toBe(false)
    const restored = await loadMapBootstrap(fixture.db, 'home-world', 'owner')
    expect(restored?.resume).toMatchObject({ timelineId: 'home-main', spaceId: 'exterior', mode: 'possibility' })
  })
})
