import { Hono } from 'hono'
import { createDb } from '../db/client'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import type { Env } from '../index'
import { readHome } from './queries'

export const homeRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
homeRoutes.use('*', authMiddleware)

homeRoutes.get('/', async c => {
  const user = c.get('user')
  return c.json(await readHome(createDb(c.env.DB), {
    kind: 'user', userId: user.id, ownerId: user.id, username: user.username, role: user.role,
  }))
})
