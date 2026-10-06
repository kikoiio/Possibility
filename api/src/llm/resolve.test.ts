import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../test/db'
import { userLlmConfigs, users, worlds } from '../db/schema'
import { byokFailureHint, resolveLlmConfig } from './resolve'

const NOW = '2026-10-01T00:00:00.000Z'
const env = { LLM_BASE_URL: 'https://platform.example.com/', LLM_API_KEY: 'env-key', LLM_MODEL: 'env-model' }
let fixture: ReturnType<typeof createTestDb>

afterEach(() => fixture?.close())

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

  it('A1 deterministic chat provider is available only in the isolated compatibility E2E mode', async () => {
    const e2e = await resolveLlmConfig(fixture.db, { ...env, ENVIRONMENT: 's02-e2e',
      SCENE_COMPATIBILITY_FIXTURE: 'compatibility-legacy', A1_E2E_LIFE_FIXTURE: 'on' }, { userId: 'u', worldId: 'w' })
    expect(e2e.config.provider).toBeDefined()
    const response = await e2e.config.provider!.fetch(new Request('http://fixture.test'))
    expect(await response.text()).toContain('我收到了庭院维护的消息')

    for (const disabled of [
      { ...env, ENVIRONMENT: 'production', SCENE_COMPATIBILITY_FIXTURE: 'compatibility-legacy', A1_E2E_LIFE_FIXTURE: 'on' },
      { ...env, ENVIRONMENT: 's02-e2e', SCENE_COMPATIBILITY_FIXTURE: 'off', A1_E2E_LIFE_FIXTURE: 'on' },
      { ...env, ENVIRONMENT: 's02-e2e', SCENE_COMPATIBILITY_FIXTURE: 'compatibility-legacy', A1_E2E_LIFE_FIXTURE: 'off' },
    ]) {
      expect((await resolveLlmConfig(fixture.db, disabled, { userId: 'u', worldId: 'w' })).config.provider).toBeUndefined()
    }
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

  it('验证资格仅在当前个人配置指纹匹配时成立,混合端点/模型仍按实际 Key 来源计费', async () => {
    const { verificationFingerprint } = await import('../settings/connection-test')
    const personal = { baseUrl: 'https://user.example.com', apiKey: 'user-key', model: 'user-model' }
    await fixture.db.insert(userLlmConfigs).values({
      userId: 'u', ...personal,
      verificationFingerprint: await verificationFingerprint('u', personal), verifiedAt: NOW, updatedAt: NOW,
    })
    await setWorldOverride(JSON.stringify({ baseUrl: 'https://world.example.com', model: 'world-model' }))
    let result = await resolveLlmConfig(fixture.db, env, { userId: 'u', worldId: 'w' })
    expect(result).toMatchObject({ apiKeySource: 'personal_global', verificationValid: true,
      config: { apiKey: 'user-key', apiKeyVerified: true } })

    await setWorldOverride(JSON.stringify({ apiKey: 'world-key', baseUrl: 'https://world.example.com' }))
    result = await resolveLlmConfig(fixture.db, env, { userId: 'u', worldId: 'w' })
    expect(result).toMatchObject({ apiKeySource: 'world_override', verificationValid: true,
      config: { apiKey: 'world-key', apiKeyVerified: true } })

    await fixture.db.update(userLlmConfigs).set({ model: 'changed-model' }).where(eq(userLlmConfigs.userId, 'u'))
    await setWorldOverride(null)
    result = await resolveLlmConfig(fixture.db, env, { userId: 'u', worldId: 'w' })
    expect(result).toMatchObject({ apiKeySource: 'personal_global', verificationValid: false,
      config: { apiKeyVerified: false } })
  })

  it('包装 reservation 自动传最终 Key 来源与已验证指纹，世界 Key 不继承个人豁免', async () => {
    const { verificationFingerprint } = await import('../settings/connection-test')
    const personal = { baseUrl: 'https://personal.example/v1', model: 'm', apiKey: 'personal-key' }
    const fingerprint = await verificationFingerprint('u', personal)
    await fixture.db.insert(userLlmConfigs).values({ userId: 'u', ...personal,
      verificationFingerprint: fingerprint, verifiedAt: NOW, updatedAt: NOW })
    const reserve = Object.assign(vi.fn(async () => 'receipt'), { settle: vi.fn(async () => {}) })
    const details = { requestId: 'r', contextHash: 'h', contractVersion: 'test/v1' }
    const resolved = await resolveLlmConfig(fixture.db, env, { userId: 'u', worldId: 'w' }, reserve)
    await resolved.config.reserve!(details)
    expect(reserve).toHaveBeenLastCalledWith({ ...details, apiKeySource: 'personal_global',
      verifiedPersonalKey: true, verifiedPersonalFingerprint: fingerprint })
    expect(resolved.config.reserve!.settle).toBe(reserve.settle)
    await setWorldOverride(JSON.stringify({ apiKey: 'world-key' }))
    const world = await resolveLlmConfig(fixture.db, env, { userId: 'u', worldId: 'w' }, reserve)
    await world.config.reserve!(details)
    expect(reserve).toHaveBeenLastCalledWith({ ...details, apiKeySource: 'world_override',
      verifiedPersonalKey: false, verifiedPersonalFingerprint: fingerprint })
  })

  it('世界 Key、个人 Key 和平台兜底来源按最终实际 Key 分类', async () => {
    const { apiKeySource: platform } = await resolveLlmConfig(fixture.db, env, { userId: 'u', worldId: 'w' })
    expect(platform).toBe('platform_fallback')
    await fixture.db.insert(userLlmConfigs).values({ userId: 'u', apiKey: 'user-key', updatedAt: NOW })
    expect((await resolveLlmConfig(fixture.db, env, { userId: 'u', worldId: 'w' })).apiKeySource).toBe('personal_global')
    await setWorldOverride(JSON.stringify({ apiKey: 'world-key' }))
    expect((await resolveLlmConfig(fixture.db, env, { userId: 'u', worldId: 'w' })).apiKeySource).toBe('world_override')
  })
})

describe('byokFailureHint(F8)', () => {
  it('world/user 来源给出设置页语义,env 不给', () => {
    expect(byokFailureHint('world')).toContain('世界的设置')
    expect(byokFailureHint('user')).toContain('设置页')
    expect(byokFailureHint('env')).toBeNull()
  })
})
