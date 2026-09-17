import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { createDb, type Db } from '../db/client'
import { persons, worldPersons, worlds } from '../db/schema'
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
  return c.json({
    persona: persona ? { id: persona.id, name: persona.name, description: personaDescription(persona) } : null,
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
