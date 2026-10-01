import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { memories, persons, universeEvidence, universeRevisions, worldCommands, worldFacts, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { auditUniverse } from '../world-state/invariants'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

describe('constructed memory maintenance routes', () => {
  it('turns edits and forgetting into private, replayable world commands', async () => {
    fixture = await createWorldFixture()
    const f = fixture
    await f.db.insert(universeEvidence).values({ timelineId: 'home-main', level: 'complete', assessedVersion: 0,
      baselineVersion: 0, reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME }).onConflictDoNothing()
    await f.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
    await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
    await f.db.insert(memories).values({ id: 'structured-memory', personId: 'resident', timelineId: 'home-main', type: 'thought',
      content: 'A quiet morning.', simTime: WORLD_TIME, createdAt: WORLD_TIME, importance: 5, summarized: false })
    const auth = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const before = { type: 'thought', content: 'A quiet morning.', importance: 5, simTime: WORLD_TIME,
      createdAt: WORLD_TIME, summarized: false }
    const corrected = await app.request('/api/memories/structured-memory', { method: 'PATCH', headers: auth,
      body: JSON.stringify({ content: 'A peaceful morning.', personId: 'resident', timelineId: 'home-main',
        expectedVersion: 0, commandId: 'route-correct-memory', before }) }, f.env)
    expect(corrected.status).toBe(200)
    expect(await corrected.json()).toMatchObject({ ok: true, version: 1, replayed: false })
    expect(await f.db.select().from(memories).where(eq(memories.id, 'structured-memory')).get())
      .toMatchObject({ content: 'A peaceful morning.' })
    const forgetBody = { personId: 'resident', timelineId: 'home-main', expectedVersion: 1,
      commandId: 'route-forget-memory', before: { ...before, content: 'A peaceful morning.' } }
    const forgotten = await app.request('/api/memories/structured-memory', { method: 'DELETE', headers: auth,
      body: JSON.stringify(forgetBody) }, f.env)
    expect(forgotten.status).toBe(200)
    expect(await forgotten.json()).toMatchObject({ ok: true, version: 2, replayed: false })
    const replay = await app.request('/api/memories/structured-memory', { method: 'DELETE', headers: auth,
      body: JSON.stringify(forgetBody) }, f.env)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ ok: true, version: 2, replayed: true })
    expect(await f.db.select().from(memories).where(eq(memories.id, 'structured-memory')).get()).toBeUndefined()
    expect(await f.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())
      .toMatchObject({ version: 2 })
    expect(await f.db.select().from(worldFacts).all()).toHaveLength(2)
    expect(await auditUniverse(f.db, 'home-world', 'home-main')).toEqual([])
  })

  it('closes the unlogged path: NULL-bucket memories now go through versioned commands', async () => {
    fixture = await createWorldFixture()
    const f = fixture
    await f.db.insert(universeEvidence).values({ timelineId: 'home-main', level: 'complete', assessedVersion: 0,
      baselineVersion: 0, reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME }).onConflictDoNothing()
    await f.db.insert(persons).values({ id: 'legacy-resident', userId: 'owner', name: 'Legacy', modelJson: '{}', createdAt: WORLD_TIME })
    await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'legacy-resident', joinedAt: WORLD_TIME })
    await f.db.insert(memories).values({ id: 'legacy-memory', personId: 'legacy-resident', timelineId: null, type: 'world',
      content: 'Old memory.', createdAt: WORLD_TIME, importance: 5 })
    const auth = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    // 旧式直改(无版本信息)被拒绝——直改直删不可追溯
    const direct = await app.request('/api/memories/legacy-memory', { method: 'PATCH', headers: auth,
      body: JSON.stringify({ content: 'Sneaky update.' }) }, f.env)
    expect(direct.status).toBe(400)
    expect(await f.db.select().from(memories).where(eq(memories.id, 'legacy-memory')).get())
      .toMatchObject({ content: 'Old memory.' })
    // 版本化路径:NULL 桶在主线可校正、可遗忘,全程入命令日志
    const before = { type: 'world', content: 'Old memory.', importance: 5, simTime: null,
      createdAt: WORLD_TIME, summarized: false }
    const corrected = await app.request('/api/memories/legacy-memory', { method: 'PATCH', headers: auth,
      body: JSON.stringify({ content: 'Updated old memory.', personId: 'legacy-resident', timelineId: 'home-main',
        expectedVersion: 0, commandId: 'legacy-correct', before }) }, f.env)
    expect(corrected.status).toBe(200)
    expect(await corrected.json()).toMatchObject({ ok: true, version: 1 })
    expect(await f.db.select().from(memories).where(eq(memories.id, 'legacy-memory')).get())
      .toMatchObject({ content: 'Updated old memory.', timelineId: null })
    const forgotten = await app.request('/api/memories/legacy-memory', { method: 'DELETE', headers: auth,
      body: JSON.stringify({ personId: 'legacy-resident', timelineId: 'home-main', expectedVersion: 1,
        commandId: 'legacy-forget', before: { ...before, content: 'Updated old memory.' } }) }, f.env)
    expect(forgotten.status).toBe(200)
    expect(await forgotten.json()).toMatchObject({ ok: true, version: 2 })
    expect(await f.db.select().from(memories).where(eq(memories.id, 'legacy-memory')).get()).toBeUndefined()
    expect((await f.db.select().from(worldCommands).all()).map((command) => command.type))
      .toEqual(['memory_correct', 'memory_forget'])
    // NULL 桶维护命令回放投影一致(主线桶匹配放宽)
    expect(await auditUniverse(f.db, 'home-world', 'home-main')).toEqual([])
  })
})
