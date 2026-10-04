import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { persons, residentMemorySafety, timelines, users, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'

describe('admin memory repair routes', () => {
  let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
  afterEach(() => { fixture?.close(); fixture = null })

  it('denies ordinary users and rejects batches outside the bounded range', async () => {
    fixture = await createWorldFixture()
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const denied = await app.request('/api/admin/memory-repair', { method: 'POST', headers,
      body: JSON.stringify({ worldId: 'home-world', timelineId: 'home-main', personId: 'ada', batchSize: 10 }),
    }, fixture.env)
    expect(denied.status).toBe(403)

    await fixture.db.update(users).set({ role: 'admin' }).where(eq(users.id, 'owner'))
    const invalid = await app.request('/api/admin/memory-repair', { method: 'POST', headers,
      body: JSON.stringify({ worldId: 'home-world', timelineId: 'home-main', personId: 'ada', batchSize: 5000 }),
    }, fixture.env)
    expect(invalid.status).toBe(400)

    await fixture.db.insert(persons).values({ id: 'ada', userId: 'owner', name: 'Ada', modelJson: '{}', createdAt: WORLD_TIME })
    await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'ada', joinedAt: WORLD_TIME })
    await fixture.db.insert(timelines).values({ id: 'fork', worldId: 'home-world', parentTimelineId: 'home-main',
      simNow: WORLD_TIME, createdAt: WORLD_TIME, ancestorIdsJson: '["home-main"]' })
    await fixture.db.insert(residentMemorySafety).values({ timelineId: 'fork', safeAfterCreatedAt: WORLD_TIME, createdAt: WORLD_TIME })
    const started = await app.request('/api/admin/memory-repair', { method: 'POST', headers,
      body: JSON.stringify({ worldId: 'home-world', timelineId: 'fork', personId: 'ada', batchSize: 1 }),
    }, fixture.env)
    expect(started.status).toBe(200)
    const run = await started.json() as { id: string; status: string }
    expect(run.status).toBe('completed')
    expect((await app.request(`/api/admin/memory-repair/${run.id}`, { headers }, fixture.env)).status).toBe(200)
  })
})
