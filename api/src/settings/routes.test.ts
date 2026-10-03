import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../test/db'
import { sessions, userLlmConfigs, users, worlds, llmCallLog } from '../db/schema'
import { settingsRoutes } from './routes'

const NOW = '2026-10-01T00:00:00.000Z'
let fixture: ReturnType<typeof createTestDb> | undefined
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); fixture?.close(); fixture = undefined })

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
    expect(await res.json()).toEqual({ baseUrl: null, model: null, hasKey: false, keyPreview: null,
      verification: { status: 'incomplete', verifiedAt: null } })
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

  it('短 Key 读取也不返回完整凭据', async () => {
    await setup()
    for (const apiKey of ['abc', '1234']) {
      await req('/llm', { method: 'PUT', body: JSON.stringify({ apiKey }) })
      const read = await req('/llm')
      const text = await read.text()
      expect(text).not.toContain(apiKey)
      expect(JSON.parse(text)).toMatchObject({ keyPreview: '****' })
    }
  })

  it('baseUrl 非 http(s) 拒绝;apiKey 空串清除', async () => {
    await setup()
    expect((await req('/llm', { method: 'PUT', body: JSON.stringify({ baseUrl: 'ftp://x' }) })).status).toBe(400)
    await req('/llm', { method: 'PUT', body: JSON.stringify({ apiKey: 'sk-secret-1234' }) })
    const cleared = await req('/llm', { method: 'PUT', body: JSON.stringify({ apiKey: '' }) })
    expect(await cleared.json()).toMatchObject({ hasKey: false, keyPreview: null })
  })

  it('连接测试仅使用已保存配置,只产生一次受限 provider 请求和 receipt,并脱敏错误', async () => {
    const f = await setup()
    const apiKey = 'sk-canary-secret-9071'
    await req('/llm', { method: 'PUT', body: JSON.stringify({
      baseUrl: 'https://provider.example/v1/', model: 'model-a', apiKey,
    }) })
    let requestCount = 0
    const provider = f.env.LLM_PROVIDER!
    f.env.LLM_PROVIDER = { ...provider, fetch: async input => {
      requestCount++
      const request = input instanceof Request ? input : new Request(input as string | URL)
      const body = await request.json() as { model: string; messages: unknown[]; max_tokens: number }
      expect(new URL(request.url).pathname).toBe('/v1/chat/completions')
      expect(body).toMatchObject({ model: 'model-a', max_tokens: 8 })
      expect(body.messages).toEqual([{ role: 'user', content: 'Reply with OK.' }])
      expect(request.headers.get('Authorization')).toBe(`Bearer ${apiKey}`)
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 })
    } }
    const override = await req('/llm/test', { method: 'POST', body: JSON.stringify({ apiKey: 'ignored' }) })
    expect(override.status).toBe(400)
    expect(requestCount).toBe(0)
    const result = await req('/llm/test', { method: 'POST' })
    expect(result.status).toBe(200)
    expect(requestCount).toBe(1)
    const receipts = await f.db.select().from(llmCallLog).all()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ purpose: 'connection_test', apiKeySource: 'personal_global', budgetBucket: 'finite_global', status: 'completed' })
    expect(JSON.stringify(await result.json())).not.toContain(apiKey)
    const verifiedBody = await (await req('/llm')).json() as { verification: { status: string } }
    expect(verifiedBody.verification.status).toBe('verified')

    f.env.LLM_PROVIDER = { ...f.env.LLM_PROVIDER!, fetch: async () => {
      requestCount++
      return new Response(`provider rejected ${apiKey}`, { status: 401 })
    } }
    const failed = await req('/llm/test', { method: 'POST' })
    expect(failed.status).toBe(400)
    expect(requestCount).toBe(2)
    expect(await failed.text()).not.toContain(apiKey)
    const failedReceipt = await f.db.select().from(llmCallLog).all()
    expect(failedReceipt).toHaveLength(2)
    expect(failedReceipt[1].status).toBe('failed')
  })

  it('不完整配置连接测试不访问 provider 且保留草稿', async () => {
    const f = await setup()
    await req('/llm', { method: 'PUT', body: JSON.stringify({ baseUrl: 'https://provider.example/v1' }) })
    let called = false
    f.env.LLM_PROVIDER = { ...f.env.LLM_PROVIDER!, fetch: async () => { called = true; return new Response('{}') } }
    const result = await req('/llm/test', { method: 'POST' })
    expect(result.status).toBe(400)
    expect(called).toBe(false)
    expect(await f.db.select().from(userLlmConfigs).all())
      .toMatchObject([{ baseUrl: 'https://provider.example/v1' }])
    expect(await f.db.select().from(llmCallLog).all()).toHaveLength(0)
  })
  it.each([
    [401, 'bad credential', 'authentication'],
    [403, 'no access', 'authentication'],
    [404, 'route not found', 'endpoint'],
    [404, 'model_not_found', 'model'],
    [400, 'invalid_model', 'model'],
    [429, 'quota reached', 'rate_limit'],
    [500, 'provider unavailable', 'provider'],
  ])('HTTP %s 的连接失败分类为 %s，错误不回显 Key', async (status, responseText, kind) => {
    const f = await setup()
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {})
    const apiKey = 'sk-failure-canary-123456'
    await req('/llm', { method: 'PUT', body: JSON.stringify({ baseUrl: 'https://provider.example/v1', model: 'm', apiKey }) })
    f.env.LLM_PROVIDER = { fetch: async () => new Response(`${responseText} ${apiKey}`, { status }) } as unknown as typeof f.env.LLM_PROVIDER
    const result = await req('/llm/test', { method: 'POST' })
    expect(result.status).toBe(400)
    const body = await result.json()
    expect(body).toMatchObject({ ok: false, kind })
    expect(JSON.stringify(body)).not.toContain(apiKey)
    expect(JSON.stringify(logger.mock.calls)).not.toContain(apiKey)
    expect(await f.db.select().from(llmCallLog)).toMatchObject([{ status: 'failed' }])
    expect(await (await req('/llm')).json()).toMatchObject({ verification: { status: 'unverified' } })
  })

  it('重复测试合并为一次请求，一次 receipt；配置变更不被旧成功验证', async () => {
    const f = await setup()
    await req('/llm', { method: 'PUT', body: JSON.stringify({ baseUrl: 'https://provider.example/v1', model: 'm', apiKey: 'sk-test' }) })
    let called!: () => void
    const started = new Promise<void>(resolve => { called = resolve })
    let finish!: (response: Response) => void
    const providerResponse = new Promise<Response>(resolve => { finish = resolve })
    let calls = 0
    f.env.LLM_PROVIDER = { fetch: async () => { calls++; called(); return providerResponse } } as unknown as typeof f.env.LLM_PROVIDER
    const first = req('/llm/test', { method: 'POST' })
    await started
    const second = req('/llm/test', { method: 'POST' })
    // Await the second request's database read before changing the configuration.
    await new Promise(resolve => setTimeout(resolve, 0))
    await req('/llm', { method: 'PUT', body: JSON.stringify({ model: 'changed' }) })
    finish(new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })))
    const results = await Promise.all([first, second])
    expect(results.map(result => result.status)).toEqual([409, 409])
    expect(calls).toBe(1)
    expect(await f.db.select().from(llmCallLog)).toHaveLength(1)
    expect(await (await req('/llm')).json()).toMatchObject({ model: 'changed', verification: { status: 'unverified' } })
  })

  it('测试超时只消费一次 receipt，返回安全网络提示', async () => {
    const f = await setup()
    await req('/llm', { method: 'PUT', body: JSON.stringify({ baseUrl: 'https://provider.example/v1', model: 'm', apiKey: 'sk-timeout' }) })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let called!: () => void
    const started = new Promise<void>(resolve => { called = resolve })
    f.env.LLM_PROVIDER = { fetch: async () => { called(); return new Promise<Response>(() => {}) } } as unknown as typeof f.env.LLM_PROVIDER
    const pending = req('/llm/test', { method: 'POST' })
    await started
    await vi.advanceTimersByTimeAsync(15_001)
    const result = await pending
    expect(await result.json()).toMatchObject({ ok: false, kind: 'network' })
    expect(await f.db.select().from(llmCallLog)).toMatchObject([{ status: 'cancelled', errorCode: 'timeout' }])
  })

  it('非法配置类型被拒绝，空字段草稿允许保存', async () => {
    await setup()
    for (const body of [{ apiKey: 1 }, { baseUrl: {} }, { model: [] }, []]) {
      expect((await req('/llm', { method: 'PUT', body: JSON.stringify(body) })).status).toBe(400)
    }
    expect((await req('/llm', { method: 'PUT', body: JSON.stringify({ baseUrl: '', model: '', apiKey: '' }) })).status).toBe(200)
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
  it('缺省 400;PUT 改值生效;未验证时拒绝不限;非法值 400', async () => {
    await setup()
    expect(await (await req('/budget')).json()).toMatchObject({ dailyCallCap: 400, usedToday: 0 })
    expect(await (await req('/budget', { method: 'PUT', body: JSON.stringify({ dailyCallCap: 500 }) })).json())
      .toMatchObject({ dailyCallCap: 500 })
    expect(await (await req('/budget')).json()).toMatchObject({ dailyCallCap: 500 })
    expect((await req('/budget', { method: 'PUT', body: JSON.stringify({ dailyCallCap: null }) })).status).toBe(409)
    expect((await req('/budget', { method: 'PUT', body: JSON.stringify({ dailyCallCap: -1 }) })).status).toBe(400)
  })

  it('不限需当前已验证配置;提额仅恢复被有限预算暂停的世界', async () => {
    const f = await setup()
    const rejected = await req('/budget', { method: 'PUT', body: JSON.stringify({ dailyCallCap: null }) })
    expect(rejected.status).toBe(409)
    await f.db.insert(worlds).values([
      { id: 'w1', userId: 'u', name: 'W1', description: '', status: 'capped', pauseReason: 'global_daily_cap' },
      { id: 'w2', userId: 'u', name: 'W2', description: '', status: 'capped', pauseReason: 'manual' },
    ])
    const res = await req('/budget', { method: 'PUT', body: JSON.stringify({ dailyCallCap: 800 }) })
    expect(res.status).toBe(200)
    expect((await f.db.select().from(worlds).where(eq(worlds.id, 'w1')).get()))
      .toMatchObject({ status: 'running', pauseReason: null })
    expect((await f.db.select().from(worlds).where(eq(worlds.id, 'w2')).get()))
      .toMatchObject({ status: 'capped', pauseReason: 'manual' })
  })
  it('验证后启用不限，变更端点/模型/Key即失效，删除回退默认预算', async () => {
    const f = await setup()
    const config = { baseUrl: 'https://provider.example/v1', model: 'm', apiKey: 'sk-success-canary' }
    f.env.LLM_PROVIDER = { fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })) } as unknown as typeof f.env.LLM_PROVIDER
    await req('/llm', { method: 'PUT', body: JSON.stringify(config) })
    expect((await req('/llm/test', { method: 'POST' })).status).toBe(200)
    expect((await req('/budget', { method: 'PUT', body: JSON.stringify({ dailyCallCap: null }) })).status).toBe(200)
    for (const patch of [{ model: 'm2' }, { baseUrl: 'https://other.example/v1' }, { apiKey: 'sk-new' }]) {
      await req('/llm', { method: 'PUT', body: JSON.stringify(patch) })
      expect(await (await req('/llm')).json()).toMatchObject({ verification: { status: 'unverified' } })
      expect((await req('/budget', { method: 'PUT', body: JSON.stringify({ dailyCallCap: null }) })).status).toBe(409)
      expect(await (await req('/budget')).json()).toMatchObject({ unlimitedEligible: false })
      expect((await req('/llm/test', { method: 'POST' })).status).toBe(200)
    }
    await req('/llm', { method: 'DELETE' })
    expect(await (await req('/budget')).json()).toMatchObject({ dailyCallCap: 400, unlimitedEligible: false })
  })

})
