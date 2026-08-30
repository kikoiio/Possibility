import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { createDb, type Db } from '../db/client'
import { timelines, users } from '../db/schema'
import { migratePhase2Data } from '../db/migrate-data'
import { retrieveForPrompt, visibleMemories } from '../agent/memory'
import { hashPassword } from '../auth/password'
import { seedDemoWorld } from './seed-demo'
import type { Env } from '../index'

export const DEFAULT_ADMIN_USERNAME = 'admin'

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

function randomString(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}

async function createUser(db: Db, username: string, password: string) {
  await db.insert(users).values({
    id: crypto.randomUUID(),
    username,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
  })
}

/** 仅本地环境可用的种子数据路由（T6） */
export const devRoutes = new Hono<{ Bindings: Env }>()

devRoutes.post('/seed', async (c) => {
  if (c.env.ENVIRONMENT !== 'local') {
    return c.json({ error: '仅本地环境可用' }, 403)
  }
  const body = await c.req.json<{ random?: number }>().catch(() => ({}) as { random?: number })
  const randomCount = Math.min(Math.max(Number(body?.random) || 0, 0), 20)

  const db = createDb(c.env.DB)
  const accounts: { username: string; password?: string; note?: string }[] = []
  const adminCredentials = {
    username: c.env.DEV_ADMIN_USERNAME?.trim() || DEFAULT_ADMIN_USERNAME,
    password: c.env.DEV_ADMIN_PASSWORD?.trim() || randomString(16),
  }

  const adminExists = await db.select().from(users).where(eq(users.username, adminCredentials.username)).get()
  if (adminExists) {
    accounts.push({ username: adminCredentials.username, note: '已存在，密码保持不变' })
  } else {
    await createUser(db, adminCredentials.username, adminCredentials.password)
    accounts.push({ ...adminCredentials, note: '新建' })
  }

  for (let i = 0; i < randomCount; i++) {
    const creds = { username: `user_${randomString(6)}`, password: randomString(10) }
    await createUser(db, creds.username, creds.password)
    accounts.push(creds)
  }

  return c.json({ accounts })
})

/** 阶段二数据迁移（幂等，可重跑） */
devRoutes.post('/migrate-p2', async (c) => {
  if (c.env.ENVIRONMENT !== 'local') {
    return c.json({ error: '仅本地环境可用' }, 403)
  }
  const db = createDb(c.env.DB)
  const result = await migratePhase2Data(db)
  return c.json(result)
})

/** 演示世界「雾影庄」种子（按世界名幂等；需先 npm run seed 建 admin） */
devRoutes.post('/seed-demo', async (c) => {
  if (c.env.ENVIRONMENT !== 'local') {
    return c.json({ error: '仅本地环境可用' }, 403)
  }
  const db = createDb(c.env.DB)
  try {
    const adminUsername = c.env.DEV_ADMIN_USERNAME?.trim() || DEFAULT_ADMIN_USERNAME
    const result = await seedDemoWorld(db, adminUsername)
    return c.json(result)
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'seed-demo 失败' }, 400)
  }
})

/** 记忆检索插桩（本地验收用）：可见集与提示词检索集对比 */
devRoutes.get('/memory-debug', async (c) => {
  if (c.env.ENVIRONMENT !== 'local') {
    return c.json({ error: '仅本地环境可用' }, 403)
  }
  const personId = c.req.query('personId')
  const timelineId = c.req.query('timelineId')
  if (!personId || !timelineId) return c.json({ error: 'personId 与 timelineId 必填' }, 400)
  const db = createDb(c.env.DB)
  const timeline = await db.select().from(timelines).where(eq(timelines.id, timelineId)).get()
  if (!timeline) return c.json({ error: '时间线不存在' }, 404)
  const visible = await visibleMemories(db, personId, timeline)
  const retrieved = await retrieveForPrompt(db, personId, timeline)
  return c.json({
    visible: visible.map((m) => ({ id: m.id, timelineId: m.timelineId, createdAt: m.createdAt, summarized: m.summarized })),
    retrieved: retrieved.map((m) => ({ id: m.id, type: m.type, importance: m.importance, simTime: m.simTime })),
  })
})
