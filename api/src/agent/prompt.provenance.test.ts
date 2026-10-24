import { afterEach, describe, expect, it } from 'vitest'
import { persons, personStates, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { buildSchedulePrompt } from './engine-prompt'
import { buildAgentContext } from './context'
import { buildSystemPrompt } from './prompt'
import type { AgentContextData } from './context'
import type { EngineContext } from './engine-context'
import type { PersonModel } from './types'

const model = {
  identity: [
    { text: '创作者明确提供的住址', provenance: 'known' },
    { text: '旧记录缺失来源', provenance: undefined },
    { text: '来源值无效', provenance: 'verified' },
  ],
  behavior: [{ text: '补写的行为习惯', provenance: 'inferred' }],
  speech: [], skills: [], memories: [], relationships: [],
  boundaries: [{ text: '模型补写的行为边界', provenance: undefined }],
  unknowns: ['她不知道旧书的来历'],
} as unknown as PersonModel

const person = { id: 'ada', name: 'Ada' }
const timeline = { id: 'main', worldId: 'world', parentTimelineId: null, simNow: '2026-10-01T10:00:00.000Z' }
const world = { id: 'world', name: 'Town', description: '', timeZone: 'UTC' }
const state = { personId: 'ada', timelineId: 'main', simTime: timeline.simNow,
  location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Rest' }
let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

function makeChatContext() {
  return {
    person, model, world, timeline, mainTimelineId: 'main', isMain: true,
    memories: [], knownFacts: [], state, mode: 'chat',
  } as unknown as AgentContextData
}

function makeEngineContext() {
  return {
    snapshot: { world, locations: [], timeline, persons: [], models: new Map(), states: new Map(),
      schedules: new Map(), worldDate: timeline.simNow.slice(0, 10) },
    person, model, state, others: [], memories: [], knownFacts: [],
    unperceivedEvents: [], sameLocationAwake: [], scheduleItems: null,
  } as unknown as EngineContext
}

function expectProvenancePrompt(prompt: string) {
  expect(prompt).toContain('- 创作者明确提供的住址')
  expect(prompt).not.toContain('- 创作者明确提供的住址（推断）')
  expect(prompt).toContain('- 旧记录缺失来源（推断）')
  expect(prompt).toContain('- 来源值无效（推断）')
  expect(prompt).toContain('- 补写的行为习惯（推断）')
  expect(prompt).toContain('- 模型补写的行为边界（推断）')
  expect(prompt).toContain('她不知道旧书的来历')
  expect(prompt).toContain('坦然说不知道，绝不编造细节')
  expect(prompt).not.toContain('现实已验证')
}

describe('resident prompt provenance', () => {
  it('marks legacy or invalid entries conservatively in ordinary chat prompts', () => {
    expectProvenancePrompt(buildSystemPrompt(makeChatContext()))
  })

  it('marks the same entries and unknown boundary in simulation prompts', () => {
    const prompt = buildSchedulePrompt(makeEngineContext()).system
    expectProvenancePrompt(prompt)
  })

  it('normalizes a legacy database model before building the ordinary chat prompt', async () => {
    fixture = await createWorldFixture()
    await fixture.db.insert(persons).values({ id: 'ada', userId: 'owner', name: 'Ada',
      modelJson: JSON.stringify(model), createdAt: WORLD_TIME })
    await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'ada', joinedAt: WORLD_TIME })
    await fixture.db.insert(personStates).values({ personId: 'ada', timelineId: 'home-main', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Rest', updatedRealAt: WORLD_TIME })

    const context = await buildAgentContext(fixture.db, {
      userId: 'owner', personId: 'ada', timelineId: 'home-main', mode: 'chat',
    })

    expect(context).not.toBeNull()
    expect(context?.model.identity).toEqual([
      { text: '创作者明确提供的住址', provenance: 'known' },
      { text: '旧记录缺失来源', provenance: 'inferred' },
      { text: '来源值无效', provenance: 'inferred' },
    ])
    expectProvenancePrompt(buildSystemPrompt(context!))
  })
})
