import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { guestSessions, users, worlds } from '../db/schema'
import { createTestDb } from '../test/db'
import { hashGuestToken } from './middleware'
import { scopedUserMiddleware } from './scoped-user-middleware'
import type { AuthVariables } from '../auth/middleware'
import type { Env } from '../index'

describe('scoped user routes for guests', () => {
  it('allows only whitelisted routes for the current sandbox world', async () => {
    const fixture = createTestDb()
    const now = new Date().toISOString()
    await fixture.db.insert(users).values({ id: 'owner', username: 'guest-owner', passwordHash: 'disabled:guest', createdAt: now })
    await fixture.db.insert(worlds).values([
      { id: 'sandbox-world', userId: 'owner', name: 'sandbox', description: '', createdAt: now },
      { id: 'other-world', userId: 'owner', name: 'other', description: '', createdAt: now },
    ])
    await fixture.db.insert(guestSessions).values({
      id: 'guest-session', tokenHash: await hashGuestToken('guest-secret'), ownerUserId: 'owner',
      currentSandboxWorldId: 'sandbox-world', generation: 0, status: 'active',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: now, updatedAt: now,
    })
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
    app.use('/api/*', scopedUserMiddleware((method, path, worldId) =>
      method === 'GET' && path === `/api/worlds/${encodeURIComponent(worldId)}/state`))
    app.get('/api/worlds/:id/state', c => c.json({ id: c.req.param('id'), userId: c.get('user').id }))
    app.post('/api/worlds/:id/state', c => c.json({ ok: true }))

    const headers = { 'X-Possibility-Guest': 'guest-secret' }
    const allowed = await app.request('/api/worlds/sandbox-world/state', { headers }, fixture.env)
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ id: 'sandbox-world', userId: 'owner' })
    expect((await app.request('/api/worlds/other-world/state', { headers }, fixture.env)).status).toBe(404)
    expect((await app.request('/api/worlds/sandbox-world/state', { method: 'POST', headers }, fixture.env)).status).toBe(404)
    fixture.close()
  })
})
