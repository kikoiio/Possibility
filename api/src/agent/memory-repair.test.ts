import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { dialogues, dialogueTurns, llmCallLog, memories, persons, residentMemoryRepairItems, residentMemorySafety,
  timelines, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { oldestCompressible, retrieveForPrompt, visibleMemories } from './memory'
import { repairResidentTimelineMemories } from './memory-repair'

describe('resident memory repair', () => {
  it('rebuilds only verbatim resident-visible evidence, retains originals and resumes idempotently', async () => {
    const fixture = await createWorldFixture()
    try {
      await fixture.db.insert(persons).values([
        { id: 'ada', userId: 'owner', name: 'Ada', modelJson: '{}', createdAt: WORLD_TIME },
        { id: 'bo', userId: 'owner', name: 'Bo', modelJson: '{}', createdAt: WORLD_TIME },
      ])
      await fixture.db.insert(worldPersons).values(['ada', 'bo'].map(personId => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
      const forkTime = '2026-09-22T00:00:00.000Z'
      await fixture.db.insert(timelines).values({ id: 'fork', worldId: 'home-world', parentTimelineId: 'home-main',
        forkScenarioJson: JSON.stringify({ whatIf: 'creator-only' }), simNow: forkTime, createdAt: forkTime,
        ancestorIdsJson: '["home-main"]' })
      await fixture.db.insert(residentMemorySafety).values({ timelineId: 'fork', safeAfterCreatedAt: '2026-10-01T00:00:00.000Z',
        createdAt: '2026-10-01T00:00:00.000Z' })
      await fixture.db.insert(memories).values([
        { id: 'legacy-supported', personId: 'ada', timelineId: 'fork', type: 'summary',
          content: 'bo说过：「Tomorrow the bridge opens」', createdAt: '2026-09-23T00:00:00.000Z', importance: 7 },
        { id: 'legacy-private', personId: 'ada', timelineId: 'fork', type: 'summary',
          content: 'The constructor secret is hidden below the chapel', createdAt: '2026-09-24T00:00:00.000Z', importance: 8 },
      ])
      await fixture.db.insert(dialogues).values({ id: 'talk', timelineId: 'fork', location: 'Cafe',
        participantIdsJson: '["ada","bo"]', status: 'completed', turnLimit: 8, simStart: forkTime, simEnd: forkTime })
      await fixture.db.insert(dialogueTurns).values({ id: 'turn-bo', dialogueId: 'talk', turnIndex: 0, personId: 'bo',
        utterance: 'Tomorrow the bridge opens', thought: 'I know the constructor secret is hidden below the chapel',
        simTime: forkTime, createdAt: forkTime })
      const llmCallsBefore = await fixture.db.select().from(llmCallLog).all()

      const first = await repairResidentTimelineMemories(fixture.db, { worldId: 'home-world', timelineId: 'fork', personId: 'ada', batchSize: 1 })
      expect(first).toMatchObject({ status: 'running', scanned: 1 })
      const second = await repairResidentTimelineMemories(fixture.db, { worldId: 'home-world', timelineId: 'fork', personId: 'ada', batchSize: 1 })
      expect(second.id).toBe(first.id)
      expect(second).toMatchObject({ status: 'running', scanned: 2, rebuilt: 1, unreconstructable: 1 })
      const completed = await repairResidentTimelineMemories(fixture.db, { worldId: 'home-world', timelineId: 'fork', personId: 'ada', batchSize: 1 })
      expect(completed).toMatchObject({ status: 'completed', scanned: 2, rebuilt: 1, unreconstructable: 1 })
      expect(await fixture.db.select().from(residentMemoryRepairItems).where(eq(residentMemoryRepairItems.runId, first.id)).all())
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ sourceMemoryId: 'legacy-supported', status: 'rebuilt', sourceIdsJson: '["turn-bo"]' }),
          expect.objectContaining({ sourceMemoryId: 'legacy-private', status: 'unreconstructable', replacementMemoryId: null }),
        ]))
      const replacement = await fixture.db.select().from(memories).where(eq(memories.id, 'resident-rebuilt:legacy-supported')).get()
      expect(replacement?.content).toBe('bo说过：「Tomorrow the bridge opens」')
      expect(replacement?.content).not.toContain('constructor secret')
      expect(await fixture.db.select().from(memories).where(eq(memories.id, 'legacy-private')).get()).toMatchObject({
        content: 'The constructor secret is hidden below the chapel',
      })
      expect((await visibleMemories(fixture.db, 'ada', (await fixture.db.select().from(timelines).where(eq(timelines.id, 'fork')).get())!))
        .map(memory => memory.id)).toContain('resident-rebuilt:legacy-supported')
      expect((await visibleMemories(fixture.db, 'ada', (await fixture.db.select().from(timelines).where(eq(timelines.id, 'fork')).get())!))
        .map(memory => memory.id)).not.toContain('legacy-private')
      const fork = (await fixture.db.select().from(timelines).where(eq(timelines.id, 'fork')).get())!
      const retrieved = await retrieveForPrompt(fixture.db, 'ada', fork)
      expect(retrieved.map(memory => memory.id)).toContain('resident-rebuilt:legacy-supported')
      expect(retrieved.map(memory => memory.id)).not.toContain('legacy-private')
      expect((await oldestCompressible(fixture.db, 'ada', fork, 0, 10)).map(memory => memory.id))
        .not.toContain('legacy-private')

      const resumed = await repairResidentTimelineMemories(fixture.db, { worldId: 'home-world', timelineId: 'fork', personId: 'ada', batchSize: 1 })
      expect(resumed.id).toBe(first.id)
      expect(resumed.rebuilt).toBe(1)
      expect(await fixture.db.select().from(memories).where(eq(memories.id, 'resident-rebuilt:legacy-supported')).all()).toHaveLength(1)
      expect(await fixture.db.select().from(llmCallLog).all()).toEqual(llmCallsBefore)
    } finally { fixture.close() }
  })
})
