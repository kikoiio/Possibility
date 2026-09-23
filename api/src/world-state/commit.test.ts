import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { commitments, dialogueTurns, dialogues, events, memories, personaMessages, persons, personStates, schedules, sceneRequests, sessions, timelines, universeRevisions, worldModelVersions, worlds, worldCommands, worldFacts, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { commitWorldCommand } from './commit'
import { WorldStateError } from './types'
import { buildEngineContext, buildWorldSnapshot } from '../agent/engine-context'
import { worldSnapshot } from '../worlds/queries'
import { transitionCommitment } from '../life/service'
import { auditUniverse } from './invariants'

type Fixture = Awaited<ReturnType<typeof createWorldFixture>>
let f: Fixture | null = null
afterEach(() => { f?.close(); f = null; vi.unstubAllGlobals() })

async function setup() {
  f = await createWorldFixture()
  await f.db.insert(persons).values([
    { id: 'a', userId: 'owner', name: 'A', modelJson: '{}', createdAt: WORLD_TIME },
    { id: 'b', userId: 'owner', name: 'B', modelJson: '{}', createdAt: WORLD_TIME },
  ])
  await f.db.insert(worldPersons).values([
    { worldId: 'home-world', personId: 'a', joinedAt: WORLD_TIME },
    { worldId: 'home-world', personId: 'b', joinedAt: WORLD_TIME },
  ])
  for (const personId of ['a', 'b']) {
    await f.db.insert(personStates).values({ personId, timelineId: 'home-main', simTime: WORLD_TIME, location: 'Cafe', activity: 'Talking', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })
  }
  return f
}

const base = { worldId: 'home-world', timelineId: 'home-main', userId: 'owner' }

describe('versioned world command', () => {
  it('writes one fact, one event and the location projection atomically; replay returns the same fact', async () => {
    const fixture = await setup()
    const input = { ...base, id: 'move-a', expectedVersion: 0, action: { type: 'move' as const, personId: 'a', to: 'Library' } }
    const first = await commitWorldCommand(fixture.db, input)
    expect(first).toMatchObject({ commandId: 'move-a', version: 1, replayed: false })
    expect((await commitWorldCommand(fixture.db, input))).toEqual({ ...first, replayed: true })
    expect((await fixture.db.select().from(worldFacts).all())).toHaveLength(1)
    expect((await fixture.db.select().from(worldCommands).all())).toHaveLength(1)
    expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'a')).get())?.location).toBe('Library')
    expect((await fixture.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())?.version).toBe(1)
  })

  it('rejects two different locations for one resident at the same world time', async () => {
    const fixture = await setup()
    await commitWorldCommand(fixture.db, { ...base, id: 'move-a-first', expectedVersion: 0,
      action: { type: 'move', personId: 'a', to: 'Library' } })
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'move-a-again', expectedVersion: 1,
      action: { type: 'move', personId: 'a', to: 'Cafe' } })).rejects.toMatchObject({ status: 409,
        message: '同一世界时刻已记录该居民在另一地点，请等待时间推进后再移动' })
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'resident-beat-a-again', actorKind: 'system', expectedVersion: 1,
      action: { type: 'resident_state', personId: 'a', cause: 'beat', windowStart: WORLD_TIME,
        patch: { location: 'Cafe' }, events: [{ simTime: WORLD_TIME, title: 'A returns', description: 'A goes back.' }], memories: [] } }))
      .rejects.toMatchObject({ status: 409 })
    expect(await fixture.db.select().from(worldCommands).where(eq(worldCommands.timelineId, 'home-main')).all()).toHaveLength(1)
    expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.timelineId, 'home-main')).all()).toHaveLength(1)
    expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'a')).get())?.location).toBe('Library')
  })

  it('prevents rewriting or deleting accepted commands, facts, and pinned model versions', async () => {
    const fixture = await setup()
    await commitWorldCommand(fixture.db, { ...base, id: 'immutable-move', expectedVersion: 0,
      action: { type: 'move', personId: 'a', to: 'Library' } })
    await expect(fixture.db.update(worldCommands).set({ payloadJson: '{}' }).where(eq(worldCommands.id, 'immutable-move'))).rejects.toThrow()
    await expect(fixture.db.delete(worldCommands).where(eq(worldCommands.id, 'immutable-move'))).rejects.toThrow()
    await expect(fixture.db.update(worldFacts).set({ valueJson: '{}' }).where(eq(worldFacts.sourceCommandId, 'immutable-move'))).rejects.toThrow()
    await expect(fixture.db.delete(worldFacts).where(eq(worldFacts.sourceCommandId, 'immutable-move'))).rejects.toThrow()
    await expect(fixture.db.update(worldModelVersions).set({ modelJson: '{}' }).where(eq(worldModelVersions.worldId, 'home-world'))).rejects.toThrow()
    await expect(fixture.db.delete(worldModelVersions).where(eq(worldModelVersions.worldId, 'home-world'))).rejects.toThrow()
    expect((await fixture.db.select().from(worldFacts).all()).map(fact => fact.valueJson)).not.toEqual(['{}'])
    expect(await fixture.db.select().from(worldCommands).all()).toHaveLength(1)
    expect(await fixture.db.select().from(worldModelVersions).all()).toHaveLength(1)
  })

  it('rejects stale versions, same id with different payload, foreign ownership and invalid locations', async () => {
    const fixture = await setup()
    await commitWorldCommand(fixture.db, { ...base, id: 'one', expectedVersion: 0, action: { type: 'move', personId: 'a', to: 'Library' } })
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'two', expectedVersion: 0, action: { type: 'move', personId: 'b', to: 'Library' } })).rejects.toMatchObject({ status: 409 })
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'one', expectedVersion: 0, action: { type: 'move', personId: 'b', to: 'Library' } })).rejects.toMatchObject({ status: 409 })
    await expect(commitWorldCommand(fixture.db, { ...base, userId: 'other', id: 'foreign', expectedVersion: 1, action: { type: 'environment', location: null, condition: 'weather', value: 'rain' } })).rejects.toMatchObject({ status: 404 })
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'bad', expectedVersion: 1, action: { type: 'move', personId: 'b', to: 'Nowhere' } })).rejects.toMatchObject({ status: 400 })
    expect((await fixture.db.select().from(worldFacts).all())).toHaveLength(1)
  })

  it('rolls back command, revision, fact and projection if the derived event fails', async () => {
    const fixture = await setup()
    fixture.sqlite.exec("CREATE TRIGGER reject_new_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'forced failure'); END")
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'failed', expectedVersion: 0, action: { type: 'move', personId: 'a', to: 'Library' } })).rejects.toThrow()
    expect((await fixture.db.select().from(worldCommands).all())).toHaveLength(0)
    expect((await fixture.db.select().from(worldFacts).all())).toHaveLength(0)
    expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'a')).get())?.location).toBe('Cafe')
    expect((await fixture.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())?.version).toBe(0)
  })

  it('commits a resident beat, story events, private memory and projections as one versioned result', async () => {
    const fixture = await setup()
    const input = { ...base, id: 'system:beat-a', actorKind: 'system' as const, expectedVersion: 0,
      action: { type: 'resident_state' as const, personId: 'a', cause: 'beat' as const, windowStart: WORLD_TIME,
        patch: { location: 'Library', activity: 'Reading', mood: 'Calm', lastBeatSimTime: WORLD_TIME },
        events: [{ simTime: WORLD_TIME, title: 'A turns a page', description: 'A reads beside the tall window.' }],
        memories: [{ type: 'thought' as const, content: 'The room is quiet.', importance: 5 }] } }
    const first = await commitWorldCommand(fixture.db, input)
    expect(first).toMatchObject({ version: 1, replayed: false })
    expect(await commitWorldCommand(fixture.db, input)).toEqual({ ...first, replayed: true })
    expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'a')).get()))
      .toMatchObject({ location: 'Library', activity: 'Reading', lastBeatSimTime: WORLD_TIME })
    expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.factType, 'location')).all()).toHaveLength(1)
    expect(await fixture.db.select().from(events).all()).toHaveLength(2)
    expect(await fixture.db.select().from(memories).all()).toHaveLength(1)
    expect(await fixture.db.select().from(worldCommands).all()).toHaveLength(1)
  })

  it('versions and audits constructed corrections and forgetting without exposing memory text', async () => {
    const fixture = await setup()
    await fixture.db.insert(memories).values({ id: 'remembered', personId: 'a', timelineId: 'home-main', type: 'relationship',
      content: 'We met by the river.', simTime: WORLD_TIME, createdAt: WORLD_TIME, importance: 6, summarized: false })
    const before = { type: 'relationship', content: 'We met by the river.', importance: 6, simTime: WORLD_TIME,
      createdAt: WORLD_TIME, summarized: false }
    const corrected = await commitWorldCommand(fixture.db, { ...base, id: 'correct-memory', expectedVersion: 0,
      action: { type: 'memory_correct', memoryId: 'remembered', personId: 'a', before,
        after: { content: 'We met beside the river.', importance: 7 } } })
    expect(corrected.version).toBe(1)
    expect(await fixture.db.select().from(memories).where(eq(memories.id, 'remembered')).get())
      .toMatchObject({ content: 'We met beside the river.', importance: 7 })
    const correctionFact = await fixture.db.select().from(worldFacts).where(eq(worldFacts.version, 1)).get()
    expect(correctionFact).toMatchObject({ factType: 'memory_maintenance', visibility: 'private' })
    expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])

    const forgetBefore = { ...before, content: 'We met beside the river.', importance: 7 }
    const forgotten = await commitWorldCommand(fixture.db, { ...base, id: 'forget-memory', expectedVersion: 1,
      action: { type: 'memory_forget', memoryId: 'remembered', personId: 'a', before: forgetBefore } })
    expect(forgotten.version).toBe(2)
    expect(await fixture.db.select().from(memories).where(eq(memories.id, 'remembered')).get()).toBeUndefined()
    expect(await commitWorldCommand(fixture.db, { ...base, id: 'forget-memory', expectedVersion: 1,
      action: { type: 'memory_forget', memoryId: 'remembered', personId: 'a', before: forgetBefore } })).toMatchObject({ replayed: true, version: 2 })
    expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
    await fixture.db.insert(memories).values({ id: 'remembered', personId: 'a', timelineId: 'home-main', type: 'relationship',
      content: 'Illegally restored.', simTime: WORLD_TIME, createdAt: WORLD_TIME, importance: 7, summarized: false })
    expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([
      expect.objectContaining({ code: 'memory_projection', commandId: 'forget-memory', version: 2 }),
    ])
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(2)
  })

  it('records generated resident schedules as private, versioned projections without public events', async () => {
    const fixture = await setup()
    const items = [
      { start: '00:00', end: '04:00', location: 'Cafe', activity: 'Sleeping', kind: 'sleep' as const },
      { start: '04:00', end: '08:00', location: 'Cafe', activity: 'Waking up' },
      { start: '08:00', end: '12:00', location: 'Library', activity: 'Reading' },
      { start: '12:00', end: '16:00', location: 'Cafe', activity: 'Having lunch' },
      { start: '16:00', end: '20:00', location: 'Library', activity: 'Writing' },
      { start: '20:00', end: '00:00', location: 'Cafe', activity: 'Going to sleep' },
    ]
    const input = { ...base, id: 'schedule-a', actorKind: 'system' as const, expectedVersion: 0,
      action: { type: 'schedule_set' as const, personId: 'a', worldDate: WORLD_TIME.slice(0, 10),
        generatedAt: WORLD_TIME, items } }
    const result = await commitWorldCommand(fixture.db, input)
    expect(result).toMatchObject({ version: 1, replayed: false })
    expect(await commitWorldCommand(fixture.db, input)).toMatchObject({ version: 1, replayed: true })
    expect(await fixture.db.select().from(schedules).where(eq(schedules.personId, 'a')).get())
      .toMatchObject({ timelineId: 'home-main', worldDate: WORLD_TIME.slice(0, 10), itemsJson: JSON.stringify(items) })
    expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.sourceCommandId, 'schedule-a')).get())
      .toMatchObject({ factType: 'schedule', visibility: 'private' })
    expect(await fixture.db.select().from(events).where(eq(events.timelineId, 'home-main')).all()).toHaveLength(0)
    expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'spoof-schedule', expectedVersion: 1,
      action: { ...input.action, worldDate: WORLD_TIME.slice(0, 10) } })).rejects.toMatchObject({ status: 403 })
  })

  it('rolls back a resident beat and all of its outputs when a story event insert fails', async () => {
    const fixture = await setup()
    fixture.sqlite.exec("CREATE TRIGGER reject_story_event BEFORE INSERT ON events WHEN NEW.id LIKE '%:story:%' BEGIN SELECT RAISE(ABORT, 'forced story failure'); END")
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'system:beat-failed', actorKind: 'system', expectedVersion: 0,
      action: { type: 'resident_state', personId: 'a', cause: 'beat', windowStart: WORLD_TIME,
        patch: { location: 'Library', activity: 'Reading', lastBeatSimTime: WORLD_TIME },
        events: [{ simTime: WORLD_TIME, title: 'A turns a page', description: 'A reads beside the window.' }],
        memories: [{ type: 'thought', content: 'The room is quiet.', importance: 5 }] } })).rejects.toThrow()
    expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'a')).get())?.location).toBe('Cafe')
    expect(await fixture.db.select().from(worldCommands).all()).toHaveLength(0)
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(0)
    expect(await fixture.db.select().from(events).all()).toHaveLength(0)
    expect(await fixture.db.select().from(memories).all()).toHaveLength(0)
    expect((await fixture.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())?.version).toBe(0)
  })

  it('does not let owners use the engine-only resident state command', async () => {
    const fixture = await setup()
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'spoofed-beat', actorKind: 'owner', expectedVersion: 0,
      action: { type: 'resident_state', personId: 'a', cause: 'beat', windowStart: WORLD_TIME,
        patch: { activity: 'Secretly forced', lastBeatSimTime: WORLD_TIME }, events: [], memories: [] } }))
      .rejects.toMatchObject({ status: 403 })
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(0)
  })

  it('version-controls NPC dialogue turns and closes its participants atomically', async () => {
    const fixture = await setup()
    await fixture.db.insert(dialogues).values({ id: 'npc-dialogue', timelineId: 'home-main', location: 'Cafe',
      participantIdsJson: JSON.stringify(['a', 'b']), status: 'ongoing', kind: 'npc', turnLimit: 2, simStart: WORLD_TIME })
    await fixture.db.update(personStates).set({ currentDialogueId: 'npc-dialogue' })
    const first = { ...base, id: 'system:dialogue-turn-0', actorKind: 'system' as const, expectedVersion: 0,
      action: { type: 'dialogue_turn' as const, dialogueId: 'npc-dialogue', speakerId: 'a', turnIndex: 0,
        utterance: 'The rain has eased.', thought: 'I hope the visitor is safe.', memory: null, shouldEnd: false } }
    await commitWorldCommand(fixture.db, first)
    await commitWorldCommand(fixture.db, first)
    expect(await fixture.db.select().from(dialogueTurns).all()).toHaveLength(1)
    expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.factType, 'conversation')).all()).toHaveLength(1)
    const second = { ...base, id: 'system:dialogue-turn-1', actorKind: 'system' as const, expectedVersion: 1,
      action: { type: 'dialogue_turn' as const, dialogueId: 'npc-dialogue', speakerId: 'b', turnIndex: 1,
        utterance: 'Good. The path is slippery.', thought: 'I should warn the others.', memory: { content: 'A and B talked about the rain.', importance: 6 }, shouldEnd: false } }
    await commitWorldCommand(fixture.db, second)
    expect((await fixture.db.select().from(dialogues).where(eq(dialogues.id, 'npc-dialogue')).get())?.status).toBe('ended')
    expect(await fixture.db.select().from(dialogueTurns).all()).toHaveLength(2)
    expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.factType, 'conversation')).all()).toHaveLength(2)
    expect(await fixture.db.select().from(events).all()).toHaveLength(2)
    expect(await fixture.db.select().from(memories).all()).toHaveLength(3)
    expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'a')).get()))
      .toMatchObject({ currentDialogueId: null, lastBeatSimTime: WORLD_TIME })
    expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'b')).get()))
      .toMatchObject({ currentDialogueId: null, lastBeatSimTime: WORLD_TIME })
    const factPayloads = (await fixture.db.select().from(worldFacts).where(eq(worldFacts.factType, 'conversation')).all()).map(f => f.valueJson)
    expect(factPayloads.some(value => value.includes('hope the visitor'))).toBe(false)
  })

  it('starts an NPC encounter and reserves both residents atomically', async () => {
    const fixture = await setup()
    const result = await commitWorldCommand(fixture.db, { ...base, id: 'system:dialogue-start', actorKind: 'system', expectedVersion: 0,
      action: { type: 'dialogue_start', dialogueId: 'npc-dialogue', participantIds: ['a', 'b'], location: 'Cafe', turnLimit: 8 } })
    expect(result.version).toBe(1)
    expect((await fixture.db.select().from(dialogues).where(eq(dialogues.id, 'npc-dialogue')).get()))
      .toMatchObject({ status: 'ongoing', kind: 'npc', location: 'Cafe' })
    expect(await fixture.db.select().from(personStates).where(eq(personStates.currentDialogueId, 'npc-dialogue')).all()).toHaveLength(2)
    expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.factType, 'conversation')).all()).toHaveLength(1)
    expect(await fixture.db.select().from(events).where(eq(events.dialogueId, 'npc-dialogue')).all()).toHaveLength(1)
  })

  it('does not leave a dialogue or resident lock if its start event fails', async () => {
    const fixture = await setup()
    fixture.sqlite.exec("CREATE TRIGGER reject_dialogue_start BEFORE INSERT ON events WHEN NEW.dialogue_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'forced event failure'); END")
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'system:dialogue-start-failed', actorKind: 'system', expectedVersion: 0,
      action: { type: 'dialogue_start', dialogueId: 'npc-dialogue', participantIds: ['a', 'b'], location: 'Cafe', turnLimit: 8 } })).rejects.toThrow()
    expect(await fixture.db.select().from(dialogues).where(eq(dialogues.id, 'npc-dialogue')).all()).toHaveLength(0)
    expect(await fixture.db.select().from(personStates).where(eq(personStates.currentDialogueId, 'npc-dialogue')).all()).toHaveLength(0)
    expect(await fixture.db.select().from(worldCommands).all()).toHaveLength(0)
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(0)
    expect((await fixture.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())?.version).toBe(0)
  })

  it('rolls back if the world clock advances between validation and fact insertion', async () => {
    const fixture = await setup()
    fixture.sqlite.exec("CREATE TRIGGER advance_clock_before_command AFTER INSERT ON world_commands BEGIN UPDATE timelines SET sim_now = '2026-09-21T08:01:00.000Z' WHERE id = NEW.timeline_id; END")
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'late', expectedVersion: 0,
      action: { type: 'environment', location: null, condition: 'weather', value: 'rain' } })).rejects.toThrow()
    expect(await fixture.db.select().from(worldCommands).all()).toHaveLength(0)
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(0)
  })

  it('does not publish a private message in the public event stream', async () => {
    const fixture = await setup()
    const result = await commitWorldCommand(fixture.db, { ...base, id: 'secret', expectedVersion: 0, action: { type: 'inform', recipientId: 'a', topic: 'letter', content: 'The key is under the rug' } })
    expect(result.version).toBe(1)
    const fact = await fixture.db.select().from(worldFacts).get()
    expect(fact?.visibility).toBe('private')
    expect(JSON.parse(fact!.valueJson)).toMatchObject({ certainty: 'rumor', recipientId: 'a' })
    const response = await app.request('/api/worlds/home-world?timelineId=home-main', { headers: { Authorization: 'Bearer owner-token' } }, fixture.env)
    expect(response.status).toBe(200)
    expect(JSON.stringify(await response.json())).not.toContain('The key is under the rug')
  })

  it('only gives a resident their own knowledge, preserving rumor provenance across prompts', async () => {
    const fixture = await setup()
    await commitWorldCommand(fixture.db, { ...base, id: 'message-a', expectedVersion: 0,
      action: { type: 'inform', recipientId: 'a', topic: 'sealed letter', content: 'The letter says tomorrow', } })
    const snapshot = (await buildWorldSnapshot(fixture.db, 'home-world', 'home-main'))!
    const a = (await buildEngineContext(fixture.db, 'a', snapshot))!
    const b = (await buildEngineContext(fixture.db, 'b', snapshot))!
    expect(a.knownFacts).toEqual([expect.objectContaining({ kind: 'knowledge', certainty: 'rumor', text: expect.stringContaining('tomorrow') })])
    expect(b.knownFacts).toEqual([])
  })

  it('preserves rumor certainty when relayed and keeps private knowledge out of public snapshots', async () => {
    const fixture = await setup()
    const weather = await commitWorldCommand(fixture.db, { ...base, id: 'verified-weather', expectedVersion: 0,
      action: { type: 'environment', location: 'Cafe', condition: 'weather', value: 'rain has started' } })
    const verifiedMessage = await commitWorldCommand(fixture.db, { ...base, id: 'tell-a-weather', expectedVersion: 1,
      action: { type: 'inform', recipientId: 'a', topic: 'weather', content: 'It is raining.', sourceFactId: weather.factId } })
    const rumor = await commitWorldCommand(fixture.db, { ...base, id: 'tell-a-secret', expectedVersion: 2,
      action: { type: 'inform', recipientId: 'a', topic: 'missing-key', content: 'The spare key may be in the garden.' } })
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'upgrade-rumor', expectedVersion: 3,
      action: { type: 'inform', recipientId: 'b', topic: 'missing-key', content: 'The spare key is in the garden.', sourceFactId: rumor.factId } }))
      .resolves.toMatchObject({ version: 4 })
    await commitWorldCommand(fixture.db, { ...base, id: 'relay-rumor', expectedVersion: 4,
      action: { type: 'inform', recipientId: 'b', topic: 'missing-key-followup', content: 'A says the key may be in the garden.', sourceFactId: rumor.factId } })

    const snapshot = (await buildWorldSnapshot(fixture.db, 'home-world', 'home-main'))!
    const a = (await buildEngineContext(fixture.db, 'a', snapshot))!
    const b = (await buildEngineContext(fixture.db, 'b', snapshot))!
    expect(a.knownFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('It is raining.'), certainty: 'fact', sourceFactId: verifiedMessage.factId }),
      expect.objectContaining({ text: expect.stringContaining('may be in the garden'), certainty: 'rumor', sourceFactId: rumor.factId }),
    ]))
    const bFacts = b.knownFacts ?? []
    expect(bFacts).toHaveLength(3) // one public environmental fact, two private rumors
    const bKnowledge = bFacts.filter(fact => fact.kind === 'knowledge')
    expect(bKnowledge).toHaveLength(2)
    expect(bKnowledge.every(fact => fact.certainty === 'rumor')).toBe(true)
    expect(bFacts.some(fact => fact.text.includes('It is raining.'))).toBe(false)
    const publicSnapshot = (await worldSnapshot(fixture.db, 'home-world', 'home-main'))!
    expect(JSON.stringify(publicSnapshot.currentFacts)).not.toContain('spare key')
    expect(JSON.stringify(publicSnapshot.currentFacts)).toContain('rain has started')
  })

  it('API reads are side-effect free and invalid scoped IDs are rejected', async () => {
    const fixture = await setup()
    const before = fixture.sqlite.prepare('SELECT total_changes() AS n').get()!.n
    const state = await app.request('/api/worlds/home-world/state?timelineId=home-main', { headers: { Authorization: 'Bearer owner-token' } }, fixture.env)
    expect(state.status).toBe(200)
    expect(await state.json()).toMatchObject({ version: 0, evidenceStatus: 'legacy' })
    expect(fixture.sqlite.prepare('SELECT total_changes() AS n').get()!.n).toBe(before)
    const wrong = await app.request('/api/worlds/home-world/state?timelineId=other-main', { headers: { Authorization: 'Bearer owner-token' } }, fixture.env)
    expect(wrong.status).toBe(404)
    const action = await app.request('/api/worlds/home-world/actions', {
      method: 'POST', headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'api-env', timelineId: 'home-main', expectedVersion: 0, action: { type: 'environment', location: null, condition: 'weather', value: 'rain' } }),
    }, fixture.env)
    expect(action.status).toBe(200)
    const commandId = (await action.json() as { commandId: string }).commandId
    const recovered = await app.request(`/api/worlds/home-world/actions/${commandId}`, { headers: { Authorization: 'Bearer owner-token' } }, fixture.env)
    expect(recovered.status).toBe(200)
    const forcedMove = await app.request('/api/worlds/home-world/actions', {
      method: 'POST', headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'force-b', timelineId: 'home-main', expectedVersion: 1, action: { type: 'move', personId: 'b', to: 'Library' } }),
    }, fixture.env)
    expect(forcedMove.status).toBe(403)
    const malformed = await app.request('/api/worlds/home-world/actions', {
      method: 'POST', headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'bad-shape', timelineId: 'home-main', expectedVersion: 1, action: { type: 'environment', location: {}, condition: 42, value: {} } }),
    }, fixture.env)
    expect(malformed.status).toBe(400)
  })

  it('enforces ownership, timeline scope, and stopped-world guards at the command API boundary', async () => {
    const fixture = await setup()
    await fixture.db.insert(sessions).values({ token: 'other-owner-token', userId: 'other', expiresAt: '2099-01-01T00:00:00.000Z' })
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const action = (id: string, timelineId = 'home-main') => app.request('/api/worlds/home-world/actions', {
      method: 'POST', headers,
      body: JSON.stringify({ id, timelineId, expectedVersion: 0,
        action: { type: 'environment', location: null, condition: 'weather', value: 'rain' } }),
    }, fixture.env)

    expect((await action('wrong-world-line', 'other-main')).status).toBe(404)
    const foreign = await app.request('/api/worlds/home-world/actions', {
      method: 'POST', headers: { ...headers, Authorization: 'Bearer other-owner-token' },
      body: JSON.stringify({ id: 'foreign-owner', timelineId: 'home-main', expectedVersion: 0,
        action: { type: 'environment', location: null, condition: 'weather', value: 'rain' } }),
    }, fixture.env)
    expect(foreign.status).toBe(404)

    await fixture.db.update(worlds).set({ status: 'paused' }).where(eq(worlds.id, 'home-world'))
    expect((await action('paused-world')).status).toBe(409)
    await fixture.db.update(worlds).set({ status: 'capped' }).where(eq(worlds.id, 'home-world'))
    expect((await action('budget-capped-world')).status).toBe(409)
    await fixture.db.update(worlds).set({ status: 'running' }).where(eq(worlds.id, 'home-world'))
    await fixture.db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, 'home-main'))
    expect((await action('archived-timeline')).status).toBe(404)

    expect(await fixture.db.select().from(worldCommands).all()).toHaveLength(0)
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(0)
    expect((await fixture.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())?.version ?? 0).toBe(0)
  })

  it('serializes competing commands and leaves exactly one fact at the winning version', async () => {
    const fixture = await setup()
    const requests = ['rain', 'sun'].map((value, i) => commitWorldCommand(fixture.db, {
      ...base, id: `weather-${i}`, expectedVersion: 0,
      action: { type: 'environment' as const, location: null, condition: 'weather', value },
    }))
    const results = await Promise.allSettled(requests)
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(1)
    expect((await fixture.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())?.version).toBe(1)
  })

  it('blocks new state writes to paused worlds and archived timelines without partial facts', async () => {
    const fixture = await setup()
    await fixture.db.update(worlds).set({ status: 'paused' }).where(eq(worlds.id, 'home-world'))
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'paused-action', expectedVersion: 0,
      action: { type: 'environment', location: null, condition: 'weather', value: 'rain' } })).rejects.toMatchObject({ status: 409 })
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(0)
    await fixture.db.update(worlds).set({ status: 'capped' }).where(eq(worlds.id, 'home-world'))
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'capped-action', expectedVersion: 0,
      action: { type: 'environment', location: null, condition: 'weather', value: 'storm' } })).rejects.toMatchObject({ status: 409 })
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(0)
    await fixture.db.update(worlds).set({ status: 'running' }).where(eq(worlds.id, 'home-world'))
    await fixture.db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, 'home-main'))
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'archived-action', expectedVersion: 0,
      action: { type: 'environment', location: null, condition: 'weather', value: 'rain' } })).rejects.toMatchObject({ status: 404 })
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(0)
  })

  it('prevents database-level revision rollback, jumps, and advances without a matching command', async () => {
    const fixture = await setup()
    await commitWorldCommand(fixture.db, { ...base, id: 'revision-one', expectedVersion: 0,
      action: { type: 'environment', location: null, condition: 'weather', value: 'rain' } })

    expect(() => fixture.sqlite.prepare('UPDATE universe_revisions SET version = 0 WHERE timeline_id = ?').run('home-main'))
      .toThrow('universe_revision_must_advance_by_one')
    expect(() => fixture.sqlite.prepare('UPDATE universe_revisions SET version = 2 WHERE timeline_id = ?').run('home-main'))
      .toThrow('universe_revision_requires_command')
    expect((await fixture.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())?.version).toBe(1)
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(1)
    expect(await fixture.db.select().from(worldCommands).all()).toHaveLength(1)
  })

  it('requires a persona to enter before talking, then rejects teleporting and supports explicit movement', async () => {
    const fixture = await setup()
    await fixture.db.insert(persons).values({ id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME })
    await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'visitor', joinedAt: WORLD_TIME })
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const scene = (location: string) => app.request('/api/worlds/home-world/scene', {
      method: 'POST', headers, body: JSON.stringify({ timelineId: 'home-main', location, content: 'Hello' }),
    }, fixture.env)
    expect((await scene('Library')).status).toBe(409)
    const enter = await app.request('/api/worlds/home-world/scene/position', {
      method: 'POST', headers, body: JSON.stringify({ timelineId: 'home-main', location: 'Cafe', commandId: 'enter-visitor', expectedVersion: 0 }),
    }, fixture.env)
    expect(enter.status).toBe(200)
    const enterReplay = await app.request('/api/worlds/home-world/scene/position', {
      method: 'POST', headers, body: JSON.stringify({ timelineId: 'home-main', location: 'Cafe', commandId: 'enter-visitor', expectedVersion: 0 }),
    }, fixture.env)
    expect(enterReplay.status).toBe(200)
    expect((await enterReplay.json() as { replayed: boolean }).replayed).toBe(true)
    expect((await scene('Library')).status).toBe(409)
    await commitWorldCommand(fixture.db, { ...base, id: 'wait-before-moving', actorKind: 'system', expectedVersion: 1,
      action: { type: 'clock_advance', from: WORLD_TIME, to: '2026-09-21T08:01:00.000Z', observedAt: '2026-09-21T08:01:00.000Z' } })
    const move = await app.request('/api/worlds/home-world/scene/position', {
      method: 'POST', headers, body: JSON.stringify({ timelineId: 'home-main', location: 'Library', commandId: 'move-visitor', expectedVersion: 2 }),
    }, fixture.env)
    expect(move.status).toBe(200)
    expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'visitor')).get())?.location).toBe('Library')
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(3)
  })

  it('rejects a new in-person scene while the visitor is already locked in an ongoing dialogue', async () => {
    const fixture = await setup()
    await fixture.db.insert(persons).values({ id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME })
    await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'visitor', joinedAt: WORLD_TIME })
    await fixture.db.insert(personStates).values({ personId: 'visitor', timelineId: 'home-main', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Speaking', mood: 'Calm', goal: 'Talk', currentDialogueId: 'ongoing-scene', updatedRealAt: WORLD_TIME })
    await fixture.db.insert(dialogues).values({ id: 'ongoing-scene', timelineId: 'home-main', location: 'Cafe',
      participantIdsJson: JSON.stringify(['visitor', 'a']), status: 'ongoing', kind: 'npc', turnLimit: 8, simStart: WORLD_TIME })
    const response = await app.request('/api/worlds/home-world/scene', { method: 'POST',
      headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ timelineId: 'home-main', location: 'Cafe', content: 'Can I start another conversation?', requestId: 'busy-visitor' }),
    }, fixture.env)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('正在参与另一场交谈') })
    expect(await fixture.db.select().from(sceneRequests).all()).toHaveLength(0)
    expect(await fixture.db.select().from(worldCommands).all()).toHaveLength(0)
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(0)
  })

  it('records commitment acceptance and fulfillment as versioned facts in the same transaction', async () => {
    const fixture = await setup()
    await fixture.db.insert(commitments).values({ id: 'meeting', worldId: 'home-world', timelineId: 'home-main',
      personId: 'a', visitorId: 'b', sourceDialogueId: null, title: 'Meet at the cafe', kind: 'meeting', location: 'Cafe',
      dueSim: '2026-09-21T08:20:00.000Z', status: 'proposed', createdSim: WORLD_TIME, updatedSim: WORLD_TIME, createdAt: WORLD_TIME })
    const proposal = (await fixture.db.select().from(commitments).where(eq(commitments.id, 'meeting')).get())!
    await transitionCommitment(fixture.db, proposal, 'accepted', WORLD_TIME)
    expect((await fixture.db.select().from(commitments).where(eq(commitments.id, 'meeting')).get())?.status).toBe('accepted')
    await transitionCommitment(fixture.db, proposal, 'fulfilled', WORLD_TIME)
    const facts = await fixture.db.select().from(worldFacts).all()
    expect(facts.map(f => JSON.parse(f.valueJson).to)).toEqual(['accepted', 'fulfilled'])
    expect((await fixture.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())?.version).toBe(2)
    expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'a')).get())?.mood).toContain('守约')
  })

  it('does not allow a builder command to forge a resident acceptance inside a conversation', async () => {
    const fixture = await setup()
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'forged-acceptance', expectedVersion: 0,
      action: { type: 'conversation', dialogueId: 'not-a-dialogue', requestId: 'forged', turns: [{ id: 'turn', personId: 'b' }],
        acceptedCommitments: [{ id: 'accepted:forged:b', personId: 'b', title: 'Meet', kind: 'meeting', location: 'Cafe', dueSim: '2026-09-21T09:00:00.000Z' }] },
    })).rejects.toMatchObject({ status: 403 })
    expect(await fixture.db.select().from(commitments).all()).toHaveLength(0)
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(0)
  })

  it('rejects immutable scene metadata that disagrees with the recorded dialogue', async () => {
    const fixture = await setup()
    await fixture.db.insert(persons).values({ id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME })
    await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'visitor', joinedAt: WORLD_TIME })
    await fixture.db.insert(dialogues).values({ id: 'scene-talk', timelineId: 'home-main', location: 'Cafe',
      participantIdsJson: JSON.stringify(['visitor', 'a']), status: 'scene', kind: 'scene', visitorId: 'visitor',
      turnLimit: 100, simStart: WORLD_TIME, simEnd: WORLD_TIME })
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'scene-metadata-mismatch', actorKind: 'visitor', actorPersonId: 'visitor',
      expectedVersion: 0, action: { type: 'conversation', dialogueId: 'scene-talk', requestId: 'scene-metadata-mismatch',
        turns: [{ id: 'visitor-turn', personId: 'visitor' }],
        sceneProjection: { location: 'Library', participantIds: ['visitor', 'a'], simTime: WORLD_TIME, turnLimit: 100 } },
    })).rejects.toMatchObject({ status: 400, message: '在场交谈元数据与交谈记录不一致' })
    expect(await fixture.db.select().from(worldCommands).all()).toHaveLength(0)
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(0)
  })

  it('rejects conversation memories and messages attributed outside the actual scene', async () => {
    const fixture = await setup()
    await fixture.db.insert(persons).values({ id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME })
    await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'visitor', joinedAt: WORLD_TIME })
    await fixture.db.insert(dialogues).values({ id: 'scene-effects', timelineId: 'home-main', location: 'Cafe',
      participantIdsJson: JSON.stringify(['visitor', 'a']), status: 'scene', kind: 'scene', visitorId: 'visitor',
      turnLimit: 100, simStart: WORLD_TIME, simEnd: WORLD_TIME })
    const baseAction = {
      type: 'conversation' as const, dialogueId: 'scene-effects', requestId: 'scene-effects',
      turns: [{ id: 'visitor-turn', personId: 'visitor' }, { id: 'resident-turn', personId: 'a' }],
      sceneProjection: { location: 'Cafe', participantIds: ['visitor', 'a'], simTime: WORLD_TIME, turnLimit: 100 },
    }
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'outside-memory', actorKind: 'visitor', actorPersonId: 'visitor',
      expectedVersion: 0, action: { ...baseAction, privateEffects: { memories: [{ id: 'wrong-memory', personId: 'b',
        type: 'relationship', content: 'A fabricated relationship.', importance: 5, simTime: WORLD_TIME, createdAt: WORLD_TIME }], messages: [] } },
    })).rejects.toMatchObject({ status: 400, message: '交谈私有记忆必须属于参与交谈的居民' })
    await expect(commitWorldCommand(fixture.db, { ...base, id: 'outside-message', actorKind: 'visitor', actorPersonId: 'visitor',
      expectedVersion: 0, action: { ...baseAction, privateEffects: { memories: [], messages: [{ id: 'wrong-message', senderPersonId: 'a',
        recipientPersonId: 'b', content: 'A fabricated message.', location: 'Cafe', simTime: WORLD_TIME, createdAt: WORLD_TIME }] } },
    })).rejects.toMatchObject({ status: 400, message: '交谈留言必须由在场居民留给当前来访者' })
    expect(await fixture.db.select().from(worldCommands).all()).toHaveLength(0)
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(0)
  })

  it('records builder interventions as versioned facts and replays them by request ID', async () => {
    const fixture = await setup()
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const send = (text: string, expectedVersion: number, requestId = 'inject-request-1') => app.request('/api/worlds/home-world/inject', {
      method: 'POST', headers, body: JSON.stringify({ timelineId: 'home-main', requestId, expectedVersion, text }),
    }, fixture.env)
    const first = await send('突然下起暴雨', 0)
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ version: 1, replayed: false })
    const retry = await send('突然下起暴雨', 1)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ version: 1, replayed: true })
    expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.factType, 'intervention')).all()).toHaveLength(1)
    expect(await fixture.db.select().from(events).where(eq(events.kind, 'injected')).all()).toHaveLength(1)
    expect((await send('突然下起大雪', 1)).status).toBe(409)
    await fixture.db.update(worlds).set({ status: 'paused' }).where(eq(worlds.id, 'home-world'))
    const denied = await send('陌生人敲门', 1, 'paused-injection')
    expect(denied.status).toBe(409)
    expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.factType, 'intervention')).all()).toHaveLength(1)
  })

  it('only lets an in-person visitor inform a co-located available resident', async () => {
    const fixture = await setup()
    await fixture.db.insert(persons).values({ id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME })
    await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'visitor', joinedAt: WORLD_TIME })
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const send = (expectedVersion: number, id: string) => app.request('/api/worlds/home-world/scene/inform', { method: 'POST', headers,
      body: JSON.stringify({ timelineId: 'home-main', recipientId: 'a', topic: 'letter', content: 'A letter arrived', commandId: id, expectedVersion }) }, fixture.env)
    expect((await send(0, 'too-early')).status).toBe(409)
    await commitWorldCommand(fixture.db, { ...base, id: 'arrive', actorKind: 'visitor', actorPersonId: 'visitor', expectedVersion: 0,
      action: { type: 'enter', personId: 'visitor', to: 'Library' } })
    expect((await send(1, 'too-far')).status).toBe(409)
    await commitWorldCommand(fixture.db, { ...base, id: 'wait-before-walking', actorKind: 'system', expectedVersion: 1,
      action: { type: 'clock_advance', from: WORLD_TIME, to: '2026-09-21T08:01:00.000Z', observedAt: '2026-09-21T08:01:00.000Z' } })
    await commitWorldCommand(fixture.db, { ...base, id: 'walk', actorKind: 'visitor', actorPersonId: 'visitor', expectedVersion: 2,
      action: { type: 'move', personId: 'visitor', to: 'Cafe' } })
    await fixture.db.update(personStates).set({ currentDialogueId: 'another-conversation' })
      .where(eq(personStates.personId, 'visitor'))
    expect((await send(3, 'busy-visitor')).status).toBe(409)
    expect(await fixture.db.select().from(worldCommands).where(eq(worldCommands.id, 'busy-visitor')).get()).toBeUndefined()
    expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.factType, 'knowledge')).all()).toHaveLength(0)
    expect((await fixture.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())?.version).toBe(3)
    await fixture.db.update(personStates).set({ currentDialogueId: null }).where(eq(personStates.personId, 'visitor'))
    const heard = await send(3, 'tell-a')
    expect(heard.status).toBe(200)
    expect(await heard.json()).toMatchObject({ certainty: 'rumor', version: 4 })
    expect((await fixture.db.select().from(worldFacts).all()).filter(f => f.factType === 'knowledge')).toHaveLength(1)
  })

  it('records an in-person conversation as a versioned fact and replays its request without another model call', async () => {
    const fixture = await setup()
    await fixture.db.delete(worldPersons).where(eq(worldPersons.personId, 'b'))
    const emptyModel = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] })
    await fixture.db.update(persons).set({ modelJson: emptyModel })
    await fixture.db.insert(persons).values({ id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME })
    await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'visitor', joinedAt: WORLD_TIME })
    await fixture.db.insert(personStates).values({ personId: 'visitor', timelineId: 'home-main', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Visiting', mood: 'Calm', goal: 'Talk', updatedRealAt: WORLD_TIME })
    const mockedFetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      utterance: 'Welcome to the cafe.', thought: 'The visitor seems friendly.', shouldEnd: false,
      memory: { content: 'A visitor greeted me at the cafe.', importance: 6 },
    }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', mockedFetch)
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const send = (content = 'Hello there.') => app.request('/api/worlds/home-world/scene', { method: 'POST', headers,
      body: JSON.stringify({ timelineId: 'home-main', location: 'Cafe', content, requestId: 'conversation-request-1' }) }, fixture.env)

    const concurrent = await Promise.all([send(), send()])
    expect(concurrent.every(response => response.status === 200)).toBe(true)
    const concurrentBodies = await Promise.all(concurrent.map(response => response.text()))
    expect(concurrentBodies.some(body => body.includes('Welcome to the cafe.'))).toBe(true)
    const fact = (await fixture.db.select().from(worldFacts).where(eq(worldFacts.sourceCommandId, 'scene:conversation-request-1')).get())!
    expect(JSON.parse(fact.valueJson)).toMatchObject({ requestId: 'conversation-request-1', turnCount: 2, participants: ['a', 'visitor'] })
    expect(fact.version).toBe(2)
    const command = await fixture.db.select().from(worldCommands).where(eq(worldCommands.id, 'scene:conversation-request-1')).get()
    expect(command?.resultVersion).toBe(2)
    const event = await fixture.db.select().from(events).where(eq(events.id, 'command:scene:conversation-request-1')).get()
    expect(event).toMatchObject({ kind: 'dialogue', dialogueId: JSON.parse(fact.valueJson).dialogueId })
    expect(await fixture.db.select().from(memories).where(eq(memories.timelineId, 'home-main')).all()).toHaveLength(2)
    const afterScene = (await buildEngineContext(fixture.db, 'a', (await buildWorldSnapshot(fixture.db, 'home-world', 'home-main'))!))!
    expect(afterScene.memories.map(memory => memory.content)).toContain('A visitor greeted me at the cafe.')
    expect(mockedFetch).toHaveBeenCalledTimes(1)

    const replay = await send()
    expect(replay.status).toBe(200)
    expect(await replay.text()).toContain('"type":"done"')
    expect(mockedFetch).toHaveBeenCalledTimes(1)
    expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.factType, 'conversation')).all()).toHaveLength(2)
    const conflictingReplay = await send('A different utterance')
    expect(await conflictingReplay.text()).toContain('requestId 已提交过不同内容')
    expect(mockedFetch).toHaveBeenCalledTimes(1)
    expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.factType, 'conversation')).all()).toHaveLength(2)
    const status = await app.request('/api/worlds/home-world/scene/requests/conversation-request-1?timelineId=home-main', { headers }, fixture.env)
    expect(await status.json()).toEqual({ status: 'completed', recoverable: false })
    const missing = await app.request('/api/worlds/home-world/scene/requests/not-submitted?timelineId=home-main', { headers }, fixture.env)
    expect(await missing.json()).toEqual({ status: 'missing', recoverable: false })
    await fixture.db.insert(sessions).values({ token: 'other-token', userId: 'other', expiresAt: '2099-01-01T00:00:00.000Z' })
    const foreignStatus = await app.request('/api/worlds/home-world/scene/requests/conversation-request-1?timelineId=home-main', {
      headers: { Authorization: 'Bearer other-token' },
    }, fixture.env)
    expect(foreignStatus.status).toBe(404)
  })

  it.each([
    { label: 'accepts an explicit visitor invitation atomically', content: '这周末要不要陪我去图书馆？', response: { decision: 'accepted', invitation: { title: '周末去图书馆', kind: 'meeting', location: 'Library', dueInMinutes: 120 } }, expected: 1 },
    { label: 'records a refusal without inventing a promise', content: '这周末要不要陪我去图书馆？', response: { decision: 'declined' }, expected: 0 },
    { label: 'ignores model acceptance when the visitor made no invitation', content: '今天镇上很安静。', response: { decision: 'accepted', invitation: { title: '周末去图书馆', kind: 'meeting', location: 'Library', dueInMinutes: 120 } }, expected: 0 },
  ])('$label', async ({ content, response, expected }) => {
    const fixture = await setup()
    await fixture.db.delete(worldPersons).where(eq(worldPersons.personId, 'b'))
    const emptyModel = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] })
    await fixture.db.update(persons).set({ modelJson: emptyModel })
    await fixture.db.insert(persons).values({ id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME })
    await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'visitor', joinedAt: WORLD_TIME })
    await fixture.db.insert(personStates).values({ personId: 'visitor', timelineId: 'home-main', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Visiting', mood: 'Calm', goal: 'Talk', updatedRealAt: WORLD_TIME })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      utterance: '好，我记下了。', thought: '我会认真考虑这个请求。', shouldEnd: false, memory: null,
      visitorInvitationResponse: response,
    }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const result = await app.request('/api/worlds/home-world/scene', { method: 'POST',
      headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ timelineId: 'home-main', location: 'Cafe', content, requestId: `invite-${expected}-${content.length}` }),
    }, fixture.env)
    expect(await result.text()).toContain('"type":"done"')
    const created = await fixture.db.select().from(commitments).where(eq(commitments.timelineId, 'home-main')).all()
    expect(created).toHaveLength(expected)
    expect(await fixture.db.select().from(dialogueTurns).all()).toHaveLength(2)
    expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.factType, 'conversation')).all()).toHaveLength(2)
    if (expected) {
      expect(created[0]).toMatchObject({ status: 'accepted', personId: 'a', visitorId: 'visitor', title: '周末去图书馆', location: 'Library' })
      const action = JSON.parse((await fixture.db.select().from(worldCommands).where(eq(worldCommands.id, `scene:invite-${expected}-${content.length}`)).get())!.payloadJson)
      expect(action.acceptedCommitments).toHaveLength(1)
      expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
    } else {
      const fact = (await fixture.db.select().from(worldFacts).where(eq(worldFacts.factType, 'conversation')).get())!
      expect(JSON.parse(fact.valueJson)).not.toHaveProperty('acceptedCommitmentIds')
    }
  })

  it('rolls back all conversation turns, memories, messages and versioned history when its atomic write fails', async () => {
    const fixture = await setup()
    await fixture.db.delete(worldPersons).where(eq(worldPersons.personId, 'b'))
    const emptyModel = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] })
    await fixture.db.update(persons).set({ modelJson: emptyModel })
    await fixture.db.insert(persons).values({ id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME })
    await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'visitor', joinedAt: WORLD_TIME })
    await fixture.db.insert(personStates).values({ personId: 'visitor', timelineId: 'home-main', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Visiting', mood: 'Calm', goal: 'Talk', updatedRealAt: WORLD_TIME })
    const mockedFetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      utterance: 'Welcome to the cafe.', thought: 'The visitor seems friendly.', shouldEnd: false,
      memory: { content: 'A visitor greeted me at the cafe.', importance: 6 }, word: 'See you soon.',
      visitorInvitationResponse: { decision: 'accepted', invitation: { title: 'Meet up', kind: 'meeting', location: 'Library', dueInMinutes: 120 } },
    }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', mockedFetch)
    fixture.sqlite.exec("CREATE TRIGGER reject_scene_event BEFORE INSERT ON events WHEN NEW.kind = 'dialogue' BEGIN SELECT RAISE(ABORT, 'forced failure'); END")
    const response = await app.request('/api/worlds/home-world/scene', { method: 'POST',
      headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ timelineId: 'home-main', location: 'Cafe', content: '这周末要不要陪我去图书馆？', requestId: 'failed-conversation' }),
    }, fixture.env)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('交谈未能写入世界状态')
    expect(await fixture.db.select().from(dialogueTurns).all()).toHaveLength(0)
    expect(await fixture.db.select().from(memories).all()).toHaveLength(0)
    expect(await fixture.db.select().from(personaMessages).all()).toHaveLength(0)
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(1)
    expect(await fixture.db.select().from(worldCommands).all()).toHaveLength(1)
    expect((await fixture.db.select().from(worldCommands).get())?.type).toBe('scene_open')
    expect(await fixture.db.select().from(dialogues).all()).toHaveLength(1)
    expect(await fixture.db.select().from(commitments).all()).toHaveLength(0)
    expect((await fixture.db.select().from(sceneRequests).get())?.status).toBe('failed')
    const status = await app.request('/api/worlds/home-world/scene/requests/failed-conversation?timelineId=home-main', {
      headers: { Authorization: 'Bearer owner-token' },
    }, fixture.env)
    expect(await status.json()).toEqual({ status: 'failed', recoverable: false })
    expect(mockedFetch).toHaveBeenCalledTimes(1)
  })
})
