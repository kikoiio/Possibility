import { afterEach, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  dialogueTurns, dialogues, memories, personaMessages, persons, personStates, universeEvidence, universeRevisions,
  worldCommands, worldModelVersions, worldPersons,
} from '../db/schema'
import { createWorldFixture, WORLD_TIME } from './world-fixture'
import { commitWorldCommand } from '../world-state/commit'
import { collectReplayInput, readCurrentProjection } from '../world-state/evidence'
import { createRootProjectionBaseline } from '../world-state/model'
import { rebuildProjection } from '../world-state/rebuild'
import type { WorldAction } from '../world-state/types'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

const ALL_COMMAND_TYPES = [
  'enter', 'move', 'environment', 'intervention', 'inform', 'commitment', 'commitment_proposal', 'conversation',
  'dialogue_start', 'scene_open', 'dialogue_turn', 'clock_advance', 'simulation_checkpoint', 'dialogue_recovery',
  'schedule_set', 'memory_summary', 'memory_correct', 'memory_forget', 'resident_state',
] as const satisfies readonly WorldAction['type'][]

async function expectCompleteReplay() {
  const evidence = await collectReplayInput(fixture!.db, 'home-world', 'home-main')
  const current = await readCurrentProjection(fixture!.db, 'home-world', 'home-main')
  const replay = await rebuildProjection(fixture!.db, 'home-world', 'home-main', evidence, current)
  expect(replay, JSON.stringify(replay.differences, null, 2)).toMatchObject({ status: 'complete', differences: [] })
}

it('replays every normal command category through the real commit path with zero projection differences', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  const resident = { personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Learn', currentDialogueId: null,
    lastBeatSimTime: null, updatedRealAt: WORLD_TIME }
  const visitor = { personId: 'visitor', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Visiting', mood: 'Curious', goal: 'Talk', currentDialogueId: null,
    lastBeatSimTime: null, updatedRealAt: WORLD_TIME }
  const editableMemory = { id: 'editable-memory', personId: 'resident', timelineId: 'home-main', type: 'thought',
    content: 'The old note may be useful.', simTime: WORLD_TIME, createdAt: WORLD_TIME, importance: 4, summarized: false,
    mentionedPersonIdsJson: null, locationName: null, topicsJson: null, level: null }
  const forgottenMemory = { id: 'forgotten-memory', personId: 'resident', timelineId: 'home-main', type: 'thought',
    content: 'A detail that can be forgotten.', simTime: WORLD_TIME, createdAt: WORLD_TIME, importance: 2, summarized: false,
    mentionedPersonIdsJson: null, locationName: null, topicsJson: null, level: null }
  await f.db.insert(persons).values([
    { id: 'resident', userId: 'owner', name: 'Ada', modelJson: '{}', createdAt: WORLD_TIME },
    { id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME },
    { id: 'newcomer', userId: 'owner', name: 'Bo', modelJson: '{}', createdAt: WORLD_TIME },
  ])
  await f.db.insert(worldPersons).values(['resident', 'visitor', 'newcomer'].map(personId => ({
    worldId: 'home-world', personId, joinedAt: WORLD_TIME,
  })))
  await f.db.insert(personStates).values([resident, visitor])
  await f.db.insert(memories).values([editableMemory, forgottenMemory])
  const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [resident, visitor])
  baseline.rows.memories = [editableMemory, forgottenMemory]
  await f.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
    modelJson: JSON.stringify({ name: 'Home world', description: 'A small town',
      locations: [{ name: 'Cafe', description: '' }, { name: 'Library', description: '' }],
      residents: [{ id: 'resident', name: 'Ada', model: {} }, { id: 'visitor', name: 'Visitor', model: {} },
        { id: 'newcomer', name: 'Bo', model: {} }], projectionBaseline: baseline }) })
  await f.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME,
    worldModelVersion: 1, updatedAt: WORLD_TIME })

  let version = 0
  const committedTypes = new Set<WorldAction['type']>()
  const commit = async (id: string, action: WorldAction, actor: { actorKind?: 'owner' | 'visitor' | 'system'; actorPersonId?: string } = {}) => {
    const result = await commitWorldCommand(f.db, { id, worldId: 'home-world', timelineId: 'home-main',
      userId: 'owner', expectedVersion: version, action, ...actor })
    expect(result.version).toBe(++version)
    committedTypes.add(action.type)
    await expectCompleteReplay()
    return result
  }

  await commit('matrix-environment', { type: 'environment', location: 'Cafe', condition: 'weather', value: 'rain' })
  await commit('matrix-intervention', { type: 'intervention', requestId: 'matrix-story', text: 'The bell rings.' })
  await commit('matrix-inform', { type: 'inform', recipientId: 'resident', topic: 'weather', content: 'Rain is coming.' })
  await commit('matrix-enter', { type: 'enter', personId: 'newcomer', to: 'Library' })
  const AFTER_CLOCK = '2026-09-21T08:01:00.000Z'
  await commit('matrix-clock', { type: 'clock_advance', from: WORLD_TIME, to: AFTER_CLOCK,
    observedAt: WORLD_TIME }, { actorKind: 'system' })
  await commit('matrix-move', { type: 'move', personId: 'newcomer', to: 'Cafe' })
  await commit('matrix-schedule', { type: 'schedule_set', personId: 'resident', worldDate: '2026-09-21',
    generatedAt: AFTER_CLOCK, items: [
      { start: '00:00', end: '08:00', location: 'Cafe', activity: 'Sleep', kind: 'sleep' },
      { start: '08:00', end: '12:00', location: 'Cafe', activity: 'Read' },
      { start: '12:00', end: '14:00', location: 'Library', activity: 'Research' },
      { start: '14:00', end: '16:00', location: 'Cafe', activity: 'Discuss' },
      { start: '16:00', end: '20:00', location: 'Cafe', activity: 'Write' },
      { start: '20:00', end: '00:00', location: 'Cafe', activity: 'Rest', kind: 'sleep' },
    ] }, { actorKind: 'system' })
  await commit('matrix-state', { type: 'resident_state', personId: 'resident', cause: 'beat',
    windowStart: AFTER_CLOCK, patch: { activity: 'Watching the rain', mood: 'Thoughtful', goal: 'Warn Bo',
    }, events: [{ simTime: AFTER_CLOCK, title: 'Ada watches the rain',
      description: 'Ada notices the weather changing.' }], memories: [{ type: 'thought',
      content: 'The rain is getting stronger.', importance: 5 }] }, { actorKind: 'system' })
  await commit('matrix-checkpoint', { type: 'simulation_checkpoint', personId: 'resident',
    lastBeatSimTime: AFTER_CLOCK }, { actorKind: 'system' })

  await commit('matrix-scene-open', { type: 'scene_open', dialogueId: 'scene', visitorId: 'visitor',
    participantIds: ['visitor', 'resident'], location: 'Cafe', turnLimit: 100 },
  { actorKind: 'visitor', actorPersonId: 'visitor' })
  const conversationAction: Extract<WorldAction, { type: 'conversation' }> = {
    type: 'conversation', dialogueId: 'scene', requestId: 'scene-request',
    turns: [{ id: 'visitor-turn', personId: 'visitor', utterance: 'Can we meet later?' },
      { id: 'resident-turn', personId: 'resident', utterance: 'Yes, at the cafe.' }],
    sceneProjection: { location: 'Cafe', participantIds: ['visitor', 'resident'], simTime: AFTER_CLOCK,
      turnLimit: 100, createdAt: WORLD_TIME },
    acceptedCommitments: [{ id: 'accepted-meeting', personId: 'resident', title: 'Meet later', kind: 'meeting',
      location: 'Cafe', dueSim: '2026-09-21T08:20:00.000Z' }],
    privateEffects: { memories: [{ id: 'scene-thought', personId: 'resident', type: 'thought',
      content: 'Remember the meeting.', importance: 5, simTime: AFTER_CLOCK, createdAt: WORLD_TIME }],
    messages: [{ id: 'scene-message', senderPersonId: 'resident', recipientPersonId: 'visitor',
      content: 'See you later.', location: 'Cafe', simTime: AFTER_CLOCK, createdAt: WORLD_TIME }] } }
  const conversationResult = await commitWorldCommand(f.db, { id: 'matrix-conversation', worldId: 'home-world',
    timelineId: 'home-main', userId: 'owner', expectedVersion: version, action: conversationAction,
    actorKind: 'visitor', actorPersonId: 'visitor' }, [
    f.db.insert(dialogueTurns).values([
      { id: 'visitor-turn', dialogueId: 'scene', turnIndex: 0, personId: 'visitor', utterance: 'Can we meet later?',
        thought: '', simTime: AFTER_CLOCK, createdAt: WORLD_TIME },
      { id: 'resident-turn', dialogueId: 'scene', turnIndex: 1, personId: 'resident', utterance: 'Yes, at the cafe.',
        thought: 'Remember the meeting.', simTime: AFTER_CLOCK, createdAt: WORLD_TIME },
    ]),
    f.db.insert(memories).values({ id: 'scene-thought', personId: 'resident', timelineId: 'home-main', type: 'thought',
      content: 'Remember the meeting.', importance: 5, simTime: AFTER_CLOCK, createdAt: WORLD_TIME, summarized: false }),
    f.db.insert(personaMessages).values({ id: 'scene-message', worldId: 'home-world', timelineId: 'home-main',
      senderPersonId: 'resident', recipientPersonId: 'visitor', content: 'See you later.', location: 'Cafe',
      simTime: AFTER_CLOCK, read: false, createdAt: WORLD_TIME }),
  ])
  expect(conversationResult.version).toBe(++version)
  committedTypes.add('conversation')
  await expectCompleteReplay()
  await commit('matrix-commitment-fulfilled', { type: 'commitment', commitmentId: 'accepted-meeting', next: 'fulfilled' })
  await commit('matrix-proposal', { type: 'commitment_proposal', commitmentId: 'second-meeting',
    personId: 'resident', visitorId: 'visitor', sourceDialogueId: 'scene', title: 'Meet tomorrow', kind: 'meeting',
    location: 'Cafe', dueSim: '2026-09-22T09:00:00.000Z' })
  await commit('matrix-proposal-declined', { type: 'commitment', commitmentId: 'second-meeting', next: 'declined' })

  await commit('matrix-dialogue-start', { type: 'dialogue_start', dialogueId: 'npc-dialogue',
    participantIds: ['resident', 'newcomer'], location: 'Cafe', turnLimit: 2 }, { actorKind: 'system' })
  await commit('matrix-dialogue-a', { type: 'dialogue_turn', dialogueId: 'npc-dialogue', speakerId: 'resident',
    turnIndex: 0, utterance: 'The rain is strong.', thought: 'Warn Bo.',
    memory: { content: 'I warned Bo about the rain.', importance: 5 }, shouldEnd: false }, { actorKind: 'system' })
  await commit('matrix-dialogue-b', { type: 'dialogue_turn', dialogueId: 'npc-dialogue', speakerId: 'newcomer',
    turnIndex: 1, utterance: 'I will stay inside.', thought: 'Be careful.', memory: null, shouldEnd: false },
  { actorKind: 'system' })

  await commit('matrix-summary', { type: 'memory_summary', personId: 'resident',
    sourceMemoryIds: ['matrix-state:memory:0', 'scene-thought'], summaryId: 'matrix-summary-memory',
    content: 'Ada remembered the rain and the planned meeting.', importance: 7, simTime: AFTER_CLOCK,
    createdAt: WORLD_TIME }, { actorKind: 'system' })
  // S2：L2 上卷——源为刚压出的 L1，负载带层级与合并标注，双轨物化一致
  await commit('matrix-summary-l2', { type: 'memory_summary', personId: 'resident',
    sourceMemoryIds: ['matrix-summary-memory'], summaryId: 'matrix-summary-l2-memory',
    content: 'A week of rain, warnings and meetings, condensed.', importance: 6, level: 2,
    mentions: ['newcomer'], location: 'Cafe', topics: ['rain'],
    simTime: AFTER_CLOCK, createdAt: WORLD_TIME }, { actorKind: 'system' })
  await commit('matrix-memory-correct', { type: 'memory_correct', memoryId: 'editable-memory', personId: 'resident',
    before: { type: 'thought', content: 'The old note may be useful.', importance: 4, simTime: WORLD_TIME,
      createdAt: WORLD_TIME, summarized: false }, after: { content: 'The corrected note is useful.', importance: 6 } })
  await commit('matrix-memory-forget', { type: 'memory_forget', memoryId: 'forgotten-memory', personId: 'resident',
    before: { type: 'thought', content: 'A detail that can be forgotten.', importance: 2, simTime: WORLD_TIME,
      createdAt: WORLD_TIME, summarized: false } })
  expect([...committedTypes].sort()).toEqual(ALL_COMMAND_TYPES.filter(type => type !== 'dialogue_recovery').sort())
  expect([...new Set((await f.db.select().from(worldCommands)).map(command => command.type))].sort())
    .toEqual(ALL_COMMAND_TYPES.filter(type => type !== 'dialogue_recovery').sort())
})

it('replays the stale dialogue recovery path from an immutable inconsistent baseline', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  const state = { personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME, location: 'Cafe',
    activity: 'Waiting', mood: 'Calm', goal: 'Recover', currentDialogueId: 'stale-dialogue',
    lastBeatSimTime: null, updatedRealAt: WORLD_TIME }
  const staleDialogue = { id: 'stale-dialogue', timelineId: 'home-main', location: 'Cafe',
    participantIdsJson: JSON.stringify(['resident', 'other-resident']), status: 'ended', turnLimit: 2,
    simStart: WORLD_TIME, simEnd: WORLD_TIME, kind: 'npc', visitorId: null, sceneBusyUntil: null }
  await f.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Ada', modelJson: '{}', createdAt: WORLD_TIME })
  await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await f.db.insert(personStates).values(state)
  await f.db.insert(dialogues).values(staleDialogue)
  const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [state])
  baseline.rows.dialogues = [staleDialogue]
  await f.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
    modelJson: JSON.stringify({ name: 'Home world', description: 'A small town', locations: [],
      residents: [{ id: 'resident', name: 'Ada', model: {} }], projectionBaseline: baseline }) })
  await f.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME,
    worldModelVersion: 1, updatedAt: WORLD_TIME })

  await commitWorldCommand(f.db, { id: 'matrix-dialogue-recovery', worldId: 'home-world', timelineId: 'home-main',
    userId: 'owner', actorKind: 'system', expectedVersion: 0,
    action: { type: 'dialogue_recovery', personId: 'resident', dialogueId: 'stale-dialogue' } })

  expect((await f.db.select().from(personStates).where(eq(personStates.personId, 'resident')).get())?.currentDialogueId)
    .toBeNull()
  await expectCompleteReplay()
  expect((await f.db.select().from(universeEvidence).where(eq(universeEvidence.timelineId, 'home-main')).get())?.assessedVersion)
    .toBe(1)
})
