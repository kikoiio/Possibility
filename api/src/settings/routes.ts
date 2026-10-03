/** 设置端点(F5):全局 LLM 配置(BYOK)与日预算。Key 永不回显明文(N4)。 */
import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { createDb } from '../db/client'
import { userLlmConfigs } from '../db/schema'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { isVerificationValid, normalizeBaseUrl, verificationFingerprint } from './connection-test'
import { complete, configFromEnv, LlmProviderError } from '../llm/client'
import { BudgetRefusal, userReservation } from '../engine/guard'
import { budgetFromEnv, fallbackCallsToday, resumeGlobalCappedWorlds, userCallsToday } from '../engine/budget'
import type { Env } from '../index'

export const settingsRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
settingsRoutes.use('*', authMiddleware)

function maskKey(apiKey: string | null): { hasKey: boolean; keyPreview: string | null } {
  if (!apiKey) return { hasKey: false, keyPreview: null }
  return { hasKey: true, keyPreview: apiKey.length > 4 ? `…${apiKey.slice(-4)}` : '****' }
}

async function verificationState(row: typeof userLlmConfigs.$inferSelect | undefined, userId: string) {
  const verified = row ? await isVerificationValid(userId, row) : false
  const completeConfig = Boolean(row?.baseUrl?.trim() && row.model?.trim() && row.apiKey)
  return { status: verified ? 'verified' as const : completeConfig ? 'unverified' as const : 'incomplete' as const,
    verifiedAt: verified ? row?.verifiedAt ?? null : null }
}

async function publicLlm(row: typeof userLlmConfigs.$inferSelect | undefined, userId: string) {
  return { baseUrl: row?.baseUrl ?? null, model: row?.model ?? null, ...maskKey(row?.apiKey ?? null),
    verification: await verificationState(row, userId) }
}

settingsRoutes.get('/llm', async (c) => {
  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const row = await db.select().from(userLlmConfigs).where(eq(userLlmConfigs.userId, userId)).get()
  return c.json(await publicLlm(row, userId))
})

type LlmPutBody = { baseUrl?: string | null; apiKey?: string | null; model?: string | null }

settingsRoutes.put('/llm', async (c) => {
  const body = await c.req.json<LlmPutBody>().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || ['baseUrl', 'model', 'apiKey'].some(key => {
      const value = body[key as keyof LlmPutBody]
      return value !== undefined && value !== null && typeof value !== 'string'
    })) return c.json({ error: '配置字段须为字符串或 null' }, 400)
  if (body.baseUrl !== undefined && body.baseUrl !== null && body.baseUrl.trim() && !/^https?:\/\//.test(body.baseUrl.trim())) {
    return c.json({ error: 'baseUrl 须为 http(s) 地址' }, 400)
  }
  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const now = new Date().toISOString()
  const prior = await db.select().from(userLlmConfigs).where(eq(userLlmConfigs.userId, userId)).get()
  const next = {
    baseUrl: body.baseUrl === undefined ? prior?.baseUrl ?? null : body.baseUrl?.trim() || null,
    apiKey: body.apiKey === undefined ? prior?.apiKey ?? null : body.apiKey?.trim() || null,
    model: body.model === undefined ? prior?.model ?? null : body.model?.trim() || null,
  }
  const changed = normalizeBaseUrl(next.baseUrl ?? '') !== normalizeBaseUrl(prior?.baseUrl ?? '')
    || next.apiKey !== (prior?.apiKey ?? null) || (next.model ?? '').trim() !== (prior?.model ?? '').trim()
  await db.insert(userLlmConfigs).values({ userId, ...next,
    verificationFingerprint: changed ? null : prior?.verificationFingerprint ?? null,
    verifiedAt: changed ? null : prior?.verifiedAt ?? null,
    dailyCallCap: prior?.dailyCallCap ?? 400, updatedAt: now })
    .onConflictDoUpdate({ target: userLlmConfigs.userId, set: { ...next,
      ...(changed ? { verificationFingerprint: null, verifiedAt: null } : {}), updatedAt: now } })
  const saved = await db.select().from(userLlmConfigs).where(eq(userLlmConfigs.userId, userId)).get()
  return c.json(await publicLlm(saved, userId))
})

settingsRoutes.delete('/llm', async (c) => {
  const db = createDb(c.env.DB)
  await db.delete(userLlmConfigs).where(eq(userLlmConfigs.userId, c.get('user').id))
  return c.json({ ok: true })
})

type ConnectionResult = { ok: true; verifiedAt: string } | { ok: false; kind: string; error: string }
// Coalesce repeated clicks while the same saved configuration is being tested.
// Entries are removed in finally, and databases/users never share verification.
const pendingTests = new WeakMap<object, Map<string, Promise<{ result: ConnectionResult; status: 200 | 400 | 409 | 429 }>>>()

settingsRoutes.post('/llm/test', async (c) => {
  const text = await c.req.text()
  if (text.trim()) {
    const body: unknown = (() => { try { return JSON.parse(text) } catch { return null } })()
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
      return c.json({ ok: false, kind: 'saved_only', error: '连接测试只使用已保存配置，请先保存草稿' }, 400)
    }
  }
  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const row = await db.select().from(userLlmConfigs).where(eq(userLlmConfigs.userId, userId)).get()
  const fingerprint = row ? await verificationFingerprint(userId, row) : null
  if (!row || !fingerprint) {
    return c.json({ ok: false, kind: 'incomplete', error: '请先填写端点、模型和 API Key 并保存' }, 400)
  }
  const key = `${userId}:${fingerprint}`
  let tests = pendingTests.get(c.env.DB)
  if (!tests) { tests = new Map(); pendingTests.set(c.env.DB, tests) }
  let pending = tests.get(key)
  if (!pending) {
    const sameConfig = and(eq(userLlmConfigs.userId, userId), eq(userLlmConfigs.baseUrl, row.baseUrl!),
      eq(userLlmConfigs.model, row.model!), eq(userLlmConfigs.apiKey, row.apiKey!))
    pending = (async () => {
      try {
        const reserve = userReservation(db, userId, budgetFromEnv(c.env), 'connection_test')
        const config = { ...configFromEnv({ ...c.env, LLM_BASE_URL: normalizeBaseUrl(row.baseUrl!),
          LLM_MODEL: row.model!.trim(), LLM_API_KEY: row.apiKey! }, reserve),
          apiKeySource: 'personal_global' as const, apiKeyVerified: await isVerificationValid(userId, row),
          apiKeyVerificationFingerprint: row.verificationFingerprint }
        await complete(config, [{ role: 'user', content: 'Reply with OK.' }],
          { maxTokens: 8, timeoutMs: 15_000, contractVersion: 'connection-test/v1' })
        const verifiedAt = new Date().toISOString()
        const updated = await db.update(userLlmConfigs).set({ verificationFingerprint: fingerprint, verifiedAt })
          .where(sameConfig).returning({ userId: userLlmConfigs.userId })
        if (!updated.length) return { result: { ok: false as const, kind: 'changed',
          error: '配置已更改，请测试当前保存的配置' }, status: 409 as const }
        return { result: { ok: true as const, verifiedAt }, status: 200 as const }
      } catch (error) {
        await db.update(userLlmConfigs).set({ verificationFingerprint: null, verifiedAt: null }).where(and(sameConfig,
          row.verificationFingerprint === null ? isNull(userLlmConfigs.verificationFingerprint)
            : eq(userLlmConfigs.verificationFingerprint, row.verificationFingerprint)))
        if (error instanceof BudgetRefusal) return { result: { ok: false as const, kind: 'budget',
          error: '连接测试已达当前日预算，请提高预算或次日重试' }, status: 429 as const }
        const kind = error instanceof LlmProviderError
          ? error.httpStatus === 401 || error.httpStatus === 403 ? 'authentication'
            : error.httpStatus === 429 ? 'rate_limit'
              : error.modelNotFound ? 'model'
                : error.httpStatus === 404 ? 'endpoint' : 'provider'
          : 'network'
        const hints: Record<string, string> = {
          authentication: '认证失败，请检查 API Key 是否正确及是否有模型权限',
          rate_limit: '提供方限流，请稍后重试或检查提供方额度',
          model: '模型不存在或不可用，请检查模型名称和权限',
          endpoint: '端点不可用，请检查 OpenAI 兼容地址及 /chat/completions 路径',
          provider: '提供方请求失败，请检查端点、模型及提供方状态',
          network: '连接超时或网络不可用，请检查端点后重试',
        }
        return { result: { ok: false as const, kind, error: hints[kind] }, status: 400 as const }
      } finally { tests!.delete(key) }
    })()
    tests.set(key, pending)
  }
  const { result, status } = await pending
  return c.json(result, status)
})

settingsRoutes.get('/budget', async (c) => {
  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const row = await db.select().from(userLlmConfigs).where(eq(userLlmConfigs.userId, userId)).get()
  const usedToday = await userCallsToday(db, userId)
  return c.json({ dailyCallCap: row ? row.dailyCallCap : 400, usedToday,
    fallbackUsedToday: await fallbackCallsToday(db, userId), unlimitedEligible: row ? await isVerificationValid(userId, row) : false })
})

settingsRoutes.put('/budget', async (c) => {
  const body = await c.req.json<{ dailyCallCap?: number | null }>().catch(() => null)
  if (!body || body.dailyCallCap === undefined) return c.json({ error: '请求体无效' }, 400)
  const cap = body.dailyCallCap
  if (cap !== null && (!Number.isSafeInteger(cap) || cap <= 0)) {
    return c.json({ error: 'dailyCallCap 须为正整数或 null(不限)' }, 400)
  }
  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const now = new Date().toISOString()
  const prior = await db.select().from(userLlmConfigs).where(eq(userLlmConfigs.userId, userId)).get()
  if (cap === null && (await verificationState(prior, userId)).status !== 'verified') {
    return c.json({ error: '启用不限前，请保存完整的个人配置并通过连接测试' }, 409)
  }
  if (cap === null) {
    const updated = await db.update(userLlmConfigs).set({ dailyCallCap: null, updatedAt: now }).where(and(
      eq(userLlmConfigs.userId, userId), eq(userLlmConfigs.verificationFingerprint, prior!.verificationFingerprint!),
      eq(userLlmConfigs.baseUrl, prior!.baseUrl!), eq(userLlmConfigs.model, prior!.model!),
      eq(userLlmConfigs.apiKey, prior!.apiKey!), eq(userLlmConfigs.verifiedAt, prior!.verifiedAt!),
    )).returning({ userId: userLlmConfigs.userId })
    if (!updated.length) return c.json({ error: '配置已更改，请重新连接测试后启用不限' }, 409)
  } else {
    await db.insert(userLlmConfigs).values({ userId, baseUrl: prior?.baseUrl ?? null, apiKey: prior?.apiKey ?? null,
      model: prior?.model ?? null, verificationFingerprint: prior?.verificationFingerprint ?? null,
      verifiedAt: prior?.verifiedAt ?? null, dailyCallCap: cap, updatedAt: now })
      .onConflictDoUpdate({ target: userLlmConfigs.userId, set: { dailyCallCap: cap, updatedAt: now } })
  }
  const usedToday = await userCallsToday(db, userId)
  if (cap === null || usedToday < cap) await resumeGlobalCappedWorlds(db, userId)
  const current = await db.select().from(userLlmConfigs).where(eq(userLlmConfigs.userId, userId)).get()
  return c.json({ dailyCallCap: cap, usedToday, fallbackUsedToday: await fallbackCallsToday(db, userId),
    unlimitedEligible: current ? await isVerificationValid(userId, current) : false })
})
