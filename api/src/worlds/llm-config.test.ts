import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../test/db'
import { sessions, timelines, users, worlds } from '../db/schema'
import { worldsRoutes } from './routes'

const NOW = '2026-10-01T00:00:00.000Z'
let fixture: ReturnType<typeof createTestDb> | undefined
afterEach(() => { fixture?.close(); fixture = undefined })

async function setup() {
  fixture = createTestDb()
  await fixture.db.insert(users).values({ id: 'u', username: 'u', passwordHash: 'x', createdAt: NOW })
  await fixture.db.insert(sessions).values({ token: 'token', userId: 'u', expiresAt: '2099-01-01T00:00:00.000Z' })
  await fixture.db.insert(worlds).values({ id: 'w', userId: 'u', name: 'W', description: '', status: 'running' })
  await fixture.db.insert(timelines).values({ id: 't', worldId: 'w', simNow: NOW, createdAt: NOW })
  return fixture
}

const req = (path: string, init: RequestInit = {}) =>
  worldsRoutes.request(path, {
    ...init, headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  }, fixture!.env)

describe('世界级 LLM 覆盖端点(F5)', () => {
  it('默认无覆盖;PATCH 部分字段 + 掩码回显;明文 Key 不出现在响应', async () => {
    await setup()
    expect(await (await req('/w/llm-config')).json())
      .toEqual({ baseUrl: null, model: null, hasKey: false, keyPreview: null })
    const res = await req('/w', { method: 'PATCH', body: JSON.stringify({ llmConfig: { apiKey: 'sk-world-9999' } }) })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({ hasKey: true, keyPreview: '…9999', baseUrl: null, model: null })
    expect(JSON.stringify(body)).not.toContain('sk-world-9999')
    expect(await (await req('/w/llm-config')).json()).toMatchObject({ hasKey: true, keyPreview: '…9999' })
  })

  it('baseUrl 校验;清除覆盖置 null', async () => {
    const f = await setup()
    expect((await req('/w', { method: 'PATCH', body: JSON.stringify({ llmConfig: { baseUrl: 'ftp://x' } }) })).status).toBe(400)
    await req('/w', { method: 'PATCH', body: JSON.stringify({ llmConfig: { apiKey: 'sk-world-9999', model: 'm' } }) })
    const cleared = await req('/w', { method: 'PATCH', body: JSON.stringify({ llmConfig: null }) })
    expect(cleared.status).toBe(200)
    expect((await f.db.select().from(worlds).where(eq(worlds.id, 'w')).get())?.llmConfigJson).toBeNull()
  })

  it('他人世界 404', async () => {
    const f = await setup()
    await f.db.insert(users).values({ id: 'v', username: 'v', passwordHash: 'x', createdAt: NOW })
    await f.db.insert(sessions).values({ token: 'v-token', userId: 'v', expiresAt: '2099-01-01T00:00:00.000Z' })
    const res = await worldsRoutes.request('/w/llm-config', { headers: { Authorization: 'Bearer v-token' } }, f.env)
    expect(res.status).toBe(404)
  })
})
