import { beforeEach, describe, expect, it } from 'vitest'
import app from '../index'
import { createTestDb } from '../test/db'
import { users, worlds } from '../db/schema'

describe('公开演示路由不被认证子应用拦截', () => {
  it('匿名可以读取 demo，写入口仍由 public fallback 拒绝', async () => {
    const f = createTestDb()
    await f.db.insert(users).values({ id: 'u', username: 'u', passwordHash: 'x', createdAt: new Date().toISOString() })
    await f.db.insert(worlds).values({ id: 'demo', userId: 'u', name: 'Demo', description: 'read-only', isDemo: true })
    const ok = await app.request('/api/public/demo', {}, f.env)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ id: 'demo', name: 'Demo', description: 'read-only' })
    const blocked = await app.request('/api/public/demo', { method: 'POST' }, f.env)
    expect(blocked.status).toBe(404)
    f.close()
  })
})
