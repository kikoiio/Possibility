import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../test/db'
import { userLlmConfigs, users, worlds } from '../db/schema'
import { byokFailureHint, resolveLlmConfig } from './resolve'

const NOW = '2026-10-01T00:00:00.000Z'
const env = { LLM_BASE_URL: 'https://platform.example.com/', LLM_API_KEY: 'env-key', LLM_MODEL: 'env-model' }
let fixture: ReturnType<typeof createTestDb>

async function setWorldOverride(override: string | null) {
  await fixture.db.update(worlds).set({ llmConfigJson: override }).where(eq(worlds.id, 'w'))
}

beforeEach(async () => {
  fixture = createTestDb()
  const db = fixture.db
  await db.insert(users).values({ id: 'u', username: 'u', passwordHash: 'x', createdAt: NOW })
  await db.insert(worlds).values({ id: 'w', userId: 'u', name: 'W', description: '' })
})

describe('resolveLlmConfig', () => {
  it('无任何配置:纯 env 回落,source=env,baseUrl 去尾斜杠', async () => {
    const { config, source } = await resolveLlmConfig(fixture.db, env, { userId: 'u', worldId: 'w' })
    expect(config).toMatchObject({ baseUrl: 'https://platform.example.com', apiKey: 'env-key', model: 'env-model' })
    expect(source).toBe('env')
  })

  it('用户全量覆盖,source=user', async () => {
    await fixture.db.insert(userLlmConfigs).values({
      userId: 'u', baseUrl: 'https://user.example.com', apiKey: 'user-key', model: 'user-model', updatedAt: NOW,
    })
    const { config, source } = await resolveLlmConfig(fixture.db, env, { userId: 'u', worldId: 'w' })
    expect(config).toMatchObject({ baseUrl: 'https://user.example.com', apiKey: 'user-key', model: 'user-model' })
    expect(source).toBe('user')
  })

  it('世界部分覆盖只盖 apiKey:Key 走世界,baseUrl 走用户,model 走 env,source=world', async () => {
    await fixture.db.insert(userLlmConfigs).values({
      userId: 'u', baseUrl: 'https://user.example.com', apiKey: 'user-key', model: null, updatedAt: NOW,
    })
    await setWorldOverride(JSON.stringify({ apiKey: 'world-key' }))
    const { config, source } = await resolveLlmConfig(fixture.db, env, { userId: 'u', worldId: 'w' })
    expect(config).toMatchObject({ baseUrl: 'https://user.example.com', apiKey: 'world-key', model: 'env-model' })
    expect(source).toBe('world')
  })

  it('世界覆盖坏 JSON 按无覆盖处理', async () => {
    await fixture.db.insert(userLlmConfigs).values({
      userId: 'u', baseUrl: null, apiKey: 'user-key', model: null, updatedAt: NOW,
    })
    await setWorldOverride('{bad json')
    const { config, source } = await resolveLlmConfig(fixture.db, env, { userId: 'u', worldId: 'w' })
    expect(config).toMatchObject({ baseUrl: 'https://platform.example.com', apiKey: 'user-key', model: 'env-model' })
    expect(source).toBe('user')
  })

  it('无 worldId(预世界调用)只看用户配置', async () => {
    await fixture.db.insert(userLlmConfigs).values({
      userId: 'u', baseUrl: null, apiKey: 'user-key', model: 'user-model', updatedAt: NOW,
    })
    const { config, source } = await resolveLlmConfig(fixture.db, env, { userId: 'u' })
    expect(config).toMatchObject({ apiKey: 'user-key', model: 'user-model', baseUrl: 'https://platform.example.com' })
    expect(source).toBe('user')
  })
})

describe('byokFailureHint(F8)', () => {
  it('world/user 来源给出设置页语义,env 不给', () => {
    expect(byokFailureHint('world')).toContain('世界的设置')
    expect(byokFailureHint('user')).toContain('设置页')
    expect(byokFailureHint('env')).toBeNull()
  })
})
