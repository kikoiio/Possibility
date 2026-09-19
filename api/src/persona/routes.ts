import { Hono } from 'hono'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { createDb, type Db } from '../db/client'
import { events, personaMessages, persons, timelines, worldPersons, worlds } from '../db/schema'
import { authMiddleware, type AuthVariables } from '../auth/middleware'
import type { PersonModel } from '../agent/types'
import type { Env } from '../index'

type World = typeof worlds.$inferSelect
type Person = typeof persons.$inferSelect

export const personaRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
personaRoutes.use('*', authMiddleware)

/** 用户在场身份的极简人物模型：身份即用户自述，其余留白（由相遇与记忆慢慢长出来） */
export function buildUserPersonaModel(description: string): PersonModel {
  return {
    identity: [{ text: description, provenance: 'known' }],
    behavior: [],
    speech: [],
    skills: [],
    memories: [],
    relationships: [],
    boundaries: [],
    unknowns: [],
  }
}

function personaDescription(p: Person): string {
  try {
    const model = JSON.parse(p.modelJson) as PersonModel
    return model.identity[0]?.text ?? ''
  } catch {
    return ''
  }
}

async function loadOwnedWorld(db: Db, worldId: string, userId: string): Promise<World | null> {
  const w = await db
    .select()
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.userId, userId)))
    .get()
  return w ?? null
}

/** 用户在某世界里的在场身份（isUser 人物）；每人每世界至多一个 */
async function loadPersona(db: Db, worldId: string, userId: string): Promise<Person | null> {
  const rows = await db
    .select({ person: persons })
    .from(worldPersons)
    .innerJoin(persons, eq(worldPersons.personId, persons.id))
    .where(and(eq(worldPersons.worldId, worldId), eq(persons.userId, userId), eq(persons.isUser, true)))
    .all()
  return rows[0]?.person ?? null
}

personaRoutes.get('/worlds/:id/persona', async (c) => {
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const persona = await loadPersona(db, world.id, c.get('user').id)
  if (!persona) return c.json({ persona: null, unread: 0 })
  const tl = await inboxTimeline(db, world.id, c.req.query('timelineId'))
  if (!tl) return c.json({ error: '时间线不存在' }, 404)
  const unread = await db
    .select({ n: personaMessages.id })
    .from(personaMessages)
    .where(and(eq(personaMessages.recipientPersonId, persona.id), eq(personaMessages.timelineId, tl.id), eq(personaMessages.read, false)))
    .all()
  return c.json({
    persona: { id: persona.id, name: persona.name, description: personaDescription(persona) },
    unread: unread.length,
  })
})

/** 登记/改写在场身份：在世界中成为有名有姓的人（可反复改写） */
personaRoutes.post('/worlds/:id/persona', async (c) => {
  const body = await c.req.json<{ name?: string; description?: string }>().catch(() => null)
  const name = body?.name?.trim()
  const description = body?.description?.trim()
  if (!name || name.length > 20) return c.json({ error: '名字必填（20 字内）' }, 400)
  if (!description || description.length > 500) return c.json({ error: '身份描述必填（500 字内）' }, 400)

  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const world = await loadOwnedWorld(db, c.req.param('id'), userId)
  if (!world) return c.json({ error: '世界不存在' }, 404)

  const existing = await loadPersona(db, world.id, userId)
  if (existing) {
    await db
      .update(persons)
      .set({ name, modelJson: JSON.stringify(buildUserPersonaModel(description)) })
      .where(eq(persons.id, existing.id))
    return c.json({ persona: { id: existing.id, name, description } })
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await db.insert(persons).values({
    id,
    userId,
    name,
    modelJson: JSON.stringify(buildUserPersonaModel(description)),
    isUser: true,
    createdAt: now,
  })
  await db.insert(worldPersons).values({ worldId: world.id, personId: id, joinedAt: now })
  return c.json({ persona: { id, name, description } })
})

async function inboxTimeline(db: Db, worldId: string, timelineId?: string) {
  const rows = await db.select().from(timelines).where(eq(timelines.worldId, worldId)).all()
  return timelineId ? rows.find(t => t.id === timelineId) : rows.find(t => !t.parentTimelineId)
}

/** 持久收件箱：读取没有副作用，已读内容仍可回看。 */
personaRoutes.get('/worlds/:id/persona/messages', async (c) => {
  const db = createDb(c.env.DB)
  const userId = c.get('user').id
  const world = await loadOwnedWorld(db, c.req.param('id'), userId)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const persona = await loadPersona(db, world.id, userId)
  if (!persona) return c.json({ error: '先在世界中登记你的在场身份' }, 400)

  const tl = await inboxTimeline(db, world.id, c.req.query('timelineId'))
  if (!tl) return c.json({ error: '时间线不存在' }, 404)
  const mentions = await db
        .select()
        .from(events)
        .where(
          and(
            eq(events.timelineId, tl.id),
            // 精确关联参与者 ID，不依赖可能重名/含通配符的用户名字。
            or(eq(events.actorPersonId, persona.id), sql`EXISTS (SELECT 1 FROM dialogues d, json_each(d.participant_ids_json) p WHERE d.id = ${events.dialogueId} AND p.value = ${persona.id})`),
          ),
        )
        .orderBy(desc(events.simTime))
        .limit(20)
        .all()

  // 发送者/行为者姓名映射（世界全部成员，含 isUser）
  const wpRows = await db.select().from(worldPersons).where(eq(worldPersons.worldId, world.id)).all()
  const memberRows = wpRows.length
    ? await db
        .select()
        .from(persons)
        .where(or(...wpRows.map((r) => eq(persons.id, r.personId))))
        .all()
    : []
  const nameOf = new Map(memberRows.map((p) => [p.id, p.name]))

  const messageRows = await db
    .select()
    .from(personaMessages)
    .where(and(eq(personaMessages.recipientPersonId, persona.id), eq(personaMessages.timelineId, tl.id)))
    .orderBy(desc(personaMessages.simTime))
    .limit(100)
    .all()

  return c.json({
    messages: messageRows.map((m) => ({
      id: m.id,
      read: m.read,
      timelineId: m.timelineId,
      fromName: nameOf.get(m.senderPersonId) ?? '某人',
      content: m.content,
      location: m.location,
      simTime: m.simTime,
    })),
    mentions: mentions.map((e) => ({
      id: e.id,
      simTime: e.simTime,
      title: e.title,
      description: e.description.slice(0, 120),
      actorName: e.actorPersonId ? (nameOf.get(e.actorPersonId) ?? null) : null,
    })),
  })
})

personaRoutes.post('/worlds/:id/persona/messages/read', async c => {
  const body = await c.req.json<{ timelineId?: string; ids?: string[] }>().catch(() => null)
  if (!body || !Array.isArray(body.ids) || body.ids.length > 100 || body.ids.some(id => typeof id !== 'string')) return c.json({ error: '无效留言列表' }, 400)
  const db = createDb(c.env.DB)
  const world = await loadOwnedWorld(db, c.req.param('id'), c.get('user').id)
  if (!world) return c.json({ error: '世界不存在' }, 404)
  const tl = await inboxTimeline(db, world.id, body.timelineId)
  const persona = await loadPersona(db, world.id, c.get('user').id)
  if (!tl || !persona) return c.json({ error: '身份或时间线不存在' }, 404)
  if (body.ids.length) await db.update(personaMessages).set({ read: true }).where(and(eq(personaMessages.recipientPersonId, persona.id), eq(personaMessages.timelineId, tl.id), inArray(personaMessages.id, body.ids)))
  return c.json({ ok: true })
})
