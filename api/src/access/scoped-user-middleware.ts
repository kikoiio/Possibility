import { createMiddleware } from 'hono/factory'
import type { Env } from '../index'
import type { AuthVariables } from '../auth/middleware'
import { resolveAccessContext } from './middleware'
import { createDb } from '../db/client'

/** Adapts user-owned route handlers to guests, with an exact sandbox and route allowlist. */
export function scopedUserMiddleware(guestRouteAllowed: (method: string, path: string, worldId: string) => boolean) {
  return createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(async (c, next) => {
    const access = await resolveAccessContext(createDb(c.env.DB), {
      authorization: c.req.header('Authorization'),
      guestToken: c.req.header('X-Possibility-Guest'),
    }).catch(() => null)
    if (!access || access.kind === 'anonymous') return c.json({ error: '未登录或访客体验已失效' }, 401)
    if (access.kind === 'user') {
      c.set('user', { id: access.userId, username: access.username, role: access.role })
      await next()
      return
    }

    const match = c.req.path.match(/^(?:\/api)?\/worlds\/([^/]+)(?:\/|$)/)
    let requestedWorldId = ''
    try { requestedWorldId = match ? decodeURIComponent(match[1]!) : '' } catch { requestedWorldId = '' }
    if (requestedWorldId !== access.worldId || !guestRouteAllowed(c.req.method.toUpperCase(), c.req.path, access.worldId)) {
      return c.json({ error: '访客无权访问此接口或世界' }, 404)
    }
    c.set('user', { id: access.ownerId, username: '访客', role: 'user' })
    await next()
  })
}
