import { and, eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import type { Env } from '../index'
import { createDb, type Db } from '../db/client'
import { demoSandboxes, guestSessions, sessions, users } from '../db/schema'
import { AccessCredentialError, type AccessContext, type AccessVariables } from './types'

export const GUEST_TOKEN_HEADER = 'X-Possibility-Guest'

export async function hashGuestToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`possibility:guest:v1:${token}`))
  return `sha256:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')}`
}

export async function resolveAccessContext(
  db: Db,
  credentials: { authorization?: string; guestToken?: string },
  now = new Date(),
): Promise<AccessContext> {
  const bearer = credentials.authorization?.startsWith('Bearer ') ? credentials.authorization.slice(7).trim() : ''
  if (bearer) {
    const session = await db.select().from(sessions).where(eq(sessions.token, bearer)).get()
    if (!session || session.expiresAt <= now.toISOString()) throw new AccessCredentialError('expired', '登录会话已过期，请重新登录', 401)
    const user = await db.select().from(users).where(eq(users.id, session.userId)).get()
    if (!user) throw new AccessCredentialError('invalid', '登录用户不存在', 401)
    return { kind: 'user', userId: user.id, username: user.username, ownerId: user.id }
  }

  const token = credentials.guestToken?.trim()
  if (!token) return { kind: 'anonymous' }
  const row = await db.select().from(guestSessions).where(eq(guestSessions.tokenHash, await hashGuestToken(token))).get()
  if (!row) throw new AccessCredentialError('invalid', '访客体验凭证无效', 401)
  if (row.status === 'claimed') throw new AccessCredentialError('claimed', '这次访客体验已经保存到登录账号', 409)
  if (row.status === 'replaced') throw new AccessCredentialError('replaced', '这次访客体验已经被新的体验替换', 409)
  if (row.status !== 'active' || row.expiresAt <= now.toISOString()) throw new AccessCredentialError('expired', '访客体验已过期，请重新开始', 401)
  if (!row.currentSandboxWorldId) throw new AccessCredentialError('invalid', '访客体验尚未准备完成', 409)
  const renewedAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
  await db.batch([
    db.update(guestSessions).set({ expiresAt, updatedAt: renewedAt }).where(eq(guestSessions.id, row.id)),
    db.update(demoSandboxes).set({ expiresAt }).where(and(eq(demoSandboxes.sessionId, row.id), eq(demoSandboxes.status, 'active'))),
  ])
  return {
    kind: 'guest', sessionId: row.id, ownerId: row.ownerUserId,
    worldId: row.currentSandboxWorldId, generation: row.generation, expiresAt,
  }
}

export const accessMiddleware = createMiddleware<{ Bindings: Env; Variables: AccessVariables }>(async (c, next) => {
  try {
    const access = await resolveAccessContext(createDb(c.env.DB), {
      authorization: c.req.header('Authorization'), guestToken: c.req.header(GUEST_TOKEN_HEADER),
    })
    c.set('access', access)
    await next()
  } catch (error) {
    if (error instanceof AccessCredentialError) return c.json({ error: error.message, code: error.code }, error.status)
    throw error
  }
})
