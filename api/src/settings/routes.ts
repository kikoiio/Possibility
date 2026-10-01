/** 设置端点(F5):全局 LLM 配置(BYOK)与日预算。Key 永不回显明文(N4)。 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { createDb } from '../db/client'
import { userLlmConfigs } from '../db/schema'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { resumeGlobalCappedWorlds, userCallsToday } from '../engine/budget'
import type { Env } from '../index'

export const settingsRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
settingsRoutes.use('*', authMiddleware)

function maskKey(apiKey: string | null): { hasKey: boolean; keyPreview: string | null } {
  if (!apiKey) return { hasKey: false, keyPreview: null }
  return { hasKey: true, keyPreview: apiKey.length >= 4 ? `…${apiKey.slice(-4)}` : '****' }
}

settingsRoutes.get('/llm', async (c) => {
  const db = createDb(c.env.DB)
  const row = await db.select().from(userLlmConfigs).where(eq(userLlmConfigs.userId, c.get('user').id)).get()
  return c.json({ baseUrl: row?.baseUrl ?? null, model: row?.model ?? null, ...maskKey(row?.apiKey ?? null) })
})

type LlmPutBody = { baseUrl?: string | null; apiKey?: string | null; model?: string | null }

settingsRoutes.put('/llm', async (c) => {
  const body = await c.req.json<LlmPutBody>().catch(() => null)
  if (!body || typeof body !== 'object') return c.json({ error: '请求体无效' }, 400)
  if (body.baseUrl !== undefined && body.baseUrl !== null && !/^https?:\/\//.test(body.baseUrl)) {
    return c.json({ error: 'baseUrl 须为 http(s) 地址' }, 400)
  }
  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const now = new Date().toISOString()
  const prior = await db.select().from(userLlmConfigs).where(eq(userLlmConfigs.userId, userId)).get()
  const next = {
    baseUrl: body.baseUrl === undefined ? prior?.baseUrl ?? null : body.baseUrl,
    apiKey: body.apiKey === undefined ? prior?.apiKey ?? null : body.apiKey || null, // "" = 清除
    model: body.model === undefined ? prior?.model ?? null : body.model,
  }
  await db.insert(userLlmConfigs).values({ userId, ...next, updatedAt: now })
    .onConflictDoUpdate({ target: userLlmConfigs.userId, set: { ...next, updatedAt: now } })
  return c.json({ baseUrl: next.baseUrl, model: next.model, ...maskKey(next.apiKey) })
})

settingsRoutes.delete('/llm', async (c) => {
  const db = createDb(c.env.DB)
  await db.delete(userLlmConfigs).where(eq(userLlmConfigs.userId, c.get('user').id))
  return c.json({ ok: true })
})

settingsRoutes.get('/budget', async (c) => {
  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const row = await db.select().from(userLlmConfigs).where(eq(userLlmConfigs.userId, userId)).get()
  const usedToday = await userCallsToday(db, userId)
  return c.json({ dailyCallCap: row ? row.dailyCallCap : 400, usedToday })
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
  await db.insert(userLlmConfigs).values({ userId, dailyCallCap: cap, updatedAt: now })
    .onConflictDoUpdate({ target: userLlmConfigs.userId, set: { dailyCallCap: cap, updatedAt: now } })
  // 提额/设不限即恢复:全局触顶暂停的世界回到 running(F10)
  await resumeGlobalCappedWorlds(db, userId)
  const usedToday = await userCallsToday(db, userId)
  return c.json({ dailyCallCap: cap, usedToday })
})
