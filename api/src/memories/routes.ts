import { Hono, type Context } from 'hono'
import { and, eq } from 'drizzle-orm'
import { createDb } from '../db/client'
import { memories, persons, timelines } from '../db/schema'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import { clampImportance } from '../agent/memory'
import type { Env } from '../index'
import { commitWorldCommand } from '../world-state/commit'
import { WorldStateError, type WorldAction } from '../world-state/types'

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
type MemoryBody = { content?: string; importance?: number; timelineId?: string; expectedVersion?: number; commandId?: string;
  personId?: string;
  before?: { type: string; content: string; importance: number; simTime: string | null; createdAt: string; summarized: boolean } }

memoryRoutes.patch('/memories/:id', async (c) => {
  const body = await c.req.json<MemoryBody>().catch(() => null)
  if (!body || (body.content === undefined && body.importance === undefined)) {
    return c.json({ error: '没有要修改的字段' }, 400)
  }
  const db = createDb(c.env.DB)
  const memory = await loadOwnedMemory(db, c.req.param('id'), c.get('user').id)
  if (!memory && body?.timelineId && body.commandId) return versionedMemoryAction(c, db, null, body, 'memory_correct', {
    content: String(body.content ?? '').trim(), importance: clampImportance(body.importance ?? body.before?.importance ?? 5),
  }, c.req.param('id'))
  if (!memory) return c.json({ error: '记忆不存在' }, 404)

  const patch: { content?: string; importance?: number } = {}
  if (body.content !== undefined) {
    const content = String(body.content).trim()
    if (!content) return c.json({ error: '内容不能为空' }, 400)
    patch.content = content
  }
  if (body.importance !== undefined) patch.importance = clampImportance(body.importance)
  if (memory.timelineId !== null) {
    const result = await versionedMemoryAction(c, db, memory, body, 'memory_correct', {
      content: patch.content ?? body.before?.content ?? memory.content,
      importance: patch.importance ?? body.before?.importance ?? memory.importance,
    })
    return result
  }
  await db.update(memories).set(patch).where(eq(memories.id, memory.id))
  return c.json({ ok: true })
})

/** 删除记忆（人物会立刻忘掉这件事） */
memoryRoutes.delete('/memories/:id', async (c) => {
  const body = await c.req.json<MemoryBody>().catch(() => null)
  const db = createDb(c.env.DB)
  const memory = await loadOwnedMemory(db, c.req.param('id'), c.get('user').id)
  if (!memory && body?.timelineId && body.commandId) return versionedMemoryAction(c, db, null, body, 'memory_forget', undefined, c.req.param('id'))
  if (!memory) return c.json({ error: '记忆不存在' }, 404)
  if (memory.timelineId !== null) return versionedMemoryAction(c, db, memory, body, 'memory_forget')
  await db.delete(memories).where(eq(memories.id, memory.id))
  return c.json({ ok: true })
})

async function versionedMemoryAction(c: Context<{ Bindings: Env; Variables: AuthVariables }>, db: ReturnType<typeof createDb>,
  memory: Awaited<ReturnType<typeof loadOwnedMemory>> | null, body: MemoryBody | null,
  operation: 'memory_correct' | 'memory_forget', after?: { content: string; importance: number }, memoryId = memory?.id) {
  if (!body?.timelineId || !body.commandId || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion! < 0
    || !body.before || !(body.personId ?? memory?.personId) || !memoryId) {
    return c.json({ error: '缺少时间线、版本或记忆基准信息' }, 400)
  }
  const before = body.before
  if (memory && memory.timelineId !== body.timelineId) return c.json({ error: '时间线与记忆不匹配' }, 409)
  const timeline = await db.select().from(timelines).where(eq(timelines.id, body.timelineId)).get()
  if (!timeline) return c.json({ error: '时间线不存在' }, 404)
  const action: WorldAction = operation === 'memory_correct'
    ? { type: 'memory_correct', memoryId, personId: body.personId ?? memory!.personId, before, after: after! }
    : { type: 'memory_forget', memoryId, personId: body.personId ?? memory!.personId, before }
  try {
    const result = await commitWorldCommand(db, { id: body.commandId, worldId: timeline.worldId, timelineId: timeline.id,
      userId: c.get('user').id, expectedVersion: body.expectedVersion!, actorKind: 'owner', action })
    return c.json({ ok: true as const, version: result.version, replayed: result.replayed })
  } catch (error) {
    if (error instanceof WorldStateError) return c.json({ error: error.message }, error.status)
    throw error
  }
}
