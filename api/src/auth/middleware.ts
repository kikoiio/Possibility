import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import { createDb } from '../db/client'
import { sessions, users } from '../db/schema'
import type { Env } from '../index'

function isTransientD1Contention(error: unknown): boolean {
  const messages: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 20 && current; depth++) {
    if (current instanceof Error) {
      messages.push(current.message)
      current = (current as Error & { cause?: unknown }).cause
    } else {
      messages.push(String(current))
      break
    }
  }
  const message = messages.join('\n')
  return message.includes('SQLITE_BUSY') || message.includes('SQLITE_LOCKED')
    || message.includes('D1_ERROR: Failed to parse body as JSON, got: Error: internal error;')
}

async function readWithD1ContentionRetry<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read() }
    catch (error) {
      if (attempt >= 5 || !isTransientD1Contention(error)) throw error
      await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt))
    }
  }
}

export interface AuthUser {
  id: string
  username: string
}

export interface AuthVariables {
  user: AuthUser
}

/** 解析 Bearer token → 校验 session（含过期）→ 注入 user；失败一律 401 */
export const authMiddleware = createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(
  async (c, next) => {
    const header = c.req.header('Authorization')
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) return c.json({ error: '未登录' }, 401)

    const db = createDb(c.env.DB)
    const session = await readWithD1ContentionRetry(() => db.select().from(sessions).where(eq(sessions.token, token)).get())
    if (!session || session.expiresAt <= new Date().toISOString()) {
      return c.json({ error: '会话已过期，请重新登录' }, 401)
    }
    const user = await readWithD1ContentionRetry(() => db.select().from(users).where(eq(users.id, session.userId)).get())
    if (!user) return c.json({ error: '用户不存在' }, 401)

    c.set('user', { id: user.id, username: user.username })
    await next()
  },
)
