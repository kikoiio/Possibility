import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { commitments, dialogueTurns, dialogues, events, memories, personStates, persons, schedules, timelines, universeRevisions, worldCommands, worldFacts, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { commitWorldCommand } from './commit'

const base = { worldId: 'home-world', timelineId: 'home-main', userId: 'owner' }
let f: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { f?.close(); f = null })

async function setup() {
  f = await createWorldFixture()
  await f.db.insert(persons).values([
    { id: 'resident-a', userId: 'owner', name: 'Ada', modelJson: '{}', createdAt: WORLD_TIME },
    { id: 'resident-b', userId: 'owner', name: 'Bo', modelJson: '{}', createdAt: WORLD_TIME },
  ])
  await f.db.insert(worldPersons).values(['resident-a', 'resident-b'].map(personId => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
  await f.db.insert(personStates).values(['resident-a', 'resident-b'].map(personId => ({ personId, timelineId: 'home-main',
    simTime: WORLD_TIME, location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })))
  return f
}

async function expectNoAcceptedCommand(fixture: Awaited<ReturnType<typeof setup>>) {
  expect(await fixture.db.select().from(worldCommands)).toHaveLength(0)
  expect(await fixture.db.select().from(worldFacts)).toHaveLength(0)
  expect(await fixture.db.select().from(events)).toHaveLength(0)
  expect((await fixture.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())?.version).toBe(0)
}

describe('跨投影原子失败矩阵', () => {
  it.each([
    ['environment fact', 'failed-environment', { type: 'environment', location: 'Cafe', condition: 'weather', value: 'rain' }],
    ['intervention fact', 'failed-intervention', { type: 'intervention', requestId: 'story-change', text: 'The rain begins.' }],
    ['private knowledge fact', 'failed-inform', { type: 'inform', recipientId: 'resident-a', topic: 'weather', content: 'Rain is coming.' }],
  ] as const)('%s failure rolls back its fact and versioned event', async (_label, commandId, action) => {
    const fixture = await setup()
    fixture.sqlite.exec("CREATE TRIGGER reject_action_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'forced action failure'); END")
    await expect(commitWorldCommand(fixture.db, { ...base, id: commandId, expectedVersion: 0, action })).rejects.toThrow()
    await expectNoAcceptedCommand(fixture)
  })

  it('enter 回滚版本、事实、事件和新进入居民状态', async () => {
    const fixture = await setup()
    await fixture.db.delete(personStates).where(eq(personStates.personId, 'resident-a'))
    fixture.sqlite.exec("CREATE TRIGGER reject_enter_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'forced enter failure'); END")
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'failed-enter', expectedVersion: 0,
      action: { type: 'enter', personId: 'resident-a', to: 'Library' } })).rejects.toThrow()
    await expectNoAcceptedCommand(fixture)
    expect(await fixture.db.select().from(personStates).where(eq(personStates.personId, 'resident-a'))).toHaveLength(0)
  })

  it('schedule_set 回滚 command、revision、fact 与日程', async () => {
    const fixture = await setup()
    const items = [
      { start: '00:00', end: '04:00', location: 'Cafe', activity: 'Sleep', kind: 'sleep' as const },
      { start: '04:00', end: '08:00', location: 'Cafe', activity: 'Wake' },
      { start: '08:00', end: '12:00', location: 'Library', activity: 'Read' },
      { start: '12:00', end: '16:00', location: 'Cafe', activity: 'Eat' },
      { start: '16:00', end: '20:00', location: 'Library', activity: 'Write' },
      { start: '20:00', end: '00:00', location: 'Cafe', activity: 'Rest' },
    ]
    fixture.sqlite.exec("CREATE TRIGGER reject_schedule BEFORE INSERT ON schedules BEGIN SELECT RAISE(ABORT, 'forced schedule failure'); END")
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'failed-schedule', actorKind: 'system', expectedVersion: 0,
      action: { type: 'schedule_set', personId: 'resident-a', worldDate: WORLD_TIME.slice(0, 10), generatedAt: WORLD_TIME, items } })).rejects.toThrow()
    await expectNoAcceptedCommand(fixture)
    expect(await fixture.db.select().from(schedules)).toHaveLength(0)
  })

  it('memory_summary 回滚摘要插入和来源记忆摘要标记', async () => {
    const fixture = await setup()
    await fixture.db.insert(memories).values({ id: 'source-memory', personId: 'resident-a', timelineId: 'home-main',
      type: 'relationship', content: 'Ada and Bo met.', simTime: WORLD_TIME, createdAt: WORLD_TIME, importance: 5, summarized: false })
    fixture.sqlite.exec("CREATE TRIGGER reject_summary BEFORE INSERT ON memories WHEN NEW.id = 'summary-memory' BEGIN SELECT RAISE(ABORT, 'forced summary failure'); END")
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'failed-summary', actorKind: 'system', expectedVersion: 0,
      action: { type: 'memory_summary', personId: 'resident-a', sourceMemoryIds: ['source-memory'], summaryId: 'summary-memory',
        content: 'They met by the cafe.', importance: 7, simTime: WORLD_TIME, createdAt: WORLD_TIME } })).rejects.toThrow()
    await expectNoAcceptedCommand(fixture)
    expect(await fixture.db.select().from(memories)).toMatchObject([
      expect.objectContaining({ id: 'source-memory', summarized: false }),
    ])
  })

  it('memory_correct 回滚旧记忆修改和版本记录', async () => {
    const fixture = await setup()
    await fixture.db.insert(memories).values({ id: 'correctable-memory', personId: 'resident-a', timelineId: 'home-main',
      type: 'relationship', content: 'They met.', simTime: WORLD_TIME, createdAt: WORLD_TIME, importance: 5, summarized: false })
    fixture.sqlite.exec("CREATE TRIGGER reject_memory_correction BEFORE UPDATE ON memories BEGIN SELECT RAISE(ABORT, 'forced correction failure'); END")
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'failed-correction', expectedVersion: 0,
      action: { type: 'memory_correct', personId: 'resident-a', memoryId: 'correctable-memory',
        before: { type: 'relationship', content: 'They met.', importance: 5, simTime: WORLD_TIME, createdAt: WORLD_TIME, summarized: false },
        after: { content: 'They met at the cafe.', importance: 6 } } })).rejects.toThrow()
    await expectNoAcceptedCommand(fixture)
    expect(await fixture.db.select().from(memories).where(eq(memories.id, 'correctable-memory')).get())
      .toMatchObject({ content: 'They met.', importance: 5 })
    fixture.sqlite.exec('DROP TRIGGER reject_memory_correction')
    fixture.sqlite.exec("CREATE TRIGGER reject_memory_forget BEFORE DELETE ON memories BEGIN SELECT RAISE(ABORT, 'forced forget failure'); END")
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'failed-forget', expectedVersion: 0,
      action: { type: 'memory_forget', personId: 'resident-a', memoryId: 'correctable-memory',
        before: { type: 'relationship', content: 'They met.', importance: 5, simTime: WORLD_TIME, createdAt: WORLD_TIME, summarized: false } } })).rejects.toThrow()
    await expectNoAcceptedCommand(fixture)
    expect(await fixture.db.select().from(memories).where(eq(memories.id, 'correctable-memory')).get()).toMatchObject({ content: 'They met.' })
  })

  it('dialogue_recovery 回滚占用清除与版本记录', async () => {
    const fixture = await setup()
    await fixture.db.insert(dialogues).values({ id: 'ended-dialogue', timelineId: 'home-main', location: 'Cafe',
      participantIdsJson: JSON.stringify(['resident-a', 'resident-b']), status: 'ended', kind: 'npc', turnLimit: 4, simStart: WORLD_TIME, simEnd: WORLD_TIME })
    await fixture.db.update(personStates).set({ currentDialogueId: 'ended-dialogue' }).where(eq(personStates.personId, 'resident-a'))
    fixture.sqlite.exec("CREATE TRIGGER reject_recovery BEFORE UPDATE OF current_dialogue_id ON person_states WHEN NEW.current_dialogue_id IS NULL BEGIN SELECT RAISE(ABORT, 'forced recovery failure'); END")
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'failed-recovery', actorKind: 'system', expectedVersion: 0,
      action: { type: 'dialogue_recovery', personId: 'resident-a', dialogueId: 'ended-dialogue' } })).rejects.toThrow()
    await expectNoAcceptedCommand(fixture)
    expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'resident-a')).get())?.currentDialogueId).toBe('ended-dialogue')
  })

  it('simulation_checkpoint 回滚居民水位线和版本记录', async () => {
    const fixture = await setup()
    fixture.sqlite.exec("CREATE TRIGGER reject_checkpoint BEFORE UPDATE OF last_beat_sim_time ON person_states BEGIN SELECT RAISE(ABORT, 'forced checkpoint failure'); END")
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'failed-checkpoint', actorKind: 'system', expectedVersion: 0,
      action: { type: 'simulation_checkpoint', personId: 'resident-a', lastBeatSimTime: WORLD_TIME } })).rejects.toThrow()
    await expectNoAcceptedCommand(fixture)
    expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'resident-a')).get())?.lastBeatSimTime).toBeNull()
  })

  it('scene_open 回滚交谈投影与版本记录', async () => {
    const fixture = await setup()
    await fixture.db.update(persons).set({ isUser: true }).where(eq(persons.id, 'resident-b'))
    fixture.sqlite.exec("CREATE TRIGGER reject_scene_open BEFORE INSERT ON dialogues BEGIN SELECT RAISE(ABORT, 'forced scene open failure'); END")
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'failed-scene-open', actorKind: 'visitor', actorPersonId: 'resident-b', expectedVersion: 0,
      action: { type: 'scene_open', dialogueId: 'scene', visitorId: 'resident-b', participantIds: ['resident-a', 'resident-b'], location: 'Cafe', turnLimit: 8 } })).rejects.toThrow()
    await expectNoAcceptedCommand(fixture)
    expect(await fixture.db.select().from(dialogues)).toHaveLength(0)
    expect(await fixture.db.select().from(personStates).where(eq(personStates.currentDialogueId, 'scene'))).toHaveLength(0)
  })

  it('dialogue_turn 回滚发言、思考记忆与参与者占用状态', async () => {
    const fixture = await setup()
    await fixture.db.insert(dialogues).values({ id: 'npc-dialogue', timelineId: 'home-main', location: 'Cafe',
      participantIdsJson: JSON.stringify(['resident-a', 'resident-b']), status: 'ongoing', kind: 'npc', turnLimit: 8, simStart: WORLD_TIME })
    await fixture.db.update(personStates).set({ currentDialogueId: 'npc-dialogue' })
    fixture.sqlite.exec("CREATE TRIGGER reject_dialogue_turn BEFORE INSERT ON events WHEN NEW.dialogue_id = 'npc-dialogue' BEGIN SELECT RAISE(ABORT, 'forced dialogue turn failure'); END")
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'failed-dialogue-turn', actorKind: 'system', expectedVersion: 0,
      action: { type: 'dialogue_turn', dialogueId: 'npc-dialogue', speakerId: 'resident-a', turnIndex: 0,
        utterance: 'The rain stopped.', thought: 'I should check the path.', memory: { content: 'We talked about rain.', importance: 5 }, shouldEnd: false } })).rejects.toThrow()
    await expectNoAcceptedCommand(fixture)
    expect(await fixture.db.select().from(dialogueTurns)).toHaveLength(0)
    expect(await fixture.db.select().from(memories)).toHaveLength(0)
    expect((await fixture.db.select().from(dialogues).where(eq(dialogues.id, 'npc-dialogue')).get())?.status).toBe('ongoing')
    expect(await fixture.db.select().from(personStates).where(eq(personStates.currentDialogueId, 'npc-dialogue'))).toHaveLength(2)
  })

  it('commitment proposal 回滚 proposed commitment、event 和版本记录', async () => {
    const fixture = await setup()
    await fixture.db.update(persons).set({ isUser: true }).where(eq(persons.id, 'resident-b'))
    await fixture.db.insert(dialogues).values({ id: 'scene-source', timelineId: 'home-main', location: 'Cafe',
      participantIdsJson: JSON.stringify(['resident-a', 'resident-b']), status: 'scene', kind: 'scene', visitorId: 'resident-b',
      turnLimit: 8, simStart: WORLD_TIME, simEnd: WORLD_TIME })
    fixture.sqlite.exec("CREATE TRIGGER reject_proposal_event BEFORE INSERT ON events WHEN NEW.dialogue_id = 'scene-source' BEGIN SELECT RAISE(ABORT, 'forced proposal failure'); END")
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'failed-proposal', expectedVersion: 0,
      action: { type: 'commitment_proposal', commitmentId: 'proposed-meeting', personId: 'resident-a', visitorId: 'resident-b',
        sourceDialogueId: 'scene-source', title: 'Meet tomorrow', kind: 'meeting', location: 'Cafe', dueSim: '2026-09-21T09:00:00.000Z' } })).rejects.toThrow()
    await expectNoAcceptedCommand(fixture)
    expect(await fixture.db.select().from(commitments)).toHaveLength(0)
  })

  it('clock_advance rolls back clock projection and all versioned history when fact insertion fails', async () => {
    const fixture = await setup()
    fixture.sqlite.exec("CREATE TRIGGER reject_clock_fact BEFORE INSERT ON world_facts WHEN NEW.fact_type = 'clock' BEGIN SELECT RAISE(ABORT, 'forced clock failure'); END")
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'failed-clock', actorKind: 'system', expectedVersion: 0,
      action: { type: 'clock_advance', from: WORLD_TIME, to: '2026-09-21T08:01:00.000Z', observedAt: WORLD_TIME } })).rejects.toThrow()
    await expectNoAcceptedCommand(fixture)
    expect((await fixture.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())?.simNow).toBe(WORLD_TIME)
  })

  it('commitment transition rolls back status, event, memory, fact and revision together', async () => {
    const fixture = await setup()
    await fixture.db.insert(commitments).values({ id: 'meeting', worldId: 'home-world', timelineId: 'home-main',
      personId: 'resident-a', visitorId: 'resident-b', sourceDialogueId: null, title: 'Meet at the cafe', kind: 'meeting',
      location: 'Cafe', dueSim: '2026-09-21T09:00:00.000Z', status: 'proposed', createdSim: WORLD_TIME, updatedSim: WORLD_TIME, createdAt: WORLD_TIME })
    fixture.sqlite.exec("CREATE TRIGGER reject_commitment_event BEFORE INSERT ON events WHEN NEW.id = 'commitment:meeting:accepted' BEGIN SELECT RAISE(ABORT, 'forced commitment failure'); END")
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'failed-commitment', expectedVersion: 0,
      action: { type: 'commitment', commitmentId: 'meeting', next: 'accepted' } })).rejects.toThrow()
    await expectNoAcceptedCommand(fixture)
    expect((await fixture.db.select().from(commitments).where(eq(commitments.id, 'meeting')).get())?.status).toBe('proposed')
    expect(await fixture.db.select().from(memories)).toHaveLength(0)
  })
})
