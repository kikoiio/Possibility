import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { events, memories, persons, personStates, worldCommands, worldFacts, worldPersons, timelines } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { executeTool, type ToolRunState } from './tools'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

describe('agent tool world-state boundary', () => {
  it('commits simulated act time, resident projection, immutable fact, and event atomically', async () => {
    fixture = await createWorldFixture()
    const f = fixture
    await f.db.insert(persons).values({ id: 'ada', userId: 'owner', name: 'Ada', modelJson: '{}', createdAt: WORLD_TIME })
    await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'ada', joinedAt: WORLD_TIME })
    await f.db.insert(personStates).values({ personId: 'ada', timelineId: 'home-main', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })

    const run: ToolRunState = {
      db: f.db, worldId: 'home-world', personId: 'ada', timelineId: 'home-main', runId: 'fork:one',
      isMain: false, mode: 'simulate', clock: Date.parse(WORLD_TIME), windowEnd: null,
      acts: 0, maxActs: 3, current: { location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Listen' },
    }
    const result = await executeTool(run, 'act', { title: '遇见邻居', description: '在咖啡馆和邻居交谈。' })
    const stateResult = await executeTool(run, 'update_state', { activity: '和邻居交谈' })
    const memoryResult = await executeTool(run, 'remember', { content: '邻居喜欢在咖啡馆读书', type: 'relationship', importance: 7 })
    const updatedTimeline = await f.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get()
    const state = await f.db.select().from(personStates).where(eq(personStates.personId, 'ada')).get()
    const commandRows = await f.db.select().from(worldCommands).all()
    const facts = await f.db.select().from(worldFacts).all()
    const eventRows = await f.db.select().from(events).all()
    const memoryRows = await f.db.select().from(memories).all()

    expect(result.result).toMatchObject({ ok: true, simTime: '2026-09-22T08:00:00.000Z' })
    expect(updatedTimeline?.simNow).toBe('2026-09-22T08:00:00.000Z')
    expect(state?.simTime).toBe(updatedTimeline?.simNow)
    expect(commandRows).toHaveLength(3)
    expect(facts).toHaveLength(3)
    expect(facts[0]?.simTime).toBe(updatedTimeline?.simNow)
    expect(eventRows).toHaveLength(4) // three primary state events + recorded experience
    expect(eventRows.some(event => event.title === '遇见邻居' && event.simTime === updatedTimeline?.simNow)).toBe(true)
    expect(stateResult.result).toMatchObject({ ok: true })
    expect(memoryResult.result).toMatchObject({ ok: true })
    expect(commandRows).toHaveLength(3)
    expect(facts).toHaveLength(3)
    expect(facts.find(fact => fact.visibility === 'private')?.factType).toBe('resident_state')
    expect(memoryRows.some(memory => memory.content === '邻居喜欢在咖啡馆读书')).toBe(true)
  })
})
