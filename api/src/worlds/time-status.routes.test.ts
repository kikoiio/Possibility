import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { sessions, timelines, universeEvidence, users, worlds, worldVisitSessions } from '../db/schema'
import { createTestDb } from '../test/db'
import { worldsRoutes } from './routes'

const app = new Hono()
app.route('/api/worlds', worldsRoutes)
const NOW = '2026-10-01T00:00:00.000Z'
let fixture: ReturnType<typeof createTestDb> | undefined
afterEach(() => { fixture?.close(); fixture = undefined })

async function setup() {
  fixture = createTestDb()
  await fixture.db.insert(users).values([
    { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: NOW },
    { id: 'other', username: 'other', passwordHash: 'x', createdAt: NOW },
  ])
  await fixture.db.insert(sessions).values([
    { token: 'owner-token', userId: 'owner', expiresAt: '2099-01-01T00:00:00.000Z' },
    { token: 'other-token', userId: 'other', expiresAt: '2099-01-01T00:00:00.000Z' },
  ])
  await fixture.db.insert(worlds).values({ id: 'world', userId: 'owner', name: 'World', description: '', status: 'running', timeZone: 'Asia/Tokyo' })
  await fixture.db.insert(timelines).values({ id: 'main', worldId: 'world', simNow: NOW, createdAt: NOW })
  await fixture.db.insert(universeEvidence).values({ timelineId: 'main', level: 'complete', assessedVersion: 0, baselineVersion: 0, reasonCodesJson: '[]', assessedAt: NOW })
  return fixture
}

function request(path: string, token: string, init: RequestInit = {}) {
  return app.request(`/api/worlds${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  }, fixture!.env)
}

describe('world visit routes', () => {
  it('establishes, replays and closes an idempotent visit without changing simulation time', async () => {
    const f = await setup()
    const enterBody = { timelineId: 'main', clientSessionId: 'browser-1', requestId: 'enter-1' }
    const first = await request('/world/visits/enter', 'owner-token', { method: 'POST', body: JSON.stringify(enterBody) })
    expect(first.status).toBe(200)
    const firstBody = await first.json() as { worldId: string; timelineId: string; simNow: string; timeZone: string; visit: { phase: string; sessionId: string } }
    expect(firstBody).toMatchObject({ worldId: 'world', timelineId: 'main', simNow: NOW, timeZone: 'Asia/Tokyo', visit: { phase: 'first_visit' } })

    const replay = await request('/world/visits/enter', 'owner-token', { method: 'POST', body: JSON.stringify(enterBody) })
    expect(replay.status).toBe(200)
    expect((await replay.json() as { visit: { sessionId: string } }).visit.sessionId).toBe(firstBody.visit.sessionId)

    const leave = await request('/world/visits/leave', 'owner-token', { method: 'POST', body: JSON.stringify({ ...enterBody, requestId: 'leave-1' }) })
    expect(leave.status).toBe(200)
    expect(await leave.json()).toMatchObject({ visit: { phase: 'returning', previousExitedSimTime: NOW } })
    expect(await f.db.select().from(worldVisitSessions)).toHaveLength(1)
    expect(await f.db.select().from(timelines)).toMatchObject([{ simNow: NOW }])
  })

  it('keeps owner and guest-scoped authorization server-side', async () => {
    await setup()
    expect((await request('/world/visits/enter', 'other-token', { method: 'POST', body: JSON.stringify({ timelineId: 'main', clientSessionId: 'browser-1', requestId: 'x' }) })).status).toBe(404)
    expect((await request('/world/visits/enter', 'owner-token', { method: 'POST', body: JSON.stringify({ timelineId: 'other', clientSessionId: 'browser-1', requestId: 'x' }) })).status).toBe(404)
  })
})
