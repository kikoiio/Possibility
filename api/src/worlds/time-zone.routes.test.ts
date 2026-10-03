import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { events, guestSessions, persons, sessions, timelines, users, worlds } from '../db/schema'
import { createTestDb } from '../test/db'
import { hashGuestToken } from '../access/middleware'
import { worldsRoutes } from './routes'

const app = new Hono()
app.route('/api/worlds', worldsRoutes)

const NOW = '2026-10-01T00:00:00.000Z'
let fixture: ReturnType<typeof createTestDb> | undefined
afterEach(() => { fixture?.close(); fixture = undefined })

async function setup() {
  fixture = createTestDb()
  await fixture.db.insert(users).values({ id: 'owner', username: 'owner', passwordHash: 'x', createdAt: NOW })
  await fixture.db.insert(sessions).values({ token: 'owner-token', userId: 'owner', expiresAt: '2099-01-01T00:00:00.000Z' })
  await fixture.db.insert(worlds).values([
    { id: 'world', userId: 'owner', name: 'World', description: '', status: 'running' },
    { id: 'demo', userId: 'owner', name: 'Demo', description: '', status: 'running', isDemo: true },
  ])
  await fixture.db.insert(timelines).values({ id: 'main', worldId: 'world', simNow: NOW, createdAt: NOW })
  await fixture.db.insert(guestSessions).values({
    id: 'guest-session', tokenHash: await hashGuestToken('guest-token'), ownerUserId: 'owner',
    currentSandboxWorldId: 'world', generation: 0, status: 'active',
    expiresAt: '2099-01-01T00:00:00.000Z', createdAt: NOW, updatedAt: NOW,
  })
  return fixture
}

const ownerRequest = (path: string, init: RequestInit = {}) => app.request(`/api/worlds${path}`, {
  ...init,
  headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
}, fixture!.env)

describe('world time zone routes', () => {
  it('returns UTC for legacy null and permits scoped guests to read the sandbox zone', async () => {
    await setup()
    const owner = await ownerRequest('/world/time-zone')
    expect(owner.status).toBe(200)
    expect(await owner.json()).toEqual({ timeZone: 'UTC' })
    const guest = await app.request('/api/worlds/world/time-zone', {
      headers: { 'X-Possibility-Guest': 'guest-token' },
    }, fixture!.env)
    expect(guest.status).toBe(200)
    expect(await guest.json()).toEqual({ timeZone: 'UTC' })
    expect((await app.request('/api/worlds/demo/time-zone', {
      headers: { 'X-Possibility-Guest': 'guest-token' },
    }, fixture!.env)).status).toBe(404)
  })

  it('creates new worlds with the submitted zone, exposes it in lists and snapshots, and preserves the instant on updates', async () => {
    const f = await setup()
    const model = { identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] }
    await f.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: JSON.stringify(model), createdAt: NOW })
    const body = { name: 'New world', description: 'Small town', personIds: ['resident'], locations: ['A', 'B', 'C', 'D', 'E'].map(name => ({ name, description: '' })), timeZone: 'Asia/Tokyo' }
    const invalid = await ownerRequest('', { method: 'POST', body: JSON.stringify({ ...body, timeZone: 'Invalid/Zone' }) })
    expect(invalid.status).toBe(400)
    const created = await ownerRequest('', { method: 'POST', body: JSON.stringify(body) })
    expect(created.status).toBe(200)
    const { id, timelineId } = await created.json() as { id: string; timelineId: string }
    const before = await f.db.select().from(timelines).where(eq(timelines.id, timelineId)).get()
    await f.db.insert(events).values({ id: 'history', timelineId, simTime: before!.simNow, title: 'Keep', description: 'Recorded' })
    const history = await f.db.select().from(events).where(eq(events.timelineId, timelineId)).all()
    expect(await (await ownerRequest(`/${id}/time-zone`)).json()).toEqual({ timeZone: 'Asia/Tokyo' })
    const list = await (await ownerRequest('')).json() as { worlds: { id: string; timeZone: string }[] }
    expect(list.worlds.find(world => world.id === id)?.timeZone).toBe('Asia/Tokyo')
    const snapshot = await (await ownerRequest(`/${id}`)).json() as { world: { timeZone: string }; timelines: { timeZone: string }[] }
    expect(snapshot.world.timeZone).toBe('Asia/Tokyo')
    expect(snapshot.timelines.every(timeline => timeline.timeZone === 'Asia/Tokyo')).toBe(true)
    expect((await ownerRequest(`/${id}/time-zone`, { method: 'PUT', body: JSON.stringify({ timeZone: 'America/New_York' }) })).status).toBe(200)
    expect(await f.db.select().from(timelines).where(eq(timelines.id, timelineId)).get()).toEqual(before)
    expect(await f.db.select().from(events).where(eq(events.timelineId, timelineId)).all()).toEqual(history)
  })

  it('updates only valid zones for owners and rejects guest or demo writes', async () => {
    const f = await setup()
    const updated = await ownerRequest('/world/time-zone', {
      method: 'PUT', body: JSON.stringify({ timeZone: 'Asia/Tokyo' }),
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toEqual({ timeZone: 'Asia/Tokyo' })
    expect((await f.db.select().from(worlds).where(eq(worlds.id, 'world')).get())?.timeZone).toBe('Asia/Tokyo')
    expect((await ownerRequest('/world/time-zone', {
      method: 'PUT', body: JSON.stringify({ timeZone: 'Not/AZone' }),
    })).status).toBe(400)
    expect((await ownerRequest('/demo/time-zone', {
      method: 'PUT', body: JSON.stringify({ timeZone: 'UTC' }),
    })).status).toBe(403)
    expect((await app.request('/api/worlds/world/time-zone', {
      method: 'PUT', headers: { 'X-Possibility-Guest': 'guest-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeZone: 'UTC' }),
    }, f.env)).status).toBe(404)
  })
})
