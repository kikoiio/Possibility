import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { personRoutes } from './routes'
import { createTestDb } from '../test/db'
import { persons, personStates, sessions, timelines, universeEvidence, universeRevisions, users, worldModelVersions, worlds, worldSceneRevisions, worldScenes } from '../db/schema'

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
  it('creates a paused default world with main timeline and complete initial evidence, without a scene revision', async () => {
    const f = await setup()
    const response = await personRoutes.request('/', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '阿黛',
        model: { identity: ['一位植物学家'] },
        initialState: { location: '温室', activity: '修剪花枝', mood: '专注', goal: '培育新花种' },
      }),
    }, f.env)

    expect(response.status).toBe(200)
    const { id: personId } = await response.json() as { id: string }
    const person = await f.db.select().from(persons).where(eq(persons.id, personId)).get()
    const world = await f.db.select().from(worlds).where(eq(worlds.userId, 'u')).get()
    const timeline = await f.db.select().from(timelines).where(eq(timelines.worldId, world!.id)).get()
    const state = await f.db.select().from(personStates).where(eq(personStates.personId, personId)).get()
    const modelVersion = await f.db.select().from(worldModelVersions).where(eq(worldModelVersions.worldId, world!.id)).get()
    const revision = await f.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timeline!.id)).get()
    const evidence = await f.db.select().from(universeEvidence).where(eq(universeEvidence.timelineId, timeline!.id)).get()

    expect(person).toMatchObject({ id: personId, name: '阿黛', userId: 'u' })
    expect(world).toMatchObject({ status: 'paused', name: '阿黛的世界' })
    expect(timeline).toMatchObject({ parentTimelineId: null })
    expect(state).toMatchObject({
      personId, timelineId: timeline!.id, location: '温室', activity: '修剪花枝', mood: '专注', goal: '培育新花种',
    })
    expect(modelVersion).toMatchObject({ worldId: world!.id, version: 1 })
    expect(revision).toMatchObject({ timelineId: timeline!.id, version: 0, worldModelVersion: 1 })
    expect(evidence).toMatchObject({
      timelineId: timeline!.id, level: 'complete', assessedVersion: 0, baselineVersion: 0, reasonCodesJson: '["created_complete"]',
    })
    expect(await f.db.select().from(worldScenes).where(eq(worldScenes.worldId, world!.id)).all()).toEqual([])
    expect(await f.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, world!.id)).all()).toEqual([])
  })
})
