import { beforeEach, describe, expect, it } from 'vitest'
import app from '../index'
import { createTestDb } from '../test/db'
import { sessions, timelines, users, worlds } from '../db/schema'
import { ensureUniverseRevision } from '../world-state/model'

describe('公开演示路由不被认证子应用拦截', () => {
  it('匿名可以读取 demo，写入口仍由 public fallback 拒绝', async () => {
    const f = createTestDb()
    await f.db.insert(users).values({ id: 'u', username: 'u', passwordHash: 'x', createdAt: new Date().toISOString() })
    await f.db.insert(sessions).values({ token: 'u-token', userId: 'u', expiresAt: '2099-01-01T00:00:00.000Z' })
    await f.db.insert(worlds).values({ id: 'demo', userId: 'u', name: 'Demo', description: 'read-only', isDemo: true })
    await f.db.insert(timelines).values({ id: 'demo-main', worldId: 'demo', simNow: new Date().toISOString(), createdAt: new Date().toISOString() })
    const ok = await app.request('/api/public/demo', {}, f.env)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ id: 'demo', name: 'Demo', description: 'read-only' })
    const legacySnapshot = await app.request('/api/public/worlds/demo', {}, f.env)
    expect(legacySnapshot.status).toBe(200)
    expect(await legacySnapshot.json()).toMatchObject({ currentTimelineId: 'demo-main', evidenceStatus: 'legacy', currentFacts: [] })
    expect((await app.request('/api/public/worlds/demo?timelineId=', {}, f.env)).status).toBe(404)
    await ensureUniverseRevision(f.db, 'demo', 'demo-main')
    const structuredSnapshot = await app.request('/api/public/worlds/demo', {}, f.env)
    expect(await structuredSnapshot.json()).toMatchObject({ currentTimelineId: 'demo-main', evidenceStatus: 'structured', stateVersion: 0 })
    const blocked = await app.request('/api/public/demo', { method: 'POST' }, f.env)
    expect(blocked.status).toBe(404)
    const blockedAction = await app.request('/api/public/worlds/demo/actions', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: { type: 'environment' } }) }, f.env)
    expect(blockedAction.status).toBe(404)
    const signedInRead = await app.request('/api/public/demo', { headers: { Authorization: 'Bearer u-token' } }, f.env)
    expect(signedInRead.status).toBe(200)
    const signedInWrite = await app.request('/api/public/worlds/demo/actions', { method: 'POST',
      headers: { Authorization: 'Bearer u-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: { type: 'environment' } }) }, f.env)
    expect(signedInWrite.status).toBe(404)
    f.close()
  })
})
