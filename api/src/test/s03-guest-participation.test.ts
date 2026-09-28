import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { createTestDb } from './db'
import { guestSessions, sessions, users, worlds } from '../db/schema'
import { seedDemoWorld } from '../dev/seed-demo'
import { createGuestSession } from '../demo/session-service'

describe('S03 guest participation API', () => {
  it('allows a guest to register, enter and move only inside its sandbox', async () => {
    const fixture = createTestDb()
    await fixture.db.insert(users).values({ id: 'admin', username: 'admin', passwordHash: 'x', createdAt: new Date().toISOString() })
    await seedDemoWorld(fixture.db)
    const guest = await createGuestSession(fixture.db, 'guest-participation')
    const headers = { 'X-Possibility-Guest': guest.token!, 'Content-Type': 'application/json' }
    const personaResponse = await app.request(`/api/worlds/${guest.worldId}/persona?timelineId=${guest.timelineId}`, { headers }, fixture.env)
    expect(personaResponse.status, await personaResponse.clone().text()).toBe(200)
    const stateResponse = await app.request(`/api/worlds/${guest.worldId}/state?timelineId=${guest.timelineId}`, { headers }, fixture.env)
    expect(stateResponse.status).toBe(200)
    const state = await stateResponse.json() as { version: number }
    const moved = await app.request(`/api/worlds/${guest.worldId}/scene/position`, {
      method: 'POST', headers,
      body: JSON.stringify({ timelineId: guest.timelineId, location: '温室花房', commandId: 'guest-enter-greenhouse', expectedVersion: state.version }),
    }, fixture.env)
    expect(moved.status).toBe(200)
    expect(await moved.json()).toMatchObject({ location: '温室花房', version: state.version + 1 })

    const otherWorld = await app.request('/api/worlds/not-this-sandbox/state?timelineId=elsewhere', { headers }, fixture.env)
    expect(otherWorld.status).toBe(404)
    const forbidden = await app.request(`/api/worlds/${guest.worldId}/pause`, { method: 'POST', headers }, fixture.env)
    expect(forbidden.status).toBe(404)
    fixture.close()
  })

  it('claims the active guest sandbox into the authenticated user account', async () => {
    const fixture = createTestDb()
    await fixture.db.insert(users).values({ id: 'admin', username: 'admin', passwordHash: 'x', createdAt: new Date().toISOString() })
    await fixture.db.insert(users).values({ id: 'member', username: 'member', passwordHash: 'x', createdAt: new Date().toISOString() })
    await fixture.db.insert(sessions).values({ token: 'member-token', userId: 'member', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    await seedDemoWorld(fixture.db)
    const guest = await createGuestSession(fixture.db, 'guest-claim-api')
    const response = await app.request('/api/demo/session/claim', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer member-token',
        'X-Possibility-Guest': guest.token!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requestId: 'claim-api-request' }),
    }, fixture.env)
    expect(response.status, await response.clone().text()).toBe(200)
    const result = await response.json() as { worldId: string }
    expect(await fixture.db.select({ id: worlds.id }).from(worlds).where(eq(worlds.id, result.worldId)).get()).toMatchObject({ id: result.worldId })
    expect(await fixture.db.select({ status: guestSessions.status }).from(guestSessions).where(eq(guestSessions.id, guest.sessionId)).get()).toMatchObject({ status: 'claimed' })
    fixture.close()
  })
})
