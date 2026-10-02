import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { personRoutes } from './routes'
import { createTestDb } from '../test/db'
import { persons, personStates, sessions, timelines, universeEvidence, universeRevisions, users, worldModelVersions, worlds, worldPersons } from '../db/schema'

const NOW = '2026-10-01T00:00:00.000Z'
let fixture: ReturnType<typeof createTestDb> | undefined
afterEach(() => { fixture?.close(); fixture = undefined })

async function setup() {
  fixture = createTestDb()
  await fixture.db.insert(users).values({
    id: 'u', username: 'u', passwordHash: 'x', createdAt: NOW,
  })
  await fixture.db.insert(sessions).values({ token: 'token', userId: 'u', expiresAt: '2099-01-01T00:00:00.000Z' })
  return fixture
}

describe('POST /api/persons', () => {
  it('creates only the person and ignores deprecated world and initial-state fields', async () => {
    const f = await setup()
    const response = await personRoutes.request('/', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '阿黛',
        model: { identity: ['一位植物学家'] },
        worldName: '旧世界名',
        worldDescription: '旧世界描述',
        initialState: { location: '温室', activity: '修剪花枝', mood: '专注', goal: '培育新花种' },
      }),
    }, f.env)

    expect(response.status).toBe(200)
    const { id: personId } = await response.json() as { id: string }
    const person = await f.db.select().from(persons).where(eq(persons.id, personId)).get()

    expect(person).toMatchObject({ id: personId, name: '阿黛', userId: 'u' })
    expect(await f.db.select().from(worlds).all()).toEqual([])
    expect(await f.db.select().from(timelines).all()).toEqual([])
    expect(await f.db.select().from(personStates).all()).toEqual([])
    expect(await f.db.select().from(worldModelVersions).all()).toEqual([])
    expect(await f.db.select().from(universeRevisions).all()).toEqual([])
    expect(await f.db.select().from(universeEvidence).all()).toEqual([])
    expect(await f.db.select().from(worldPersons).all()).toEqual([])
  })
})
