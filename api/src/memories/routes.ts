import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { createDb } from '../db/client'
import { memories, persons } from '../db/schema'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { clampImportance } from '../agent/memory'
import type { Env } from '../index'

export const memoryRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
memoryRoutes.use('*', authMiddleware)

/** 归属校验：记忆 → 人物 → 本人 */
async function loadOwnedMemory(db: ReturnType<typeof createDb>, memoryId: string, userId: string) {
  const m = await db.select().from(memories).where(eq(memories.id, memoryId)).get()
  if (!m) return null
  const person = await db
    .select({ id: persons.id })
    .from(persons)
    .where(and(eq(persons.id, m.personId), eq(persons.userId, userId)))
    .get()
  return person ? m : null
}

/** 校正记忆（记忆可审计，对标 Kindroid）：改内容 / 重要性 */
memoryRoutes.patch('/memories/:id', async (c) => {
  const body = await c.req.json<{ content?: string; importance?: number }>().catch(() => null)
  if (!body || (body.content === undefined && body.importance === undefined)) {
    return c.json({ error: '没有要修改的字段' }, 400)
  }
  const db = createDb(c.env.DB)
  const memory = await loadOwnedMemory(db, c.req.param('id'), c.get('user').id)
  if (!memory) return c.json({ error: '记忆不存在' }, 404)

  const patch: { content?: string; importance?: number } = {}
  if (body.content !== undefined) {
    const content = String(body.content).trim()
    if (!content) return c.json({ error: '内容不能为空' }, 400)
    patch.content = content
  }
  if (body.importance !== undefined) patch.importance = clampImportance(body.importance)
  await db.update(memories).set(patch).where(eq(memories.id, memory.id))
  return c.json({ ok: true })
})

/** 删除记忆（人物会立刻忘掉这件事） */
memoryRoutes.delete('/memories/:id', async (c) => {
  const db = createDb(c.env.DB)
  const memory = await loadOwnedMemory(db, c.req.param('id'), c.get('user').id)
  if (!memory) return c.json({ error: '记忆不存在' }, 404)
  await db.delete(memories).where(eq(memories.id, memory.id))
  return c.json({ ok: true })
})
