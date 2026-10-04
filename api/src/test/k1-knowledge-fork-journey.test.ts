import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { buildEngineContext, buildWorldSnapshot } from '../agent/engine-context'
import { buildDialoguePrompt } from '../agent/engine-prompt'
import { buildResidentEvidence } from '../agent/resident-evidence'
import app from '../index'
import { dialogueTurns, dialogues, memories, persons, residentMemoryRepairItems, residentMemorySafety,
  llmCallLog, sessions, timelines, users, worldPersons, personStates, worldFacts } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from './world-fixture'
import { commitWorldCommand } from '../world-state/commit'
import { startNpcDialogue } from '../world-state/system'
import { forkTimeline } from '../life/fork'
import { dialogueExecutor } from '../engine/steps/dialogue'
import { visibleMemories } from '../agent/memory'

const modelJson = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [],
  relationships: [], boundaries: [], unknowns: [] })
const scenario = (whatIf: string) => ({ whatIf, startTime: WORLD_TIME, changedVariable: 'weather',
  participants: ['ada', 'bo', 'cy'], invariants: ['shared facts remain unchanged'] })

describe('K1 resident knowledge journeys', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('propagates a spoken rumor only through the fork, preserves its rumor wording, and carries it to descendants', async () => {
    const fixture = await createWorldFixture()
    try {
      await fixture.db.insert(persons).values(['ada', 'bo', 'cy'].map((id) => ({ id, userId: 'owner', name: id.toUpperCase(), modelJson, createdAt: WORLD_TIME })))
      await fixture.db.insert(worldPersons).values(['ada', 'bo', 'cy'].map((personId) => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
      await fixture.db.insert(personStates).values(['ada', 'bo', 'cy'].map((personId) => ({ personId, timelineId: 'home-main',
        simTime: WORLD_TIME, location: 'Cafe', activity: 'Talking', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })))
      await commitWorldCommand(fixture.db, { id: 'seed-private-rumor', worldId: 'home-world', timelineId: 'home-main',
        userId: 'owner', expectedVersion: 0, action: { type: 'inform', recipientId: 'ada', topic: 'sealed note',
          content: 'brass-key-secret-941 may be under the chapel' } })

      const fork = await forkTimeline(fixture.db, 'home-world', 'home-main', scenario('Ada mentions the note'), 'k1-fork')
      const sibling = await forkTimeline(fixture.db, 'home-world', 'home-main', scenario('Ada stays silent'), 'k1-sibling')
      const siblingSnapshot = await buildWorldSnapshot(fixture.db, 'home-world', sibling.id)
      const siblingBo = await buildEngineContext(fixture.db, 'bo', siblingSnapshot!)
      expect(siblingBo?.knownFacts?.some(fact => fact.text.includes('brass-key-secret-941'))).toBe(false)

      await startNpcDialogue(fixture.db, { worldId: 'home-world', timelineId: fork.id, sourceKey: 'k1-spoken-rumor',
        participantIds: ['ada', 'bo'], location: 'Cafe', turnLimit: 2 })
      const dialogue = (await fixture.db.select().from(dialogues).where(eq(dialogues.timelineId, fork.id)).get())!
      const utterances = [
        'I heard brass-key-secret-941 may be under the chapel; that is a rumor, not a confirmed fact.',
        'Ada said brass-key-secret-941 may be under the chapel, and she called it a rumor; I have not verified it.',
      ]
      const memoriesFromTurns = [
        null,
        { content: 'Ada mentioned brass-key-secret-941 as a rumor; I have not verified it.', importance: 7 },
      ]
      const prompts: string[] = []
      let responseIndex = 0
      vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
        prompts.push(request.messages.map(message => message.content).join('\n'))
        const index = responseIndex++
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          utterance: utterances[index], thought: 'I should distinguish what I heard from what I verified.',
          shouldEnd: false, memory: memoriesFromTurns[index],
        }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }))

      for (const personId of ['ada', 'bo']) {
        const snapshot = await buildWorldSnapshot(fixture.db, 'home-world', fork.id)
        const step = { kind: 'dialogue_turn' as const, worldId: 'home-world', timelineId: fork.id,
          personId, priority: 1, dialogueId: dialogue.id }
        const input = await dialogueExecutor.perceive(fixture.db, step, snapshot!)
        expect(input?.speakerId).toBe(personId)
        if (personId === 'bo') {
          expect(input?.ctx.knownFacts?.some(fact => fact.text.includes('brass-key-secret-941'))).toBe(false)
          expect(input?.prompt.system).toContain(utterances[0])
          expect(input?.prompt.system).toContain('转述中的传闻仍是传闻')
        }
        const reserve = Object.assign(async () => 'test-receipt', { calls: 1, settle: async () => {} })
        const decision = await dialogueExecutor.decide(fixture.env, input!, { maxCalls: 1, reserve,
          llm: { baseUrl: 'https://stub.example.com', apiKey: 'test-only', model: 'stub', source: 'env',
            apiKeySource: 'platform_fallback', apiKeyVerified: false } })
        expect(decision.value).not.toBeNull()
        await dialogueExecutor.act(fixture.db, fixture.env, input!, decision.value!)
      }

      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toContain('[传闻；来源')
      expect(prompts[0]).toContain('brass-key-secret-941')
      expect(prompts[1]).toContain(utterances[0])
      expect(prompts[1]).toContain('转述中的传闻仍是传闻')
      const boMemory = (await fixture.db.select().from(memories).where(eq(memories.personId, 'bo')).all())
        .find(memory => memory.content.includes('brass-key-secret-941'))
      expect(boMemory?.content).toContain('as a rumor')
      expect((await fixture.db.select().from(worldFacts).where(eq(worldFacts.factType, 'knowledge')).all())
        .some(fact => fact.timelineId === fork.id && JSON.parse(fact.valueJson).recipientId === 'bo')).toBe(false)

      const forkEvidence = await buildResidentEvidence(fixture.db, { timelineId: fork.id, personId: 'bo', knownFacts: [] })
      const parentEvidence = await buildResidentEvidence(fixture.db, { timelineId: 'home-main', personId: 'bo', knownFacts: [] })
      const siblingEvidence = await buildResidentEvidence(fixture.db, { timelineId: sibling.id, personId: 'bo', knownFacts: [] })
      expect(forkEvidence.map(item => item.content)).toEqual(expect.arrayContaining([expect.stringContaining(utterances[0])]))
      expect(parentEvidence).toEqual([])
      expect(siblingEvidence).toEqual([])

      await fixture.db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, sibling.id))
      const descendant = await forkTimeline(fixture.db, 'home-world', fork.id, scenario('Bo remembers the rumor'), 'k1-descendant')
      const descendantEvidence = await buildResidentEvidence(fixture.db, { timelineId: descendant.id, personId: 'bo', knownFacts: [] })
      expect(descendantEvidence.map(item => item.content)).toEqual(expect.arrayContaining([expect.stringContaining(utterances[0])]))
      expect(JSON.stringify(descendantEvidence)).not.toContain('I should distinguish')
    } finally { fixture.close() }
  })

  it('runs an admin repair journey across an interrupted cursor and keeps unreconstructable history hidden', async () => {
    const fixture = await createWorldFixture()
    try {
      await fixture.db.insert(persons).values(['ada', 'bo'].map(id => ({ id, userId: 'owner', name: id.toUpperCase(),
        modelJson, createdAt: WORLD_TIME })))
      await fixture.db.insert(worldPersons).values(['ada', 'bo'].map(personId => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
      const forkTime = '2026-09-22T00:00:00.000Z'
      await fixture.db.insert(timelines).values({ id: 'repair-fork', worldId: 'home-world', parentTimelineId: 'home-main',
        simNow: forkTime, createdAt: forkTime, ancestorIdsJson: '["home-main"]' })
      await fixture.db.insert(residentMemorySafety).values({ timelineId: 'repair-fork', safeAfterCreatedAt: '2026-10-01T00:00:00.000Z',
        createdAt: '2026-10-01T00:00:00.000Z' })
      await fixture.db.insert(dialogues).values({ id: 'repair-talk', timelineId: 'repair-fork', location: 'Cafe',
        participantIdsJson: '["ada","bo"]', status: 'completed', turnLimit: 8, simStart: forkTime, simEnd: forkTime })
      await fixture.db.insert(dialogueTurns).values({ id: 'repair-turn', dialogueId: 'repair-talk', turnIndex: 0, personId: 'bo',
        utterance: 'Tomorrow the bridge opens', thought: 'private thought is excluded', simTime: forkTime, createdAt: forkTime })
      await fixture.db.insert(memories).values([
        { id: 'repair-supported', personId: 'ada', timelineId: 'repair-fork', type: 'summary',
          content: 'bo说过：「Tomorrow the bridge opens」', createdAt: '2026-09-23T00:00:00.000Z', importance: 7 },
        { id: 'repair-unsupported', personId: 'ada', timelineId: 'repair-fork', type: 'summary',
          content: 'constructor-only secret is hidden below the chapel', createdAt: '2026-09-24T00:00:00.000Z', importance: 8 },
      ])
      await fixture.db.update(users).set({ role: 'admin' }).where(eq(users.id, 'owner'))
      await fixture.db.insert(sessions).values({ token: 'other-token', userId: 'other', expiresAt: '2099-01-01T00:00:00.000Z' })
      const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
      const budgetBefore = await fixture.db.select().from(llmCallLog).all()
      const start = () => fixture.db.select().from(memories).where(eq(memories.id, 'repair-supported')).get()
      const first = await app.request('/api/admin/memory-repair', { method: 'POST', headers,
        body: JSON.stringify({ worldId: 'home-world', timelineId: 'repair-fork', personId: 'ada', batchSize: 1 }),
      }, fixture.env)
      expect(first.status).toBe(200)
      const run = await first.json() as { id: string; status: string; scanned: number; cursorMemoryId: string | null }
      expect(run).toMatchObject({ status: 'running', scanned: 1, cursorMemoryId: 'repair-supported' })
      expect(await start()).toMatchObject({ id: 'repair-supported', content: 'bo说过：「Tomorrow the bridge opens」' })
      const status = await app.request(`/api/admin/memory-repair/${run.id}`, { headers }, fixture.env)
      expect(await status.json()).toMatchObject({ status: 'running', cursorMemoryId: 'repair-supported' })

      const second = await app.request('/api/admin/memory-repair', { method: 'POST', headers,
        body: JSON.stringify({ worldId: 'home-world', timelineId: 'repair-fork', personId: 'ada', batchSize: 1 }),
      }, fixture.env)
      expect(await second.json()).toMatchObject({ status: 'running', scanned: 2, cursorMemoryId: 'repair-unsupported' })
      const finish = await app.request('/api/admin/memory-repair', { method: 'POST', headers,
        body: JSON.stringify({ worldId: 'home-world', timelineId: 'repair-fork', personId: 'ada', batchSize: 1 }),
      }, fixture.env)
      expect(await finish.json()).toMatchObject({ status: 'completed', rebuilt: 1, unreconstructable: 1 })
      expect(await fixture.db.select().from(residentMemoryRepairItems).all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceMemoryId: 'repair-supported', status: 'rebuilt', sourceIdsJson: '["repair-turn"]' }),
        expect.objectContaining({ sourceMemoryId: 'repair-unsupported', status: 'unreconstructable', replacementMemoryId: null }),
      ]))
      const safetyTimeline = (await fixture.db.select().from(timelines).where(eq(timelines.id, 'repair-fork')).get())!
      const visible = await visibleMemories(fixture.db, 'ada', safetyTimeline)
      expect(visible.map(memory => memory.id)).toContain('resident-rebuilt:repair-supported')
      expect(visible.map(memory => memory.id)).not.toContain('repair-unsupported')
      expect(JSON.stringify(visible)).not.toContain('constructor-only secret')
      expect(await fixture.db.select().from(llmCallLog).all()).toEqual(budgetBefore)

      const denied = await app.request(`/api/admin/memory-repair/${run.id}`, { headers: { Authorization: 'Bearer other-token' } }, fixture.env)
      expect(denied.status).toBe(403)
    } finally { fixture.close() }
  })
})
