import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { buildAgentContext } from '../agent/context'
import { buildEngineContext, buildWorldSnapshot } from '../agent/engine-context'
import { buildBeatPrompt, buildDialoguePrompt, buildScenePrompt, buildSummaryPrompt } from '../agent/engine-prompt'
import { buildSystemPrompt } from '../agent/prompt'
import { persons, personStates, universeEvidence, worldFacts, worldPersons } from '../db/schema'
import { commitWorldCommand } from '../world-state/commit'
import { worldSnapshot } from '../worlds/queries'
import { createWorldFixture, WORLD_TIME } from './world-fixture'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

const CANARY = 'private-canary-731'
const CHAIN = 'relay-rumor-418'

async function setupJourney() {
  fixture = await createWorldFixture()
  const f = fixture
  const model = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [],
    boundaries: [], unknowns: [] })
  for (const id of ['ada', 'bo', 'cy', 'dax']) {
    await f.db.insert(persons).values({ id, userId: 'owner', name: id.toUpperCase(), modelJson: model,
      createdAt: WORLD_TIME })
    await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: id, joinedAt: WORLD_TIME })
    await f.db.insert(personStates).values({ personId: id, timelineId: 'home-main', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })
  }
  await f.db.insert(universeEvidence).values({ timelineId: 'home-main', level: 'complete', assessedVersion: 0,
    baselineVersion: 0, reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME }).onConflictDoNothing()

  let version = 0
  const commit = async (id: string, action: Parameters<typeof commitWorldCommand>[1]['action']) => {
    const result = await commitWorldCommand(f.db, { id, worldId: 'home-world', timelineId: 'home-main',
      userId: 'owner', expectedVersion: version, action })
    version = result.version
    return result
  }
  const weather = await commit('knowledge-weather', { type: 'environment', location: 'Cafe',
    condition: 'weather', value: 'rain' })
  await commit('knowledge-ada-fact', { type: 'inform', recipientId: 'ada', topic: 'weather',
    content: 'Cafe is rainy', sourceFactId: weather.factId })
  await commit('knowledge-ada-canary', { type: 'inform', recipientId: 'ada', topic: 'sealed note', content: CANARY })
  const boRumor = await commit('knowledge-bo-rumor', { type: 'inform', recipientId: 'bo', topic: 'old bell',
    content: CHAIN })
  await commit('knowledge-cy-relay', { type: 'inform', recipientId: 'cy', topic: 'old bell',
    content: `Bo repeated ${CHAIN}`, sourceFactId: boRumor.factId })
  return f
}

function promptText(value: { system: string; user: string }): string {
  return `${value.system}\n${value.user}`
}

describe('knowledge visibility across product channels', () => {
  it('uses the same recipient boundary in ordinary chat, scene, NPC dialogue, engine decisions and summaries', async () => {
    const f = await setupJourney()
    const adaChat = await buildAgentContext(f.db, { userId: 'owner', personId: 'ada', timelineId: 'home-main', mode: 'chat' })
    const daxChat = await buildAgentContext(f.db, { userId: 'owner', personId: 'dax', timelineId: 'home-main', mode: 'chat' })
    expect(buildSystemPrompt(adaChat!)).toContain(CANARY)
    expect(buildSystemPrompt(adaChat!)).toContain('[传闻；来源')
    expect(buildSystemPrompt(daxChat!)).not.toContain(CANARY)

    const snapshot = await buildWorldSnapshot(f.db, 'home-world', 'home-main')
    const ada = await buildEngineContext(f.db, 'ada', snapshot!)
    const dax = await buildEngineContext(f.db, 'dax', snapshot!)
    const adaChannels = [
      buildBeatPrompt(ada!, null, 30),
      buildDialoguePrompt(ada!, ['DAX'], [], { isLastTurn: false, location: 'Cafe' }),
      buildScenePrompt(ada!, { name: 'Visitor', profile: '' }, 'Cafe', []),
      buildSummaryPrompt(ada!, []),
    ]
    for (const prompt of adaChannels) expect(promptText(prompt)).toContain(CANARY)
    for (const prompt of [buildBeatPrompt(dax!, null, 30),
      buildDialoguePrompt(dax!, ['ADA'], [], { isLastTurn: false, location: 'Cafe' }),
      buildScenePrompt(dax!, { name: 'Visitor', profile: '' }, 'Cafe', []), buildSummaryPrompt(dax!, [])]) {
      expect(promptText(prompt)).not.toContain(CANARY)
    }
  })

  it('preserves rumor certainty over multiple relays and never exposes private facts in a public snapshot', async () => {
    const f = await setupJourney()
    const facts = await f.db.select().from(worldFacts).where(eq(worldFacts.factType, 'knowledge')).all()
    const values = facts.map(fact => ({ fact, value: JSON.parse(fact.valueJson) as Record<string, unknown> }))
    expect(values.find(row => row.value.recipientId === 'ada' && row.value.topic === 'weather')?.value.certainty).toBe('fact')
    expect(values.find(row => row.value.recipientId === 'bo')?.value.certainty).toBe('rumor')
    const cy = values.find(row => row.value.recipientId === 'cy')!
    expect(cy.value).toMatchObject({ certainty: 'rumor', sourceFactId: expect.any(String) })

    const publicView = await worldSnapshot(f.db, 'home-world', 'home-main')
    expect(JSON.stringify(publicView)).not.toContain(CANARY)
    expect(publicView?.currentFacts.every(fact => fact.factType !== 'knowledge')).toBe(true)
  })
})
