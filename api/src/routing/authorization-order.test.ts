import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { guestSessions, persons, users, worldPersons, worldVisitSessions, worlds } from '../db/schema'
import type { Env } from '../index'
import { chatRoutes } from '../chat/routes'
import { hashGuestToken } from '../access/middleware'
import { lifeRoutes } from '../life/routes'
import { comparisonRoutes } from '../life/compare'
import { mapRoutes } from '../map/routes'
import { memoryRoutes } from '../memories/routes'
import { personRoutes } from '../persons/routes'
import { publicRoutes } from '../public/routes'
import { provenanceRoutes } from '../provenance/routes'
import { sceneRoutes } from '../scene/routes'
import { compatibilityRoutes } from '../scenes/compatibility/routes'
import { scenesRoutes } from '../scenes/routes'
import { timelineRoutes } from '../timelines/routes'
import { worldsRoutes } from '../worlds/routes'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'

type RootApp = Hono<{ Bindings: Env }>
type Fixture = Awaited<ReturnType<typeof createWorldFixture>>
type Mount = (app: RootApp) => unknown

const mounts: Mount[] = [
  app => app.route('/api/public', publicRoutes),
  app => app.route('/api', scenesRoutes),
  app => app.route('/api', sceneRoutes),
  app => app.route('/api', compatibilityRoutes),
  app => app.route('/api', mapRoutes),
  app => app.route('/api/worlds', worldsRoutes),
  app => app.route('/api/persons', personRoutes),
  app => app.route('/api', chatRoutes),
  app => app.route('/api', timelineRoutes),
  app => app.route('/api', lifeRoutes),
  app => app.route('/api', comparisonRoutes),
  app => app.route('/api', memoryRoutes),
  app => app.route('/api', provenanceRoutes),
]

function createOrderedApp(reverse: boolean): RootApp {
  const app = new Hono<{ Bindings: Env }>()
  for (const mount of reverse ? [...mounts].reverse() : mounts) mount(app)
  return app
}

for (const [order, reverse] of [['normal', false], ['reversed', true]] as const) {
  describe(`API authorization is stable with ${order} router registration`, () => {
    let fixture: Fixture
    let app: RootApp

    beforeEach(async () => {
      fixture = await createWorldFixture()
      app = createOrderedApp(reverse)
      await fixture.db.update(worlds).set({ isDemo: true }).where(eq(worlds.id, 'home-world'))
      await fixture.db.insert(users).values({
        id: 'expired-owner', username: 'expired-owner', passwordHash: 'unused', createdAt: WORLD_TIME,
      })
      await fixture.db.insert(persons).values({
        id: 'resident', userId: 'owner', name: 'Resident', modelJson: JSON.stringify({
          identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [],
        }), createdAt: WORLD_TIME,
      })
      await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
      await fixture.db.insert(guestSessions).values([
        {
          id: 'guest-home', tokenHash: await hashGuestToken('guest-home-token'), ownerUserId: 'owner',
          currentSandboxWorldId: 'home-world', generation: 0, status: 'active', expiresAt: '2099-01-01T00:00:00.000Z',
          createdAt: WORLD_TIME, updatedAt: WORLD_TIME,
        },
        {
          id: 'guest-other', tokenHash: await hashGuestToken('guest-other-token'), ownerUserId: 'other',
          currentSandboxWorldId: 'other-world', generation: 0, status: 'active', expiresAt: '2099-01-01T00:00:00.000Z',
          createdAt: WORLD_TIME, updatedAt: WORLD_TIME,
        },
        {
          id: 'guest-expired', tokenHash: await hashGuestToken('guest-expired-token'), ownerUserId: 'expired-owner',
          currentSandboxWorldId: null, generation: 0, status: 'active', expiresAt: '2000-01-01T00:00:00.000Z',
          createdAt: WORLD_TIME, updatedAt: WORLD_TIME,
        },
      ])
    })

    afterEach(() => fixture.close())

    const request = (path: string, init: RequestInit = {}) => app.request(path, init, fixture.env)
    const owner = { Authorization: 'Bearer owner-token' }
    const guest = { 'X-Possibility-Guest': 'guest-home-token' }
    const otherGuest = { 'X-Possibility-Guest': 'guest-other-token' }
    const expiredGuest = { 'X-Possibility-Guest': 'guest-expired-token' }

    it('keeps public, owner, guest, anonymous and account-only route behavior at its owner', async () => {
      expect((await request('/api/public/demo')).status).toBe(200)
      expect((await request('/api/public/not-a-route')).status).toBe(404)
      expect((await request('/api/public/worlds/home-world?timelineId=home-main')).status).toBe(200)

      expect((await request('/api/worlds/home-world', { headers: owner })).status).toBe(200)
      expect((await request('/api/worlds/other-world', { headers: owner })).status).toBe(404)
      expect((await request('/api/worlds/home-world')).status).toBe(401)
      expect((await request('/api/worlds/home-world/time-zone', { headers: guest })).status).toBe(200)
      expect((await request('/api/worlds/other-world/time-zone', { headers: guest })).status).toBe(404)
      expect((await request('/api/worlds/home-world/time-zone', { headers: expiredGuest })).status).toBe(401)
      expect((await request('/api/worlds/home-world/time-zone', { headers: { ...owner, ...otherGuest } })).status).toBe(404)

      expect((await request('/api/worlds/home-world/map/bootstrap', { headers: guest })).status).toBe(200)
      expect((await request('/api/worlds/home-world/map/bootstrap')).status).toBe(404)
      expect((await request('/api/worlds/other-world/map/bootstrap', { headers: owner })).status).toBe(404)
      expect((await request('/api/worlds/home-world/map/bootstrap', { headers: { ...owner, ...otherGuest } })).status).toBe(404)
      expect((await request('/api/worlds/home-world/map/bootstrap', { headers: expiredGuest })).status).toBe(401)

      const rootScene = await request('/api/worlds/home-world/scene?timelineId=home-main&representation=voxel', { headers: guest })
      expect(rootScene.status).toBe(200)
      expect(await rootScene.json()).toMatchObject({ status: 'missing' })
      expect((await request('/api/worlds/home-world/scene', { headers: owner })).status).toBe(200)
      expect((await request('/api/worlds/home-world/scene')).status).toBe(401)
      expect((await request('/api/worlds/other-world/scene', { headers: owner })).status).toBe(404)
      expect((await request('/api/worlds/home-world/scene', { headers: { ...owner, ...otherGuest } })).status).toBe(404)

      expect((await request('/api/worlds/home-world/scene/history?timelineId=home-main', { headers: guest })).status).toBe(400)
      expect((await request('/api/worlds/home-world/scene/history?timelineId=home-main')).status).toBe(401)
      expect((await request('/api/worlds/other-world/scene/history?timelineId=other-main', { headers: owner })).status).toBe(404)
      expect((await request('/api/worlds/home-world/scene/history?timelineId=home-main', { headers: { ...owner, ...otherGuest } })).status).toBe(404)

      const compatibility = '/api/worlds/home-world/scene/compatibility/inspection?timelineId=home-main&representation=voxel'
      expect((await request(compatibility, { headers: guest })).status).toBe(401)
      const compatibilityAsOwner = await request(compatibility, { headers: owner })
      expect(compatibilityAsOwner.status).toBe(404)
      expect(await compatibilityAsOwner.clone().json()).toMatchObject({ errorCode: 'scene-missing' })
      const compatibilityWithBoth = await request(compatibility, { headers: { ...owner, ...otherGuest } })
      expect(await compatibilityWithBoth.json()).toEqual(await compatibilityAsOwner.json())

      expect((await request('/api/conversations/missing/messages', { headers: guest })).status).toBe(401)
      const chatAsOwner = await request('/api/conversations/missing/messages', { headers: owner })
      expect(chatAsOwner.status).toBe(404)
      const chatWithBoth = await request('/api/conversations/missing/messages', { headers: { ...owner, ...otherGuest } })
      expect(await chatWithBoth.json()).toEqual(await chatAsOwner.json())
      expect((await request('/api/timelines/missing', { headers: guest })).status).toBe(401)
      const timelineAsOwner = await request('/api/timelines/missing', { headers: owner })
      expect(timelineAsOwner.status).toBe(404)
      const timelineWithBoth = await request('/api/timelines/missing', { headers: { ...owner, ...otherGuest } })
      expect(await timelineWithBoth.json()).toEqual(await timelineAsOwner.json())
      expect((await request('/api/worlds/home-world/return', { headers: guest })).status).toBe(401)
      expect((await request('/api/worlds/home-world/return', { headers: owner })).status).toBe(200)
      expect((await request('/api/worlds/home-world/return', { headers: { ...owner, ...otherGuest } })).status).toBe(200)
      expect((await request('/api/worlds/other-world/return', { headers: owner })).status).toBe(404)

      expect((await request('/api/worlds/home-world/provenance/evidence?timelineId=home-main&residentId=resident')).status).toBe(403)
      expect((await request('/api/worlds/home-world/provenance/evidence?timelineId=home-main&residentId=resident', { headers: owner })).status).toBe(200)
      expect((await request('/api/worlds/home-world/provenance/evidence?timelineId=home-main&residentId=resident', { headers: guest })).status).toBe(200)
      expect((await request('/api/worlds/home-world/provenance/evidence?timelineId=home-main&residentId=resident', { headers: { ...owner, ...otherGuest } })).status).toBe(404)
      expect((await request('/api/worlds/home-world/provenance/evidence?timelineId=home-main&residentId=resident', { headers: expiredGuest })).status).toBe(401)
    })

    it('returns 404 for unowned and unknown paths, and denied guest visits write nothing', async () => {
      expect((await request('/api/worlds/home-world/not-a-route')).status).toBe(404)
      expect((await request('/api/worlds/home-world/scene/not-a-route')).status).toBe(404)
      expect((await request('/api/conversations/not-a-route')).status).toBe(404)
      expect((await request('/api/public/not-a-route')).status).toBe(404)

      for (const [headers, status] of [[otherGuest, 404], [expiredGuest, 401], [{}, 401]] as const) {
        const denied = await request('/api/worlds/home-world/visits/enter', {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ timelineId: 'home-main', clientSessionId: 'denied', requestId: 'denied' }),
        })
        expect(denied.status).toBe(status)
      }
      expect(await fixture.db.select().from(worldVisitSessions)).toEqual([])
    })
  })
}
