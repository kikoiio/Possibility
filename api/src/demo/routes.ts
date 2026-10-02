import { Hono } from 'hono'
import type { Env } from '../index'
import { createDb } from '../db/client'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { GUEST_TOKEN_HEADER } from '../access/middleware'
import { accessMiddleware } from '../access/middleware'
import type { AccessVariables } from '../access/types'
import { resolveWorldScope } from '../access/world-scope'
import { forkTimeline } from '../life/fork'
import { compareTimelines } from '../life/compare'
import { timelines } from '../db/schema'
import { and, eq } from 'drizzle-orm'
import { claimGuestSession, ClaimVerificationError, createGuestSession, resetGuestSession, resumeGuestSession } from './session-service'

export const demoRoutes = new Hono<{ Bindings: Env }>()

demoRoutes.post('/session', async c => {
  const body = await c.req.json<{ requestId?: string }>().catch(() => null)
  try { return c.json(await createGuestSession(createDb(c.env.DB), body?.requestId?.trim() || crypto.randomUUID()), 201) }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : '访客体验创建失败' }, 503) }
})

demoRoutes.get('/session', async c => {
  const token = c.req.header(GUEST_TOKEN_HEADER)?.trim()
  if (!token) return c.json({ error: '缺少访客体验凭证' }, 401)
  const result = await resumeGuestSession(createDb(c.env.DB), token)
  return result ? c.json(result) : c.json({ error: '访客体验已过期，请重新开始' }, 401)
})

demoRoutes.post('/session/reset', async c => {
  const token = c.req.header(GUEST_TOKEN_HEADER)?.trim()
  const body = await c.req.json<{ requestId?: string }>().catch(() => null)
  if (!token || !body?.requestId?.trim()) return c.json({ error: '访客凭证和 requestId 必填' }, 400)
  const result = await resetGuestSession(createDb(c.env.DB), token, body.requestId.trim())
  return result ? c.json(result) : c.json({ error: '访客体验已过期，请重新开始' }, 401)
})

const claimRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
claimRoutes.use('*', authMiddleware)
claimRoutes.post('/', async c => {
  const token = c.req.header(GUEST_TOKEN_HEADER)?.trim()
  const body = await c.req.json<{ requestId?: string }>().catch(() => null)
  if (!token || !body?.requestId?.trim()) return c.json({ error: '访客凭证和 requestId 必填' }, 400)
  try {
    const result = await claimGuestSession(createDb(c.env.DB), { token, userId: c.get('user').id, requestId: body.requestId.trim() })
    return result ? c.json(result) : c.json({ error: '访客体验无法认领' }, 409)
  } catch (error) {
    // S2/F4/N5：核验失败返回可理解类别,访客副本保留可重试;内部 issue 只记服务端日志
    if (error instanceof ClaimVerificationError) {
      console.error('[claim] 保存核验未通过:', JSON.stringify(error.issues))
      return c.json({ error: '演示世界暂时无法保存，请稍后重试' }, 500)
    }
    throw error
  }
})
demoRoutes.route('/session/claim', claimRoutes)

const guestWorldRoutes = new Hono<{ Bindings: Env; Variables: AccessVariables }>()
guestWorldRoutes.use('*', accessMiddleware)
guestWorldRoutes.post('/:worldId/fork', async c => {
  const access = c.get('access')
  if (access.kind !== 'guest') return c.json({ error: '只有访客沙盒可使用此入口' }, 403)
  const db = createDb(c.env.DB)
  const scope = await resolveWorldScope(db, access, c.req.param('worldId'))
  if (!scope?.capabilities.fork) return c.json({ error: '世界不存在' }, 404)
  const body = await c.req.json<{ timelineId?: string; requestId?: string; whatIf?: string; changedVariable?: string }>().catch(() => null)
  if (!body?.timelineId || !body.requestId || !body.whatIf?.trim() || !body.changedVariable?.trim()) return c.json({ error: '分叉条件不完整' }, 400)
  const source = await db.select().from(timelines).where(and(eq(timelines.id, body.timelineId), eq(timelines.worldId, scope.world.id))).get()
  if (!source) return c.json({ error: '时间线不存在' }, 404)
  try {
    const result = await forkTimeline(db, scope.world.id, source.id, {
      whatIf: body.whatIf.trim(), changedVariable: body.changedVariable.trim(), startTime: source.simNow,
      participants: [], invariants: ['共同过去保持不变', '比较结果只表示记录到的差异'],
    }, body.requestId)
    return c.json({ id: result.id, simNow: result.simNow })
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : '创建平行宇宙失败' }, 409) }
})
guestWorldRoutes.get('/:worldId/compare', async c => {
  const access = c.get('access')
  if (access.kind !== 'guest') return c.json({ error: '只有访客沙盒可使用此入口' }, 403)
  const db = createDb(c.env.DB)
  const scope = await resolveWorldScope(db, access, c.req.param('worldId'))
  if (!scope?.capabilities.compare) return c.json({ error: '世界不存在' }, 404)
  const left = c.req.query('left'); const right = c.req.query('right')
  if (!left || !right) return c.json({ error: 'left 与 right 必填' }, 400)
  const result = await compareTimelines(db, scope.world.id, left, right)
  return result ? c.json(result) : c.json({ error: '时间线不存在' }, 404)
})
demoRoutes.route('/worlds', guestWorldRoutes)
