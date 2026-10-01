import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../test/db'
import { sessions, userLlmConfigs, users, worlds } from '../db/schema'
import { settingsRoutes } from './routes'

const NOW = '2026-10-01T00:00:00.000Z'
let fixture: ReturnType<typeof createTestDb> | undefined
afterEach(() => { fixture?.close(); fixture = undefined })

async function setup() {
  fixture = createTestDb()
  await fixture.db.insert(users).values({ id: 'u', username: 'u', passwordHash: 'x', createdAt: NOW })
  await fixture.db.insert(sessions).values({ token: 'token', userId: 'u', expiresAt: '2099-01-01T00:00:00.000Z' })
  return fixture
}

const req = (path: string, init: RequestInit = {}) =>
  fixture!.env && settingsRoutes.request(path, {
    ...init, headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  }, fixture!.env)

describe('settings LLM 端点(F5)', () => {
  it('未配置时 GET 返回空形态', async () => {
    await setup()
    const res = await req('/llm')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ baseUrl: null, model: null, hasKey: false, keyPreview: null })
  })

  it('PUT 部分字段 + 掩码回显,响应与存储不回显明文 Key', async () => {
    await setup()
    const put = await req('/llm', { method: 'PUT',
      body: JSON.stringify({ baseUrl: 'https://api.example.com/', apiKey: 'sk-secret-1234', model: 'm1' }) })
    expect(put.status).toBe(200)
    const body = await put.json() as Record<string, unknown>
    expect(body).toMatchObject({ baseUrl: 'https://api.example.com/', model: 'm1', hasKey: true, keyPreview: '…1234' })
    expect(JSON.stringify(body)).not.toContain('sk-secret-1234')
    const get = await req('/llm')
    const getBody = await get.json() as Record<string, unknown>
    expect(getBody).toMatchObject({ hasKey: true, keyPreview: '…1234' })
    expect(JSON.stringify(getBody)).not.toContain('sk-secret-1234')
  })

  it('baseUrl 非 http(s) 拒绝;apiKey 空串清除', async () => {
    await setup()
    expect((await req('/llm', { method: 'PUT', body: JSON.stringify({ baseUrl: 'ftp://x' }) })).status).toBe(400)
    await req('/llm', { method: 'PUT', body: JSON.stringify({ apiKey: 'sk-secret-1234' }) })
    const cleared = await req('/llm', { method: 'PUT', body: JSON.stringify({ apiKey: '' }) })
    expect(await cleared.json()).toMatchObject({ hasKey: false, keyPreview: null })
  })

  it('DELETE 删配置行;未登录 401', async () => {
    const f = await setup()
    await req('/llm', { method: 'PUT', body: JSON.stringify({ apiKey: 'sk-x', model: 'm' }) })
    await req('/llm', { method: 'DELETE' })
    expect(await f.db.select().from(userLlmConfigs).all()).toEqual([])
    const unauth = await settingsRoutes.request('/llm', {}, f.env)
    expect(unauth.status).toBe(401)
  })
})

describe('settings 预算端点(F5)', () => {
  it('缺省 400;PUT 改值/不限即时生效;非法值 400', async () => {
    await setup()
    expect(await (await req('/budget')).json()).toMatchObject({ dailyCallCap: 400, usedToday: 0 })
    expect(await (await req('/budget', { method: 'PUT', body: JSON.stringify({ dailyCallCap: 500 }) })).json())
      .toMatchObject({ dailyCallCap: 500 })
    expect(await (await req('/budget')).json()).toMatchObject({ dailyCallCap: 500 })
    expect(await (await req('/budget', { method: 'PUT', body: JSON.stringify({ dailyCallCap: null }) })).json())
      .toMatchObject({ dailyCallCap: null })
    expect((await req('/budget', { method: 'PUT', body: JSON.stringify({ dailyCallCap: -1 }) })).status).toBe(400)
  })

  it('提额同事务恢复 global_daily_cap 世界(F10)', async () => {
    const f = await setup()
    await f.db.insert(worlds).values([
      { id: 'w1', userId: 'u', name: 'W1', description: '', status: 'capped', pauseReason: 'global_daily_cap' },
      { id: 'w2', userId: 'u', name: 'W2', description: '', status: 'capped', pauseReason: 'manual' },
    ])
    const res = await req('/budget', { method: 'PUT', body: JSON.stringify({ dailyCallCap: 800 }) })
    expect(res.status).toBe(200)
    expect((await f.db.select().from(worlds).where(eq(worlds.id, 'w1')).get()))
      .toMatchObject({ status: 'running', pauseReason: null })
    // 非全局触顶的世界不受牵连
    expect((await f.db.select().from(worlds).where(eq(worlds.id, 'w2')).get()))
      .toMatchObject({ status: 'capped', pauseReason: 'manual' })
  })
})
