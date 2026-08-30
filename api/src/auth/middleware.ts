import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import { createDb } from '../db/client'
import { sessions, users } from '../db/schema'
import type { Env } from '../index'

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
    const session = await db.select().from(sessions).where(eq(sessions.token, token)).get()
    if (!session || session.expiresAt <= new Date().toISOString()) {
      return c.json({ error: '会话已过期，请重新登录' }, 401)
    }
    const user = await db.select().from(users).where(eq(users.id, session.userId)).get()
    if (!user) return c.json({ error: '用户不存在' }, 401)

    c.set('user', { id: user.id, username: user.username })
    await next()
  },
)
