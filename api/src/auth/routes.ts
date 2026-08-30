import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { createDb, type Db } from '../db/client'
import { sessions, users } from '../db/schema'
import { hashPassword, verifyPassword } from './password'
import { authMiddleware, type AuthVariables } from './middleware'
import type { Env } from '../index'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 天

async function createSession(db: Db, userId: string): Promise<string> {
  const token = crypto.randomUUID()
  await db.insert(sessions).values({
    token,
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  })
  return token
}

function parseCredentials(body: unknown): { username: string; password: string } | { error: string } {
  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown }
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return { error: '用户名和密码必填' }
  }
  const name = username.trim()
  if (name.length > 64) return { error: '用户名过长' }
  return { username: name, password }
}

export const authRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

authRoutes.post('/register', async (c) => {
  const parsed = parseCredentials(await c.req.json().catch(() => null))
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  if (parsed.password.length < 6) return c.json({ error: '密码至少 6 位' }, 400)

  const db = createDb(c.env.DB)
  const existing = await db.select().from(users).where(eq(users.username, parsed.username)).get()
  if (existing) return c.json({ error: '用户名已被使用' }, 409)

  const user = {
    id: crypto.randomUUID(),
    username: parsed.username,
    passwordHash: await hashPassword(parsed.password),
    createdAt: new Date().toISOString(),
  }
  await db.insert(users).values(user)
  const token = await createSession(db, user.id)
  return c.json({ token, user: { id: user.id, username: user.username } })
})

authRoutes.post('/login', async (c) => {
  const parsed = parseCredentials(await c.req.json().catch(() => null))
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)

  const db = createDb(c.env.DB)
  const user = await db.select().from(users).where(eq(users.username, parsed.username)).get()
  if (!user || !(await verifyPassword(parsed.password, user.passwordHash))) {
    return c.json({ error: '用户名或密码错误' }, 401)
  }
  const token = await createSession(db, user.id)
  return c.json({ token, user: { id: user.id, username: user.username } })
})

authRoutes.post('/logout', authMiddleware, async (c) => {
  const header = c.req.header('Authorization')!
  const token = header.slice(7)
  const db = createDb(c.env.DB)
  await db.delete(sessions).where(eq(sessions.token, token))
  return c.json({ ok: true })
})

authRoutes.get('/me', authMiddleware, (c) => {
  return c.json({ user: c.get('user') })
})
