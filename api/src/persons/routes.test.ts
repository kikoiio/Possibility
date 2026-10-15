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

  it('normalizes provenance when creating a person', async () => {
    const f = await setup()
    const response = await personRoutes.request('/', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '阿黛',
        model: {
          identity: [
            { text: '来自描述', provenance: 'known' },
            { text: '模型补写', provenance: 'inferred' },
            { text: '来源无效', provenance: 'verified' },
          ],
          unknowns: ['  未知信息  ', '  '],
        },
      }),
    }, f.env)

    expect(response.status).toBe(200)
    const { id: personId } = await response.json() as { id: string }
    const person = await f.db.select().from(persons).where(eq(persons.id, personId)).get()
    expect(JSON.parse(person!.modelJson)).toMatchObject({
      identity: [
        { text: '来自描述', provenance: 'known' },
        { text: '模型补写', provenance: 'inferred' },
        { text: '来源无效', provenance: 'inferred' },
      ],
      unknowns: ['未知信息'],
    })
  })
})

describe('person provenance API', () => {
  it('keeps a confirmed item known after update and detail reload', async () => {
    const f = await setup()
    const createResponse = await personRoutes.request('/', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '阿黛',
        model: { identity: [{ text: '来自描述', provenance: 'inferred' }] },
      }),
    }, f.env)
    const { id: personId } = await createResponse.json() as { id: string }

    const updateResponse = await personRoutes.request(`/${personId}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: { identity: [{ text: '来自描述', provenance: 'known' }] } }),
    }, f.env)
    expect(updateResponse.status).toBe(200)

    const detailResponse = await personRoutes.request(`/${personId}`, {
      headers: { Authorization: 'Bearer token' },
    }, f.env)
    expect(detailResponse.status).toBe(200)
    const detail = await detailResponse.json() as { person: { model: { identity: Array<{ text: string; provenance: string }> } } }
    expect(detail.person.model.identity).toEqual([{ text: '来自描述', provenance: 'known' }])
  })

  it('reads legacy items with missing or invalid provenance as inferred', async () => {
    const f = await setup()
    await f.db.insert(persons).values({
      id: 'legacy-person',
      userId: 'u',
      name: '旧人物',
      modelJson: JSON.stringify({
        identity: ['旧字符串', { text: '旧对象' }, { text: '无效来源', provenance: 'verified' }],
      }),
      createdAt: NOW,
    })

    const response = await personRoutes.request('/legacy-person', {
      headers: { Authorization: 'Bearer token' },
    }, f.env)
    expect(response.status).toBe(200)
    const detail = await response.json() as { person: { model: { identity: Array<{ text: string; provenance: string }> } } }
    expect(detail.person.model.identity).toEqual([
      { text: '旧字符串', provenance: 'inferred' },
      { text: '旧对象', provenance: 'inferred' },
      { text: '无效来源', provenance: 'inferred' },
    ])

    const updateResponse = await personRoutes.request('/legacy-person', {
      method: 'PUT',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '修订人物' }),
    }, f.env)
    expect(updateResponse.status).toBe(200)
    const updatedPerson = await f.db.select().from(persons).where(eq(persons.id, 'legacy-person')).get()
    expect(JSON.parse(updatedPerson!.modelJson).identity).toEqual([
      { text: '旧字符串', provenance: 'inferred' },
      { text: '旧对象', provenance: 'inferred' },
      { text: '无效来源', provenance: 'inferred' },
    ])
  })

  it('rejects updates from a non-owner', async () => {
    const f = await setup()
    await f.db.insert(users).values({
      id: 'other', username: 'other', passwordHash: 'x', createdAt: NOW,
    })
    await f.db.insert(sessions).values({ token: 'other-token', userId: 'other', expiresAt: '2099-01-01T00:00:00.000Z' })
    await f.db.insert(persons).values({
      id: 'owned-person', userId: 'u', name: '阿黛',
      modelJson: JSON.stringify({ identity: [{ text: '原内容', provenance: 'known' }] }), createdAt: NOW,
    })

    const response = await personRoutes.request('/owned-person', {
      method: 'PUT',
      headers: { Authorization: 'Bearer other-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: { identity: [{ text: '篡改内容', provenance: 'known' }] } }),
    }, f.env)

    expect(response.status).toBe(404)
    const person = await f.db.select().from(persons).where(eq(persons.id, 'owned-person')).get()
    expect(JSON.parse(person!.modelJson)).toEqual({ identity: [{ text: '原内容', provenance: 'known' }] })
  })
})
