import { afterEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { buildEngineContext, buildWorldSnapshot } from '../../agent/engine-context'
import { buildBeatPrompt } from '../../agent/engine-prompt'
import { dialogues, persons, personStates, worldPersons, worldFacts } from '../../db/schema'
import { createWorldFixture, WORLD_TIME } from '../../test/world-fixture'
import { commitWorldCommand } from '../../world-state/commit'
import { startNpcDialogue } from '../../world-state/system'
import { dialogueExecutor } from './dialogue'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null; vi.unstubAllGlobals() })

it('does not expose one resident’s private knowledge to another resident’s ordinary dialogue prompt', async () => {
  fixture = await createWorldFixture()
  const emptyModel = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] })
  await fixture.db.insert(persons).values([
    { id: 'resident-a', userId: 'owner', name: 'Resident A', modelJson: emptyModel, createdAt: WORLD_TIME },
    { id: 'resident-b', userId: 'owner', name: 'Resident B', modelJson: emptyModel, createdAt: WORLD_TIME },
  ])
  await fixture.db.insert(worldPersons).values([
    { worldId: 'home-world', personId: 'resident-a', joinedAt: WORLD_TIME },
    { worldId: 'home-world', personId: 'resident-b', joinedAt: WORLD_TIME },
  ])
  for (const personId of ['resident-a', 'resident-b']) {
    await fixture.db.insert(personStates).values({ personId, timelineId: 'home-main', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Talking', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })
  }
  await commitWorldCommand(fixture.db, { id: 'private-note', worldId: 'home-world', timelineId: 'home-main',
    userId: 'owner', expectedVersion: 0,
    action: { type: 'inform', recipientId: 'resident-a', topic: 'locked drawer', content: 'brass-key-secret-941 is hidden beneath the loose floorboard' } })
  const initialSnapshot = await buildWorldSnapshot(fixture.db, 'home-world', 'home-main')
  expect(initialSnapshot).not.toBeNull()
  const residentABeat = await buildEngineContext(fixture.db, 'resident-a', initialSnapshot!)
  const residentBBeat = await buildEngineContext(fixture.db, 'resident-b', initialSnapshot!)
  expect(buildBeatPrompt(residentABeat!, null, 60).system).toContain('brass-key-secret-941')
  expect(buildBeatPrompt(residentBBeat!, null, 60).system).not.toContain('brass-key-secret-941')
  await startNpcDialogue(fixture.db, { worldId: 'home-world', timelineId: 'home-main', sourceKey: 'private-knowledge-dialogue',
    participantIds: ['resident-a', 'resident-b'], location: 'Cafe', turnLimit: 2 })
  const dialogue = (await fixture.db.select().from(dialogues).where(eq(dialogues.timelineId, 'home-main')).get())!
  const prompts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
    prompts.push(request.messages.map(message => message.content).join('\n'))
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      utterance: 'The coffee is warm.', thought: 'This is a quiet afternoon.', shouldEnd: false, memory: null,
    }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))

  for (const personId of ['resident-a', 'resident-b']) {
    const snapshot = await buildWorldSnapshot(fixture.db, 'home-world', 'home-main')
    expect(snapshot).not.toBeNull()
    const step = { kind: 'dialogue_turn' as const, worldId: 'home-world', timelineId: 'home-main', personId,
      priority: 1, dialogueId: dialogue.id }
    const input = await dialogueExecutor.perceive(fixture.db, step, snapshot!)
    expect(input?.speakerId).toBe(personId)
    const reserve = Object.assign(async () => {}, { calls: 1 })
    const decision = await dialogueExecutor.decide(fixture.env, input!, { maxCalls: 1, reserve })
    expect(decision.value).not.toBeNull()
    await dialogueExecutor.act(fixture.db, fixture.env, input!, decision.value!)
  }

  expect(prompts).toHaveLength(2)
  expect(prompts[0]).toContain('brass-key-secret-941')
  expect(prompts[1]).not.toContain('brass-key-secret-941')
  expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.factType, 'knowledge')).all()).toHaveLength(1)
})
