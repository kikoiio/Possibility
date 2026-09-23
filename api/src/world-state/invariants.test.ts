import { afterEach, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { commitments, dialogueTurns, dialogues, events, memories, personaMessages, persons, personStates, schedules, timelines, universeRevisions, worldCommands, worldFacts, worldModelVersions, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { commitWorldCommand } from './commit'
import { ensureUniverseRevision } from './model'
import { auditUniverse } from './invariants'
import { advanceWorldClock, recoverDialogueLock, recordMemorySummary, recordResidentState, recordSimulationCheckpoint } from './system'
import { forkTimeline } from '../life/fork'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

it('freezes legacy events at the first structured baseline without confusing them with later orphans', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(events).values({ id: 'legacy-before-baseline', timelineId: 'home-main', simTime: WORLD_TIME,
    title: 'An old story', description: 'Predates the structured ledger.' })
  await ensureUniverseRevision(fixture.db, 'home-world', 'home-main')
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])

  await fixture.db.insert(events).values({ id: 'orphan-after-baseline', timelineId: 'home-main', simTime: WORLD_TIME,
    title: 'Unsupported story', description: 'Same virtual time, but added later.' })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([
    expect.objectContaining({ code: 'unproven_event_projection', version: 0 }),
  ])
})

it('reports commitments and schedules added to a structured root without a baseline or fact', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values([
    { id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME },
    { id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME },
  ])
  await fixture.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
    modelJson: JSON.stringify({ name: 'Home world', description: 'A small town',
      locations: [{ name: 'Cafe', description: '' }, { name: 'Library', description: '' }],
      residents: ['resident', 'visitor'].map(id => ({ id, name: id, model: {} })),
      initialStates: { capturedAt: WORLD_TIME, states: [] } }) })
  await fixture.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME,
    worldModelVersion: 1, updatedAt: WORLD_TIME })
  await fixture.db.insert(commitments).values({ id: 'orphan-root-promise', worldId: 'home-world', timelineId: 'home-main',
    personId: 'resident', visitorId: 'visitor', title: 'An unsupported promise', kind: 'meeting', location: 'Cafe',
    dueSim: '2026-09-21T12:00:00.000Z', status: 'proposed', createdSim: WORLD_TIME, updatedSim: WORLD_TIME,
    createdAt: '2026-09-21T08:01:00.000Z' })
  await fixture.db.insert(schedules).values({ personId: 'resident', timelineId: 'home-main', worldDate: '2026-09-21',
    itemsJson: '[]', generatedAt: WORLD_TIME })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'unproven_commitment_projection', version: 0 }),
    expect.objectContaining({ code: 'unproven_schedule_projection', version: 0 }),
  ]))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toHaveLength(2)
})

it('reports persona messages without a conversation command on a structured timeline', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values([
    { id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME },
    { id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME },
  ])
  await fixture.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
    modelJson: JSON.stringify({ name: 'Home world', description: 'A small town',
      locations: [{ name: 'Cafe', description: '' }, { name: 'Library', description: '' }],
      residents: ['resident', 'visitor'].map(id => ({ id, name: id, model: {} })),
      initialStates: { capturedAt: WORLD_TIME, states: [] } }) })
  await fixture.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME,
    worldModelVersion: 1, updatedAt: WORLD_TIME })
  await fixture.db.insert(personaMessages).values({ id: 'orphan-persona-message', worldId: 'home-world', timelineId: 'home-main',
    senderPersonId: 'resident', recipientPersonId: 'visitor', content: 'An unsupported private message.', location: 'Cafe',
    simTime: WORLD_TIME, createdAt: '2026-09-21T08:01:00.000Z' })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([
    expect.objectContaining({ code: 'unproven_persona_message_projection', version: 0 }),
  ])
})

it('reports timeline memories added after a structured baseline without a source command, while preserving legacy rows', async () => {
  fixture = await createWorldFixture()
  const initialState = { personId: 'resident', simTime: WORLD_TIME, location: 'Cafe', activity: 'Waiting', mood: 'Calm',
    goal: 'Listen', lastBeatSimTime: null, currentDialogueId: null }
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ ...initialState, timelineId: 'home-main', updatedRealAt: WORLD_TIME })
  await fixture.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
    modelJson: JSON.stringify({ name: 'Home world', description: 'A small town',
      locations: [{ name: 'Cafe', description: '' }, { name: 'Library', description: '' }],
      residents: [{ id: 'resident', name: 'Resident', model: {} }],
      initialStates: { capturedAt: WORLD_TIME, states: [initialState] } }) })
  await fixture.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME,
    worldModelVersion: 1, updatedAt: WORLD_TIME })
  await fixture.db.insert(memories).values([
    { id: 'unproven-memory', personId: 'resident', timelineId: 'home-main', type: 'thought', content: 'No command source',
      createdAt: '2026-09-21T08:01:00.000Z', importance: 5 },
    { id: 'legacy-memory', personId: 'resident', timelineId: null, type: 'world', content: 'Legacy row',
      createdAt: '2026-09-21T08:01:00.000Z', importance: 5 },
  ])
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
    code: 'unproven_memory_projection', version: 0,
  }))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toHaveLength(1)
})

it('audits Fork commitment projections against the immutable checkpoint and child facts', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values([
    { id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME },
    { id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME },
  ])
  await fixture.db.insert(worldPersons).values(['resident', 'visitor'].map(personId => ({
    worldId: 'home-world', personId, joinedAt: WORLD_TIME,
  })))
  await fixture.db.insert(personStates).values(['resident', 'visitor'].map(personId => ({
    personId, timelineId: 'home-main', simTime: WORLD_TIME, location: 'Cafe', activity: 'Waiting',
    mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME,
  })))
  await fixture.db.insert(schedules).values({ personId: 'resident', timelineId: 'home-main', worldDate: '2026-09-21',
    itemsJson: JSON.stringify([{ start: '08:00', end: '12:00', location: 'Cafe', activity: 'Waiting' }]), generatedAt: WORLD_TIME })
  await fixture.db.insert(commitments).values({ id: 'source-promise', worldId: 'home-world', timelineId: 'home-main',
    personId: 'resident', visitorId: 'visitor', sourceDialogueId: 'source-dialogue', title: 'Meet at noon',
    kind: 'meeting', location: 'Cafe', dueSim: '2026-09-21T12:00:00.000Z', status: 'proposed',
    createdSim: WORLD_TIME, updatedSim: WORLD_TIME, createdAt: WORLD_TIME,
  })

  const child = await forkTimeline(fixture.db, 'home-world', 'home-main')
  const copied = (await fixture.db.select().from(commitments).where(eq(commitments.timelineId, child.id)).get())!
  expect(await auditUniverse(fixture.db, 'home-world', child.id)).toEqual([])
  const copiedSchedule = (await fixture.db.select().from(schedules).where(eq(schedules.timelineId, child.id)).get())!
  await fixture.db.update(schedules).set({ itemsJson: '[]' }).where(eq(schedules.timelineId, child.id))
  expect(await auditUniverse(fixture.db, 'home-world', child.id)).toContainEqual(expect.objectContaining({
    code: 'schedule_projection', commandId: `baseline:${child.id}`, version: 0,
  }))
  await fixture.db.update(schedules).set({ itemsJson: copiedSchedule.itemsJson }).where(eq(schedules.timelineId, child.id))
  expect(await auditUniverse(fixture.db, 'home-world', child.id)).toEqual([])

  await fixture.db.update(commitments).set({ title: 'A different promise' }).where(eq(commitments.id, copied.id))
  expect(await auditUniverse(fixture.db, 'home-world', child.id)).toContainEqual(expect.objectContaining({
    code: 'commitment_projection', commandId: `baseline:${child.id}`, version: 0,
  }))
  await fixture.db.update(commitments).set({ title: 'Meet at noon' }).where(eq(commitments.id, copied.id))
  await commitWorldCommand(fixture.db, { id: 'child-accept-promise', worldId: 'home-world', timelineId: child.id,
    userId: 'owner', expectedVersion: 0, action: { type: 'commitment', commitmentId: copied.id, next: 'accepted' } })
  expect(await auditUniverse(fixture.db, 'home-world', child.id)).toEqual([])

  await fixture.db.insert(commitments).values({ id: 'orphan-child-promise', worldId: 'home-world', timelineId: child.id,
    personId: 'resident', visitorId: 'visitor', title: 'No source', kind: 'meeting', location: 'Cafe',
    dueSim: '2026-09-21T13:00:00.000Z', status: 'proposed', createdSim: WORLD_TIME,
    updatedSim: WORLD_TIME, createdAt: WORLD_TIME,
  })
  expect(await auditUniverse(fixture.db, 'home-world', child.id)).toContainEqual(expect.objectContaining({
    code: 'unproven_commitment_projection', version: 1,
  }))
})

it('audits resident mood changes produced by commitment fulfillment', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values([
    { id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME },
    { id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME },
  ])
  await fixture.db.insert(worldPersons).values(['resident', 'visitor'].map(personId => ({
    worldId: 'home-world', personId, joinedAt: WORLD_TIME,
  })))
  await fixture.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Meet a friend', updatedRealAt: WORLD_TIME })
  await fixture.db.insert(commitments).values({ id: 'fulfilled-promise', worldId: 'home-world', timelineId: 'home-main',
    personId: 'resident', visitorId: 'visitor', sourceDialogueId: 'scene', title: 'Meet', kind: 'meeting',
    location: 'Cafe', dueSim: '2026-09-21T08:30:00.000Z', status: 'accepted', createdSim: WORLD_TIME,
    updatedSim: WORLD_TIME, createdAt: WORLD_TIME })

  await commitWorldCommand(fixture.db, { id: 'fulfill-promise', worldId: 'home-world', timelineId: 'home-main',
    userId: 'owner', expectedVersion: 0, action: { type: 'commitment', commitmentId: 'fulfilled-promise', next: 'fulfilled' } })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])

  const relationMemoryId = 'commitment:fulfilled-promise:fulfilled:memory'
  const relationMemory = (await fixture.db.select().from(memories).where(eq(memories.id, relationMemoryId)).get())!
  await fixture.db.update(memories).set({ content: 'A different memory.' }).where(eq(memories.id, relationMemoryId))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
    code: 'memory_projection', commandId: 'fulfill-promise', version: 1,
  }))
  await fixture.db.update(memories).set({ content: relationMemory.content }).where(eq(memories.id, relationMemoryId))

  await fixture.db.update(personStates).set({ mood: 'Calm' }).where(eq(personStates.personId, 'resident'))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
    code: 'state_projection', commandId: 'fulfill-promise', version: 1,
  }))
})

it('audits memories emitted by resident-state transitions', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })

  const result = await recordResidentState(fixture.db, { worldId: 'home-world', timelineId: 'home-main', sourceKey: 'memory-beat',
    action: { type: 'resident_state', personId: 'resident', cause: 'beat', windowStart: WORLD_TIME,
      patch: { mood: 'Hopeful' }, events: [{ simTime: WORLD_TIME, title: 'A kind word', description: 'A friend offered to help.' }],
      memories: [{ type: 'relationship', content: 'A friend offered to help.', importance: 7 }] } })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])

  const memoryId = `${result.commandId}:memory:0`
  await fixture.db.update(memories).set({ content: 'A different memory.' }).where(eq(memories.id, memoryId))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
    code: 'memory_projection', commandId: result.commandId, version: 1,
  }))
})

it('audits each narrative event emitted by resident-state transitions', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })

  const result = await recordResidentState(fixture.db, { worldId: 'home-world', timelineId: 'home-main', sourceKey: 'story-beat',
    action: { type: 'resident_state', personId: 'resident', cause: 'beat', windowStart: WORLD_TIME,
      patch: { activity: 'Helping a friend' },
      events: [{ simTime: WORLD_TIME, title: 'A neighbor arrived', description: 'The resident welcomed a neighbor.' }], memories: [] } })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])

  await fixture.db.update(events).set({ description: 'A different story.' })
    .where(eq(events.id, `${result.commandId}:story:0`))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
    code: 'event_projection', commandId: result.commandId, version: 1,
  }))
})

it('audits command/fact versions and finds corrupted resident-state projections', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Learn', updatedRealAt: WORLD_TIME })
  await commitWorldCommand(fixture.db, { id: 'walk', worldId: 'home-world', timelineId: 'home-main', userId: 'owner', expectedVersion: 0,
    action: { type: 'move', personId: 'resident', to: 'Library' } })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
  await fixture.db.update(personStates).set({ location: 'Cafe' }).where(eq(personStates.personId, 'resident'))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([expect.objectContaining({ code: 'state_projection', commandId: 'walk', version: 1 })])

  await fixture.db.update(personStates).set({ location: 'Library' }).where(eq(personStates.personId, 'resident'))
  const nextSimTime = '2026-09-21T09:00:00.000Z'
  await commitWorldCommand(fixture.db, { id: 'clock-before-return', worldId: 'home-world', timelineId: 'home-main', userId: 'owner', actorKind: 'system', expectedVersion: 1,
    action: { type: 'clock_advance', from: WORLD_TIME, to: nextSimTime, observedAt: nextSimTime } })
  await recordResidentState(fixture.db, { worldId: 'home-world', timelineId: 'home-main', sourceKey: 'beat-location',
    action: { type: 'resident_state', personId: 'resident', cause: 'beat', windowStart: WORLD_TIME,
      patch: { location: 'Cafe' }, events: [{ simTime: WORLD_TIME, title: 'Back to the cafe', description: 'The resident returned.' }], memories: [] } })
  await commitWorldCommand(fixture.db, { id: 'intervention-audit', worldId: 'home-world', timelineId: 'home-main', userId: 'owner', expectedVersion: 3,
    action: { type: 'intervention', requestId: 'audit-request', text: 'The rain starts.' } })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])

  await fixture.db.update(personStates).set({ activity: 'Looking elsewhere' }).where(eq(personStates.personId, 'resident'))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([expect.objectContaining({
    code: 'state_projection', commandId: expect.stringMatching(/^system:/), version: 3,
  })])
  await fixture.db.update(personStates).set({ activity: 'Reading' }).where(eq(personStates.personId, 'resident'))
  await fixture.db.update(timelines).set({ simNow: '2026-09-21T09:01:00.000Z' }).where(eq(timelines.id, 'home-main'))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([expect.objectContaining({
    code: 'timeline_clock_projection', commandId: 'intervention-audit', version: 4,
  })])
})

it('audits derived event timeline, world time, and event kind against its committed fact', async () => {
  fixture = await createWorldFixture()
  await commitWorldCommand(fixture.db, { id: 'event-projection', worldId: 'home-world', timelineId: 'home-main',
    userId: 'owner', expectedVersion: 0,
    action: { type: 'environment', location: 'Cafe', condition: 'weather', value: 'Rain begins.' } })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])

  await fixture.db.update(events).set({ simTime: '2026-09-21T08:01:00.000Z' }).where(eq(events.id, 'command:event-projection'))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([expect.objectContaining({
    code: 'event_projection', commandId: 'event-projection', version: 1,
  })])
  await fixture.db.update(events).set({ simTime: WORLD_TIME, kind: 'dialogue' }).where(eq(events.id, 'command:event-projection'))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([expect.objectContaining({
    code: 'event_projection', commandId: 'event-projection', version: 1,
  })])
  await fixture.db.update(events).set({ kind: 'action', timelineId: 'other-main' }).where(eq(events.id, 'command:event-projection'))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([expect.objectContaining({
    code: 'event_missing', commandId: 'event-projection', version: 1,
  })])
  await fixture.db.update(events).set({ timelineId: 'home-main', description: 'The sun is shining.' }).where(eq(events.id, 'command:event-projection'))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
    code: 'event_projection', commandId: 'event-projection', version: 1,
  }))
})

it('audits environment and knowledge facts against the exact command that produced them', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await commitWorldCommand(fixture.db, { id: 'set-rain', worldId: 'home-world', timelineId: 'home-main',
    userId: 'owner', expectedVersion: 0,
    action: { type: 'environment', location: 'Cafe', condition: 'weather', value: 'Rain begins.' } })
  await commitWorldCommand(fixture.db, { id: 'tell-resident', worldId: 'home-world', timelineId: 'home-main',
    userId: 'owner', expectedVersion: 1,
    action: { type: 'inform', recipientId: 'resident', topic: 'weather', content: 'It is raining at the cafe.', sourceFactId: (await fixture.db.select().from(worldFacts).get())!.id } })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])

  // Simulate a writer that bypassed the immutable-history triggers.
  fixture.sqlite.exec('DROP TRIGGER world_facts_immutable_update')
  const environment = (await fixture.db.select().from(worldFacts).where(eq(worldFacts.factType, 'environment')).get())!
  await fixture.db.update(worldFacts).set({ valueJson: JSON.stringify({ location: 'Cafe', condition: 'weather', value: 'Clear skies.' }) })
    .where(eq(worldFacts.id, environment.id))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
    code: 'fact_command_projection', commandId: 'set-rain', version: 1,
  }))

  await fixture.db.update(worldFacts).set({ valueJson: environment.valueJson }).where(eq(worldFacts.id, environment.id))
  const knowledge = (await fixture.db.select().from(worldFacts).where(eq(worldFacts.factType, 'knowledge')).get())!
  const knowledgeValue = JSON.parse(knowledge.valueJson) as Record<string, unknown>
  await fixture.db.update(worldFacts).set({ valueJson: JSON.stringify({ ...knowledgeValue, content: 'It is sunny at the cafe.' }) })
    .where(eq(worldFacts.id, knowledge.id))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
    code: 'fact_command_projection', commandId: 'tell-resident', version: 2,
  }))

  await fixture.db.update(worldFacts).set({ valueJson: knowledge.valueJson, visibility: 'private' }).where(eq(worldFacts.id, knowledge.id))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
  await fixture.db.update(worldFacts).set({ visibility: 'world' }).where(eq(worldFacts.id, knowledge.id))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
    code: 'fact_visibility_projection', commandId: 'tell-resident', version: 2,
  }))
})

it('audits rumor certainty against the cited knowledge fact instead of trusting its stored label', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values([
    { id: 'resident-a', userId: 'owner', name: 'Resident A', modelJson: '{}', createdAt: WORLD_TIME },
    { id: 'resident-b', userId: 'owner', name: 'Resident B', modelJson: '{}', createdAt: WORLD_TIME },
  ])
  await fixture.db.insert(worldPersons).values([
    { worldId: 'home-world', personId: 'resident-a', joinedAt: WORLD_TIME },
    { worldId: 'home-world', personId: 'resident-b', joinedAt: WORLD_TIME },
  ])
  await commitWorldCommand(fixture.db, { id: 'first-rumor', worldId: 'home-world', timelineId: 'home-main',
    userId: 'owner', expectedVersion: 0,
    action: { type: 'inform', recipientId: 'resident-a', topic: 'missing-key', content: 'The key may be in the garden.' } })
  const source = (await fixture.db.select().from(worldFacts).where(eq(worldFacts.version, 1)).get())!
  await commitWorldCommand(fixture.db, { id: 'relay-rumor', worldId: 'home-world', timelineId: 'home-main',
    userId: 'owner', expectedVersion: 1,
    action: { type: 'inform', recipientId: 'resident-b', topic: 'missing-key',
      content: 'A says the key may be in the garden.', sourceFactId: source.id } })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])

  fixture.sqlite.exec('DROP TRIGGER world_facts_immutable_update')
  const relayed = (await fixture.db.select().from(worldFacts).where(eq(worldFacts.version, 2)).get())!
  const value = JSON.parse(relayed.valueJson) as Record<string, unknown>
  await fixture.db.update(worldFacts).set({ valueJson: JSON.stringify({ ...value, certainty: 'fact' }) })
    .where(eq(worldFacts.id, relayed.id))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
    code: 'knowledge_certainty_projection', commandId: 'relay-rumor', version: 2,
  }))
})

it('records elapsed simulation time as one atomic versioned fact without a narrative event', async () => {
  fixture = await createWorldFixture()
  const firstRealTime = new Date(WORLD_TIME)
  expect(await advanceWorldClock(fixture.db, { worldId: 'home-world', timelineId: 'home-main', observedAt: firstRealTime,
    worldSpeed: 6, maxElapsedSeconds: 150 })).toBe(WORLD_TIME)
  const pausedRealTime = new Date(firstRealTime.getTime() + 15_000)
  expect(await advanceWorldClock(fixture.db, { worldId: 'home-world', timelineId: 'home-main', observedAt: pausedRealTime,
    worldSpeed: 0, maxElapsedSeconds: 150 })).toBe(WORLD_TIME)
  expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.timelineId, 'home-main')).all()).toHaveLength(0)
  const nextRealTime = new Date(firstRealTime.getTime() + 30_000)
  const advanced = await advanceWorldClock(fixture.db, { worldId: 'home-world', timelineId: 'home-main', observedAt: nextRealTime,
    worldSpeed: 6, maxElapsedSeconds: 150 })
  expect(advanced).toBe('2026-09-21T08:01:30.000Z')
  expect((await fixture.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())?.lastRealTickAt).toBe(nextRealTime.toISOString())
  expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.timelineId, 'home-main')).all()).toMatchObject([
    expect.objectContaining({ factType: 'clock', simTime: advanced, version: 1 }),
  ])
  expect(await fixture.db.select().from(worldCommands).where(eq(worldCommands.timelineId, 'home-main')).all()).toHaveLength(1)
  expect(await fixture.db.select().from(events).where(eq(events.timelineId, 'home-main')).all()).toHaveLength(0)
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
})

it('rolls back clock, revision and command if its fact write fails', async () => {
  fixture = await createWorldFixture()
  const firstRealTime = new Date(WORLD_TIME)
  await advanceWorldClock(fixture.db, { worldId: 'home-world', timelineId: 'home-main', observedAt: firstRealTime,
    worldSpeed: 6, maxElapsedSeconds: 150 })
  fixture.sqlite.exec("CREATE TRIGGER reject_clock_fact BEFORE INSERT ON world_facts WHEN NEW.fact_type = 'clock' BEGIN SELECT RAISE(ABORT, 'forced clock failure'); END")
  await expect(advanceWorldClock(fixture.db, { worldId: 'home-world', timelineId: 'home-main',
    observedAt: new Date(firstRealTime.getTime() + 15_000), worldSpeed: 6, maxElapsedSeconds: 150 })).rejects.toThrow()
  expect((await fixture.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get()))
    .toMatchObject({ simNow: WORLD_TIME, lastRealTickAt: firstRealTime.toISOString() })
  expect(await fixture.db.select().from(worldCommands).where(eq(worldCommands.timelineId, 'home-main')).all()).toHaveLength(0)
  expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.timelineId, 'home-main')).all()).toHaveLength(0)
  expect((await fixture.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())?.version).toBe(0)
})

it('serializes two simultaneous clock advances from the same real-time anchor', async () => {
  const current = await createWorldFixture()
  fixture = current
  const firstRealTime = new Date(WORLD_TIME)
  await advanceWorldClock(current.db, { worldId: 'home-world', timelineId: 'home-main', observedAt: firstRealTime,
    worldSpeed: 6, maxElapsedSeconds: 150 })
  const observedAt = new Date(firstRealTime.getTime() + 15_000)
  const results = await Promise.all([0, 1].map(() => advanceWorldClock(current.db, { worldId: 'home-world', timelineId: 'home-main',
    observedAt, worldSpeed: 6, maxElapsedSeconds: 150 })))
  expect(results).toEqual(['2026-09-21T08:01:30.000Z', '2026-09-21T08:01:30.000Z'])
  expect(await current.db.select().from(worldCommands).where(eq(worldCommands.timelineId, 'home-main')).all()).toHaveLength(1)
  expect(await current.db.select().from(worldFacts).where(eq(worldFacts.timelineId, 'home-main')).all()).toHaveLength(1)
  expect(await auditUniverse(current.db, 'home-world', 'home-main')).toEqual([])
})

it('records the first beat watermark as a private idempotent checkpoint without a public event', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Learn', updatedRealAt: WORLD_TIME })
  const input = { worldId: 'home-world', timelineId: 'home-main', sourceKey: 'beat-watermark:home-main:resident:first',
    personId: 'resident', lastBeatSimTime: WORLD_TIME }
  const first = await recordSimulationCheckpoint(fixture.db, input)
  const replay = await recordSimulationCheckpoint(fixture.db, input)
  expect(first).toMatchObject({ version: 1, replayed: false })
  expect(replay).toMatchObject({ version: 1, replayed: true })
  expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'resident')).get())?.lastBeatSimTime).toBe(WORLD_TIME)
  expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.timelineId, 'home-main')).all())
    .toMatchObject([expect.objectContaining({ factType: 'resident_state', visibility: 'private', version: 1 })])
  expect(await fixture.db.select().from(events).where(eq(events.timelineId, 'home-main')).all()).toHaveLength(0)
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
})

it('rolls back a simulation checkpoint when its fact cannot be recorded', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Learn', updatedRealAt: WORLD_TIME })
  fixture.sqlite.exec("CREATE TRIGGER reject_checkpoint_fact BEFORE INSERT ON world_facts WHEN json_extract(NEW.value_json, '$.cause') = 'runtime_checkpoint' BEGIN SELECT RAISE(ABORT, 'forced checkpoint failure'); END")
  await expect(recordSimulationCheckpoint(fixture.db, { worldId: 'home-world', timelineId: 'home-main', sourceKey: 'first',
    personId: 'resident', lastBeatSimTime: WORLD_TIME })).rejects.toThrow()
  expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'resident')).get())?.lastBeatSimTime).toBeNull()
  expect(await fixture.db.select().from(worldCommands).where(eq(worldCommands.timelineId, 'home-main')).all()).toHaveLength(0)
  expect(await fixture.db.select().from(worldFacts).where(eq(worldFacts.timelineId, 'home-main')).all()).toHaveLength(0)
  expect((await fixture.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())?.version).toBe(0)
})

it('records stale dialogue-lock recovery privately and keeps the projection auditable', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Learn', currentDialogueId: 'ended-dialogue', updatedRealAt: WORLD_TIME })
  await fixture.db.insert(dialogues).values({ id: 'ended-dialogue', timelineId: 'home-main', location: 'Cafe',
    participantIdsJson: JSON.stringify(['resident']), status: 'ended', kind: 'npc', turnLimit: 2, simStart: WORLD_TIME })
  const input = { worldId: 'home-world', timelineId: 'home-main', sourceKey: 'dialogue-recovery:home-main:resident:ended-dialogue',
    personId: 'resident', dialogueId: 'ended-dialogue' }
  const first = await recoverDialogueLock(fixture.db, input)
  const replay = await recoverDialogueLock(fixture.db, input)
  expect(first).toMatchObject({ version: 1, replayed: false })
  expect(replay).toMatchObject({ version: 1, replayed: true })
  expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'resident')).get())?.currentDialogueId).toBeNull()
  expect(await fixture.db.select().from(events).where(eq(events.timelineId, 'home-main')).all()).toHaveLength(0)
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
  await fixture.db.update(personStates).set({ currentDialogueId: 'ended-dialogue' }).where(eq(personStates.personId, 'resident'))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([expect.objectContaining({
    code: 'state_projection', version: 1,
  })])
  await fixture.db.insert(persons).values({ id: 'resident-two', userId: 'owner', name: 'Resident Two', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident-two', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ personId: 'resident-two', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', currentDialogueId: 'missing-dialogue', updatedRealAt: WORLD_TIME })
  const missing = await recoverDialogueLock(fixture.db, { worldId: 'home-world', timelineId: 'home-main',
    sourceKey: 'dialogue-recovery:home-main:resident-two:missing-dialogue', personId: 'resident-two', dialogueId: 'missing-dialogue' })
  expect(missing).toMatchObject({ version: 2, replayed: false })
  expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'resident-two')).get())?.currentDialogueId).toBeNull()
  await fixture.db.update(personStates).set({ currentDialogueId: null }).where(eq(personStates.personId, 'resident'))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
})

it('does not clear an ongoing dialogue lock and rolls back failed recovery fact writes', async () => {
  const current = await createWorldFixture()
  fixture = current
  await current.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await current.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await current.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Learn', currentDialogueId: 'ongoing-dialogue', updatedRealAt: WORLD_TIME })
  await current.db.insert(dialogues).values({ id: 'ongoing-dialogue', timelineId: 'home-main', location: 'Cafe',
    participantIdsJson: JSON.stringify(['resident']), status: 'ongoing', kind: 'npc', turnLimit: 2, simStart: WORLD_TIME })
  const active = { worldId: 'home-world', timelineId: 'home-main', sourceKey: 'active-recovery',
    personId: 'resident', dialogueId: 'ongoing-dialogue' }
  await expect(recoverDialogueLock(current.db, active)).rejects.toMatchObject({ status: 409 })
  expect((await current.db.select().from(personStates).where(eq(personStates.personId, 'resident')).get())?.currentDialogueId).toBe('ongoing-dialogue')
  expect(await current.db.select().from(worldCommands).where(eq(worldCommands.timelineId, 'home-main')).all()).toHaveLength(0)

  await current.db.update(dialogues).set({ status: 'ended' }).where(eq(dialogues.id, 'ongoing-dialogue'))
  current.sqlite.exec("CREATE TRIGGER reject_dialogue_recovery BEFORE INSERT ON world_facts WHEN json_extract(NEW.value_json, '$.cause') = 'dialogue_recovery' BEGIN SELECT RAISE(ABORT, 'forced recovery failure'); END")
  await expect(recoverDialogueLock(current.db, { ...active, sourceKey: 'failed-recovery' })).rejects.toThrow()
  expect((await current.db.select().from(personStates).where(eq(personStates.personId, 'resident')).get())?.currentDialogueId).toBe('ongoing-dialogue')
  expect(await current.db.select().from(worldCommands).where(eq(worldCommands.timelineId, 'home-main')).all()).toHaveLength(0)
  expect(await current.db.select().from(worldFacts).where(eq(worldFacts.timelineId, 'home-main')).all()).toHaveLength(0)
  expect((await current.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())?.version).toBe(0)
})

it('rejects dialogue recovery atomically if the resident lock changes after validation', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Learn', currentDialogueId: 'ended-dialogue', updatedRealAt: WORLD_TIME })
  await fixture.db.insert(dialogues).values({ id: 'ended-dialogue', timelineId: 'home-main', location: 'Cafe',
    participantIdsJson: JSON.stringify(['resident']), status: 'ended', kind: 'npc', turnLimit: 2, simStart: WORLD_TIME })
  fixture.sqlite.exec("CREATE TRIGGER race_dialogue_recovery BEFORE INSERT ON world_commands WHEN NEW.type = 'dialogue_recovery' BEGIN UPDATE person_states SET current_dialogue_id = NULL WHERE person_id = 'resident' AND timeline_id = 'home-main'; END")

  await expect(recoverDialogueLock(fixture.db, { worldId: 'home-world', timelineId: 'home-main',
    sourceKey: 'racing-recovery', personId: 'resident', dialogueId: 'ended-dialogue' })).rejects.toThrow()
  expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'resident')).get())?.currentDialogueId).toBe('ended-dialogue')
  expect(await fixture.db.select().from(worldCommands).all()).toHaveLength(0)
  expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(0)
  expect((await fixture.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())?.version).toBe(0)
})

it('rebuilds dialogue lock and closure projections from immutable conversation facts', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values([
    { id: 'a', userId: 'owner', name: 'A', modelJson: '{}', isUser: true, createdAt: WORLD_TIME },
    { id: 'b', userId: 'owner', name: 'B', modelJson: '{}', createdAt: WORLD_TIME },
  ])
  await fixture.db.insert(worldPersons).values([
    { worldId: 'home-world', personId: 'a', joinedAt: WORLD_TIME },
    { worldId: 'home-world', personId: 'b', joinedAt: WORLD_TIME },
  ])
  await fixture.db.insert(personStates).values(['a', 'b'].map(personId => ({ personId, timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Talk', updatedRealAt: WORLD_TIME })))
  await fixture.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
    modelJson: JSON.stringify({ name: 'Home world', description: 'A small town',
      locations: [{ name: 'Cafe', description: '' }],
      residents: ['a', 'b'].map(id => ({ id, name: id, model: {} })),
      initialStates: { capturedAt: WORLD_TIME, states: ['a', 'b'].map(personId => ({
      personId, simTime: WORLD_TIME, location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Talk',
      lastBeatSimTime: null, currentDialogueId: null,
    })) } }) })

  await commitWorldCommand(fixture.db, { id: 'dialogue-start', worldId: 'home-world', timelineId: 'home-main', userId: 'owner',
    actorKind: 'system', expectedVersion: 0,
    action: { type: 'dialogue_start', dialogueId: 'npc-dialogue', participantIds: ['a', 'b'], location: 'Cafe', turnLimit: 2 } })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])

  await commitWorldCommand(fixture.db, { id: 'dialogue-turn-0', worldId: 'home-world', timelineId: 'home-main', userId: 'owner',
    actorKind: 'system', expectedVersion: 1,
    action: { type: 'dialogue_turn', dialogueId: 'npc-dialogue', speakerId: 'a', turnIndex: 0,
      utterance: 'Hello.', thought: 'I should greet them.', memory: null, shouldEnd: false } })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])

  await commitWorldCommand(fixture.db, { id: 'dialogue-turn-1', worldId: 'home-world', timelineId: 'home-main', userId: 'owner',
    actorKind: 'system', expectedVersion: 2,
    action: { type: 'dialogue_turn', dialogueId: 'npc-dialogue', speakerId: 'b', turnIndex: 1,
      utterance: 'Hello back.', thought: 'This is a pleasant surprise.', memory: null, shouldEnd: false } })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
  expect(await fixture.db.select().from(personStates).where(eq(personStates.currentDialogueId, 'npc-dialogue')).all()).toHaveLength(0)
  const firstTurn = await fixture.db.select().from(dialogueTurns).where(eq(dialogueTurns.id, 'dialogue-turn-0:turn')).get()
  await fixture.db.delete(dialogueTurns).where(eq(dialogueTurns.id, 'dialogue-turn-0:turn'))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([expect.objectContaining({
    code: 'conversation_projection', commandId: 'dialogue-turn-0', version: 2,
  })])
  await fixture.db.insert(dialogueTurns).values(firstTurn!)
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])

  // Conversation facts must also agree with the exact dialogue command, not just
  // with the derived dialogue/turn rows.
  fixture.sqlite.exec('DROP TRIGGER world_facts_immutable_update')
  const turnFact = (await fixture.db.select().from(worldFacts).where(eq(worldFacts.version, 2)).get())!
  const originalTurnValue = turnFact.valueJson
  const alteredTurn = JSON.parse(originalTurnValue) as Record<string, unknown>
  await fixture.db.update(worldFacts).set({ valueJson: JSON.stringify({ ...alteredTurn, utterance: 'Different words.' }) })
    .where(eq(worldFacts.id, turnFact.id))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
    code: 'fact_command_projection', commandId: 'dialogue-turn-0', version: 2,
  }))
  await fixture.db.update(worldFacts).set({ valueJson: originalTurnValue }).where(eq(worldFacts.id, turnFact.id))
  const startFact = (await fixture.db.select().from(worldFacts).where(eq(worldFacts.version, 1)).get())!
  const alteredStart = JSON.parse(startFact.valueJson) as Record<string, unknown>
  await fixture.db.update(worldFacts).set({ valueJson: JSON.stringify({ ...alteredStart, location: 'Library' }) })
    .where(eq(worldFacts.id, startFact.id))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
    code: 'fact_command_projection', commandId: 'dialogue-start', version: 1,
  }))
  await fixture.db.update(worldFacts).set({ valueJson: startFact.valueJson }).where(eq(worldFacts.id, startFact.id))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
  await fixture.db.insert(dialogues).values({ id: 'unproven-dialogue', timelineId: 'home-main', location: 'Cafe',
    participantIdsJson: JSON.stringify(['a', 'b']), status: 'ended', turnLimit: 2, simStart: WORLD_TIME, simEnd: WORLD_TIME, kind: 'scene' })
  await fixture.db.insert(dialogueTurns).values({ id: 'unproven-turn', dialogueId: 'unproven-dialogue', turnIndex: 0,
    personId: 'a', utterance: 'Unproven', thought: '', simTime: WORLD_TIME, createdAt: WORLD_TIME })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'unproven_conversation_projection', version: 3 }),
    expect.objectContaining({ code: 'unproven_dialogue_turn_projection', version: 3 }),
  ]))
})

it('records memory compression privately, atomically and with auditable provenance', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await fixture.db.insert(memories).values([
    { id: 'memory-one', personId: 'resident', timelineId: 'home-main', type: 'thought', content: 'The rain is slowing.',
      simTime: WORLD_TIME, createdAt: WORLD_TIME, importance: 4 },
    { id: 'memory-two', personId: 'resident', timelineId: 'home-main', type: 'timeline', content: 'A friend arrived.',
      simTime: WORLD_TIME, createdAt: '2026-09-21T08:01:00.000Z', importance: 6 },
  ])
  const input = { worldId: 'home-world', timelineId: 'home-main', personId: 'resident',
    sourceMemoryIds: ['memory-one', 'memory-two'], content: 'The rain eased as a friend arrived.', importance: 7,
    simTime: WORLD_TIME, createdAt: '2026-09-21T08:01:00.000Z' }
  const first = await recordMemorySummary(fixture.db, input)
  expect(await recordMemorySummary(fixture.db, input)).toMatchObject({ version: 1, replayed: true })
  const stored = await fixture.db.select().from(memories).all()
  expect(stored.filter(memory => memory.id.startsWith('summary:'))).toMatchObject([
    expect.objectContaining({ type: 'summary', summarized: false, content: input.content }),
  ])
  expect(stored.filter(memory => input.sourceMemoryIds.includes(memory.id)).every(memory => memory.summarized)).toBe(true)
  expect(await fixture.db.select().from(worldFacts).all()).toMatchObject([
    expect.objectContaining({ factType: 'memory_summary', visibility: 'private', version: 1 }),
  ])
  expect(await fixture.db.select().from(events).where(eq(events.timelineId, 'home-main')).all()).toHaveLength(0)
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
  const summaryId = JSON.parse((await fixture.db.select().from(worldFacts).get())!.valueJson).summaryId as string
  await fixture.db.update(memories).set({ summarized: false }).where(eq(memories.id, 'memory-one'))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([expect.objectContaining({
    code: 'memory_summary_projection', commandId: first.commandId, version: 1,
  })])
  await fixture.db.update(memories).set({ summarized: true }).where(eq(memories.id, 'memory-one'))
  expect(summaryId).toMatch(/^summary:/)
  fixture.sqlite.exec('DROP TRIGGER world_facts_immutable_update')
  const summaryFact = (await fixture.db.select().from(worldFacts).get())!
  const summaryValue = JSON.parse(summaryFact.valueJson) as Record<string, unknown>
  await fixture.db.update(worldFacts).set({ valueJson: JSON.stringify({ ...summaryValue, content: 'Unrelated replacement.' }) })
    .where(eq(worldFacts.id, summaryFact.id))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
    code: 'fact_command_projection', commandId: first.commandId, version: 1,
  }))
})

it('rolls back source summary flags and the new summary if its fact cannot be recorded', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await fixture.db.insert(memories).values({ id: 'memory-one', personId: 'resident', timelineId: 'home-main',
    type: 'thought', content: 'The rain is slowing.', simTime: WORLD_TIME, createdAt: WORLD_TIME, importance: 4 })
  fixture.sqlite.exec("CREATE TRIGGER reject_memory_summary_fact BEFORE INSERT ON world_facts WHEN NEW.fact_type = 'memory_summary' BEGIN SELECT RAISE(ABORT, 'forced summary failure'); END")
  await expect(recordMemorySummary(fixture.db, { worldId: 'home-world', timelineId: 'home-main', personId: 'resident',
    sourceMemoryIds: ['memory-one'], content: 'The rain eased.', importance: 6, simTime: WORLD_TIME, createdAt: WORLD_TIME })).rejects.toThrow()
  expect((await fixture.db.select().from(memories).get())?.summarized).toBe(false)
  expect(await fixture.db.select().from(memories).all()).toHaveLength(1)
  expect(await fixture.db.select().from(worldCommands).all()).toHaveLength(0)
  expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(0)
  expect((await fixture.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())?.version).toBe(0)
})

it('compares the full proven commitment projection against its latest immutable fact', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values([
    { id: 'a', userId: 'owner', name: 'A', modelJson: '{}', isUser: true, createdAt: WORLD_TIME },
    { id: 'b', userId: 'owner', name: 'B', modelJson: '{}', createdAt: WORLD_TIME },
  ])
  await fixture.db.insert(worldPersons).values([
    { worldId: 'home-world', personId: 'a', joinedAt: WORLD_TIME },
    { worldId: 'home-world', personId: 'b', joinedAt: WORLD_TIME },
  ])
  await fixture.db.insert(dialogues).values({ id: 'source-scene', timelineId: 'home-main', location: 'Cafe',
    participantIdsJson: JSON.stringify(['a', 'b']), simStart: WORLD_TIME, kind: 'scene', visitorId: 'a' })
  await commitWorldCommand(fixture.db, { id: 'propose-promise', worldId: 'home-world', timelineId: 'home-main', userId: 'owner', expectedVersion: 0,
    action: { type: 'commitment_proposal', commitmentId: 'promise', personId: 'b', visitorId: 'a', sourceDialogueId: 'source-scene',
      title: 'Meet again', kind: 'meeting', location: 'Cafe', dueSim: '2026-09-21T10:00:00.000Z' } })
  await commitWorldCommand(fixture.db, { id: 'decline-promise', worldId: 'home-world', timelineId: 'home-main', userId: 'owner', expectedVersion: 1,
    action: { type: 'commitment', commitmentId: 'promise', next: 'declined' } })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
  await fixture.db.update(commitments).set({ title: 'Different event', dueSim: '2026-09-21T12:00:00.000Z' }).where(eq(commitments.id, 'promise'))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([expect.objectContaining({
    code: 'commitment_projection', commandId: 'decline-promise', version: 2,
  })])
  await fixture.db.update(commitments).set({ title: 'Meet again', dueSim: '2026-09-21T10:00:00.000Z', status: 'proposed' })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([expect.objectContaining({
    code: 'commitment_projection', commandId: 'decline-promise', version: 2,
  })])
  await fixture.db.update(commitments).set({ status: 'declined', updatedSim: WORLD_TIME })
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])

  fixture.sqlite.exec('DROP TRIGGER world_facts_immutable_update')
  const proposal = (await fixture.db.select().from(worldFacts).where(eq(worldFacts.version, 1)).get())!
  const proposalValue = JSON.parse(proposal.valueJson) as Record<string, unknown>
  await fixture.db.update(worldFacts).set({ valueJson: JSON.stringify({ ...proposalValue, title: 'An altered promise' }) })
    .where(eq(worldFacts.id, proposal.id))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
    code: 'fact_command_projection', commandId: 'propose-promise', version: 1,
  }))
  const restoredProposalValue = proposal.valueJson
  await fixture.db.update(worldFacts).set({ valueJson: restoredProposalValue }).where(eq(worldFacts.id, proposal.id))
  const transition = (await fixture.db.select().from(worldFacts).where(eq(worldFacts.version, 2)).get())!
  const transitionValue = JSON.parse(transition.valueJson) as Record<string, unknown>
  await fixture.db.update(worldFacts).set({ valueJson: JSON.stringify({ ...transitionValue, to: 'fulfilled' }) })
    .where(eq(worldFacts.id, transition.id))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
    code: 'fact_command_projection', commandId: 'decline-promise', version: 2,
  }))
})

it('reports corrupted history that assigns two locations to one resident at one world time', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Explore', updatedRealAt: WORLD_TIME })
  await commitWorldCommand(fixture.db, { id: 'first-location', worldId: 'home-world', timelineId: 'home-main',
    userId: 'owner', expectedVersion: 0, action: { type: 'move', personId: 'resident', to: 'Library' } })

  // Simulate a damaged writer that bypassed the command validator but still satisfied
  // the database's version/command/time constraints, so the auditor must catch it.
  await fixture.db.insert(worldCommands).values({ id: 'corrupt-location', worldId: 'home-world', timelineId: 'home-main',
    actorKind: 'system', actorId: null, type: 'move', payloadJson: JSON.stringify({ type: 'move', personId: 'resident', to: 'Cafe' }),
    expectedVersion: 1, resultVersion: 2, createdAt: WORLD_TIME })
  await fixture.db.update(universeRevisions).set({ version: 2 }).where(eq(universeRevisions.timelineId, 'home-main'))
  await fixture.db.insert(worldFacts).values({ id: 'corrupt-location-fact', timelineId: 'home-main', version: 2, simTime: WORLD_TIME,
    factType: 'location', subjectId: 'resident', valueJson: JSON.stringify({ from: 'Library', to: 'Cafe' }),
    sourceCommandId: 'corrupt-location', visibility: 'world' })

  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'location_time_conflict', commandId: 'corrupt-location', version: 2 }),
  ]))
})

it('reports a fact sourced from another timeline instead of silently omitting it from replay', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(timelines).values({ id: 'foreign-line', worldId: 'home-world', parentTimelineId: null,
    forkScenarioJson: null, simNow: WORLD_TIME, createdAt: WORLD_TIME, status: 'active', ancestorIdsJson: '[]',
    lastRealTickAt: null, forkSnapshotJson: null })
  await fixture.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 1, simTime: WORLD_TIME,
    worldModelVersion: 1, updatedAt: WORLD_TIME })
  await fixture.db.insert(worldCommands).values({ id: 'foreign-command', worldId: 'home-world', timelineId: 'foreign-line',
    actorKind: 'system', actorId: null, type: 'clock_advance', payloadJson: JSON.stringify({ type: 'clock_advance' }),
    expectedVersion: 0, resultVersion: 1, createdAt: WORLD_TIME })
  // Simulate an out-of-band writer that bypassed the database guard.
  fixture.sqlite.exec('DROP TRIGGER world_facts_revision_guard')
  await fixture.db.insert(worldFacts).values({ id: 'cross-line-fact', timelineId: 'home-main', version: 1,
    simTime: WORLD_TIME, factType: 'clock', subjectId: 'home-main', valueJson: '{}',
    sourceCommandId: 'foreign-command', visibility: 'world' })

  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'fact_source_scope', commandId: 'foreign-command', version: 1 }),
  ]))
})

it('reports accepted commands whose action has no immutable fact-audit rule', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Explore', updatedRealAt: WORLD_TIME })
  await commitWorldCommand(fixture.db, { id: 'audited-move', worldId: 'home-world', timelineId: 'home-main',
    userId: 'owner', expectedVersion: 0, action: { type: 'move', personId: 'resident', to: 'Library' } })
  fixture.sqlite.exec('DROP TRIGGER world_commands_immutable_update')
  await fixture.db.update(worldCommands).set({ type: 'future_action', payloadJson: JSON.stringify({ type: 'future_action' }) })
    .where(eq(worldCommands.id, 'audited-move'))

  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
    code: 'command_action_unsupported', commandId: 'audited-move', version: 1,
  }))
})

it('replays fact virtual times backward from the revision and catches a fact shifted across a clock boundary', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Explore', updatedRealAt: WORLD_TIME })
  const nextTime = new Date(Date.parse(WORLD_TIME) + 60_000).toISOString()
  await commitWorldCommand(fixture.db, { id: 'before-clock', worldId: 'home-world', timelineId: 'home-main',
    userId: 'owner', expectedVersion: 0, action: { type: 'move', personId: 'resident', to: 'Library' } })
  await commitWorldCommand(fixture.db, { id: 'advance-clock', worldId: 'home-world', timelineId: 'home-main',
    userId: 'owner', actorKind: 'system', expectedVersion: 1,
    action: { type: 'clock_advance', from: WORLD_TIME, to: nextTime, observedAt: nextTime } })

  fixture.sqlite.exec('DROP TRIGGER world_facts_immutable_update')
  await fixture.db.update(worldFacts).set({ simTime: nextTime }).where(eq(worldFacts.sourceCommandId, 'before-clock'))
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
    code: 'fact_time_projection', commandId: 'before-clock', version: 1,
  }))
})
