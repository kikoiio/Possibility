import { afterEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { dialogueTurns, dialogues, events, memories, personaMessages, persons, personStates, sceneRequests, timelines, universeRevisions, worldFacts, worldModelVersions, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from './world-fixture'
import { auditUniverse } from '../world-state/invariants'
import { buildEngineContext, buildWorldSnapshot } from '../agent/engine-context'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { vi.useRealTimers(); fixture?.close(); fixture = null; vi.unstubAllGlobals() })

it('creates a structured universe and completes observe, enter, act, fork, compare, and return', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  vi.useFakeTimers()
  vi.setSystemTime(new Date(WORLD_TIME))
  const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
  const request = (path: string, method: string, body?: unknown) => app.request(path, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, f.env)

  // The ordinary person-creation flow makes the resident available to a new world.
  const personResponse = await request('/api/persons', 'POST', { name: 'Mina', model: { identity: ['A neighborhood baker'] } })
  expect(personResponse.status).toBe(200)
  const { id: personId } = await personResponse.json() as { id: string }
  const personDetail = await request(`/api/persons/${personId}`, 'GET')
  const personData = await personDetail.json() as { world: { id: string }; timelines: { id: string; parentTimelineId: string | null }[] }
  const defaultMain = personData.timelines.find(timeline => timeline.parentTimelineId === null)!
  const personRevision = await f.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, defaultMain.id)).get()
  const personModel = await f.db.select().from(worldModelVersions).where(eq(worldModelVersions.worldId, personData.world.id)).get()
  expect(JSON.parse(personModel!.modelJson).projectionBaseline).toMatchObject({
    source: 'root', version: 0, simTime: personRevision!.simTime,
    completeDomains: expect.arrayContaining(['clock', 'states', 'schedules', 'events', 'commitments', 'memories',
      'dialogues', 'dialogueTurns', 'personaMessages', 'knowledge']),
    rows: { states: [expect.objectContaining({ personId, timelineId: defaultMain.id })], schedules: [], events: [],
      commitments: [], memories: [], dialogues: [], dialogueTurns: [], personaMessages: [] },
  })
  expect(await auditUniverse(f.db, personData.world.id, defaultMain.id)).toEqual([])

  const worldRequest = {
    name: 'Harbor Town', description: 'A small town by the sea.', personIds: [personId],
    locations: [
      { name: 'Cafe', description: 'A corner cafe' }, { name: 'Harbor', description: 'The old harbor' },
      { name: 'Market', description: 'A morning market' }, { name: 'Library', description: 'A quiet library' },
      { name: 'Square', description: 'The town square' },
    ],
  }
  const createResponse = await request('/api/worlds', 'POST', worldRequest)
  expect(createResponse.status).toBe(200)
  const { id: worldId, timelineId } = await createResponse.json() as { id: string; timelineId: string }
  const universeRevision = await f.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timelineId)).get()
  const worldModel = await f.db.select().from(worldModelVersions).where(eq(worldModelVersions.worldId, worldId)).get()
  expect(JSON.parse(worldModel!.modelJson).projectionBaseline).toMatchObject({
    source: 'root', version: 0, simTime: universeRevision!.simTime,
    completeDomains: expect.arrayContaining(['clock', 'states', 'schedules', 'events', 'commitments', 'memories',
      'dialogues', 'dialogueTurns', 'personaMessages', 'knowledge']),
    rows: { states: [expect.objectContaining({ personId, timelineId })], schedules: [], events: [],
      commitments: [], memories: [], dialogues: [], dialogueTurns: [], personaMessages: [] },
  })
  const repeatedCreate = await request('/api/worlds', 'POST', worldRequest)
  expect(repeatedCreate.status).toBe(200)
  const repeated = await repeatedCreate.json() as { id: string; timelineId: string }
  const repeatedModel = await f.db.select().from(worldModelVersions).where(eq(worldModelVersions.worldId, repeated.id)).get()
  const baselineSummary = (json: string) => {
    const model = JSON.parse(json) as { name: string; description: string; locations: unknown; residents: unknown[];
      initialStates: { capturedAt: string; states: unknown[] }; projectionBaseline: { source: string; version: number;
        simTime: string; completeDomains: string[]; rows: { states: Record<string, unknown>[] } } }
    return { name: model.name, description: model.description, locations: model.locations, residents: model.residents,
      initialStates: model.initialStates,
      projectionBaseline: { ...model.projectionBaseline, rows: { ...model.projectionBaseline.rows,
        states: model.projectionBaseline.rows.states.map(({ timelineId: _timelineId, ...state }) => state) } } }
  }
  expect(baselineSummary(repeatedModel!.modelJson)).toEqual(baselineSummary(worldModel!.modelJson))
  vi.useRealTimers()

  // CREATE → RUN → OBSERVE: a fresh universe is running and has immutable model evidence immediately.
  const observed = await request(`/api/worlds/${worldId}`, 'GET')
  expect(observed.status).toBe(200)
  expect(await observed.json()).toMatchObject({
    world: { name: 'Harbor Town', status: 'running' }, currentTimelineId: timelineId,
    evidenceStatus: 'structured', worldModelVersion: 1,
    locationBoard: expect.arrayContaining([expect.objectContaining({ location: 'Cafe' })]),
  })
  expect(await auditUniverse(f.db, worldId, timelineId)).toEqual([])
  const initialState = await f.db.select().from(personStates).where(eq(personStates.personId, personId)).get()
  expect(initialState).toBeTruthy()
  await f.db.update(personStates).set({ mood: 'Corrupted without a fact' }).where(eq(personStates.personId, personId))
  expect(await auditUniverse(f.db, worldId, timelineId)).toContainEqual(expect.objectContaining({
    code: 'state_projection', version: 0,
  }))
  await f.db.update(personStates).set({ mood: initialState!.mood }).where(eq(personStates.personId, personId))
  await f.db.insert(persons).values({ id: 'untracked-resident', userId: 'owner', name: 'Untracked', modelJson: '{}', createdAt: WORLD_TIME })
  await f.db.insert(worldPersons).values({ worldId, personId: 'untracked-resident', joinedAt: WORLD_TIME })
  await f.db.insert(personStates).values({ personId: 'untracked-resident', timelineId, simTime: initialState!.simTime,
    location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Explore', updatedRealAt: WORLD_TIME })
  expect(await auditUniverse(f.db, worldId, timelineId)).toContainEqual(expect.objectContaining({
    code: 'unproven_state_projection', version: 0,
  }))
  await f.db.delete(personStates).where(eq(personStates.personId, 'untracked-resident'))
  await f.db.delete(worldPersons).where(eq(worldPersons.personId, 'untracked-resident'))
  await f.db.delete(persons).where(eq(persons.id, 'untracked-resident'))

  // ENTER: create an in-world persona and place them in the observed location.
  const personaResponse = await request(`/api/worlds/${worldId}/persona`, 'POST', {
    name: 'Kai', description: 'A visitor who is curious about the town.',
  })
  expect(personaResponse.status).toBe(200)
  const { persona: { id: visitorId } } = await personaResponse.json() as { persona: { id: string } }
  const entered = await request(`/api/worlds/${worldId}/scene/position`, 'POST', {
    timelineId, commandId: 'journey-enter-cafe', expectedVersion: 0, location: 'Cafe',
  })
  expect(entered.status).toBe(200)

  // ACT → FORK: change a world condition, then create a sibling universe from that past.
  const changed = await request(`/api/worlds/${worldId}/actions`, 'POST', {
    id: 'journey-main-weather', timelineId, expectedVersion: 1,
    action: { type: 'environment', location: 'Cafe', condition: 'weather', value: 'storm' },
  })
  expect(changed.status).toBe(200)
  const forkScenario = { whatIf: 'What if the storm clears before dawn?', changedVariable: 'weather after the fork' }
  const missingForkScenario = await request(`/api/worlds/${worldId}/timelines/${timelineId}/fork`, 'POST', { requestId: 'journey-missing-fork-scenario' })
  expect(missingForkScenario.status).toBe(400)
  const forkResponse = await request(`/api/worlds/${worldId}/timelines/${timelineId}/fork`, 'POST', {
    requestId: 'journey-fork', scenario: forkScenario,
  })
  expect(forkResponse.status).toBe(200)
  const { id: branchId } = await forkResponse.json() as { id: string }
  const storedFork = await f.db.select().from(timelines).where(eq(timelines.id, branchId)).get()
  expect(JSON.parse(storedFork!.forkSnapshotJson!).completeDomains).toEqual(expect.arrayContaining([
    'clock', 'states', 'schedules', 'events', 'commitments', 'memories', 'dialogues', 'dialogueTurns',
    'personaMessages', 'knowledge',
  ]))
  expect(JSON.parse(storedFork!.forkScenarioJson!)).toMatchObject({
    ...forkScenario, startTime: expect.any(String), invariants: ['分叉前的共同历史与设定版本保持不变'],
  })
  const replayedFork = await request(`/api/worlds/${worldId}/timelines/${timelineId}/fork`, 'POST', {
    requestId: 'journey-fork', scenario: forkScenario,
  })
  expect(replayedFork.status).toBe(200)
  expect(await replayedFork.json()).toMatchObject({ id: branchId })
  const forkIdReuse = await request(`/api/worlds/${worldId}/timelines/${timelineId}/fork`, 'POST', {
    requestId: 'journey-fork', scenario: { ...forkScenario, changedVariable: 'a different variable' },
  })
  expect(forkIdReuse.status).toBe(409)
  const invalidFork = await request(`/api/worlds/${worldId}/timelines/${timelineId}/fork`, 'POST', {
    requestId: 'journey-invalid-fork', scenario: { whatIf: '   ', changedVariable: '' },
  })
  expect(invalidFork.status).toBe(400)
  expect(await auditUniverse(f.db, worldId, branchId)).toEqual([])

  // The branch makes a different choice; comparison should show the divergent state.
  const branchChange = await request(`/api/worlds/${worldId}/actions`, 'POST', {
    id: 'journey-branch-weather', timelineId: branchId, expectedVersion: 0,
    action: { type: 'environment', location: 'Cafe', condition: 'weather', value: 'clear' },
  })
  expect(branchChange.status).toBe(200)
  expect(await auditUniverse(f.db, worldId, branchId)).toEqual([])
  const comparison = await request(`/api/worlds/${worldId}/compare?left=${timelineId}&right=${branchId}`, 'GET')
  expect(comparison.status).toBe(200)
  expect(await comparison.json()).toMatchObject({
    timeAlignment: 'same_sim_time',
    differences: { facts: [expect.objectContaining({
      key: 'environment:Cafe:weather',
      left: expect.objectContaining({ value: { location: 'Cafe', condition: 'weather', value: 'storm' } }),
      right: expect.objectContaining({ value: { location: 'Cafe', condition: 'weather', value: 'clear' } }),
    })] },
  })

  // RETURN: the original universe remains addressable and retains its own weather.
  const returned = await request(`/api/worlds/${worldId}?timelineId=${timelineId}`, 'GET')
  expect(returned.status).toBe(200)
  const sourceSnapshot = await returned.json() as { currentFacts: { value: { value?: string } }[]; currentTimelineId: string }
  expect(sourceSnapshot.currentTimelineId).toBe(timelineId)
  expect(sourceSnapshot.currentFacts.some(fact => fact.value.value === 'storm')).toBe(true)
  expect(sourceSnapshot.currentFacts.some(fact => fact.value.value === 'clear')).toBe(false)

  // Continue the return journey with a deterministic in-person exchange in the chosen universe.
  vi.stubGlobal('fetch', vi.fn(async () => {
    const lease = await f.db.select().from(sceneRequests).where(eq(sceneRequests.id, 'journey-return-talk')).get()
    expect(lease).toMatchObject({ status: 'pending' })
    expect(lease!.heartbeatAt).toBeGreaterThan(0)
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      utterance: '雨已经落下来了。', thought: '访客注意到了天气。', shouldEnd: true,
      memory: { content: '这位访客担心北路积水。', importance: 6 }, word: '北路积水，请慢慢走。',
      commitment: null, visitorInvitationResponse: null,
    }) } }] }), { headers: { 'Content-Type': 'application/json' } })
  }))
  const conversation = await request(`/api/worlds/${worldId}/scene`, 'POST', {
    timelineId, location: 'Cafe', content: '这场雨什么时候开始的？', requestId: 'journey-return-talk',
  })
  expect(conversation.status).toBe(200)
  const stream = await conversation.text()
  expect(stream).toContain('雨已经落下来了。')
  expect((await f.db.select().from(worldFacts).all()).some(fact => fact.timelineId === timelineId && fact.factType === 'conversation')).toBe(true)
  expect((await f.db.select().from(sceneRequests).where(eq(sceneRequests.id, 'journey-return-talk')).get())?.heartbeatAt)
    .toBeGreaterThan(0)
  expect(await auditUniverse(f.db, worldId, timelineId)).toEqual([])
  const postConversationSnapshot = await buildWorldSnapshot(f.db, worldId, timelineId)
  const nextResidentContext = postConversationSnapshot && await buildEngineContext(f.db, personId, postConversationSnapshot)
  expect(nextResidentContext?.memories.map(memory => memory.content)).toContain('这位访客担心北路积水。')

  const sceneDialogue = (await f.db.select().from(dialogues).where(eq(dialogues.kind, 'scene')).get())!
  await f.db.update(dialogues).set({ location: 'Harbor' }).where(eq(dialogues.id, sceneDialogue.id))
  expect(await auditUniverse(f.db, worldId, timelineId)).toContainEqual(expect.objectContaining({
    code: 'conversation_projection', commandId: 'scene:journey-return-talk',
  }))
  await f.db.update(dialogues).set({ location: sceneDialogue.location }).where(eq(dialogues.id, sceneDialogue.id))

  const visitorTurn = (await f.db.select().from(dialogueTurns).where(eq(dialogueTurns.utterance, '这场雨什么时候开始的？')).get())!
  await f.db.update(dialogueTurns).set({ utterance: 'A transcript edited after the fact.' }).where(eq(dialogueTurns.id, visitorTurn.id))
  expect(await auditUniverse(f.db, worldId, timelineId)).toContainEqual(expect.objectContaining({
    code: 'conversation_projection', commandId: 'scene:journey-return-talk',
  }))
  await f.db.update(dialogueTurns).set({ utterance: '这场雨什么时候开始的？' }).where(eq(dialogueTurns.id, visitorTurn.id))
  expect(await auditUniverse(f.db, worldId, timelineId)).toEqual([])

  const relationMemory = (await f.db.select().from(memories).where(eq(memories.content, '这位访客担心北路积水。')).get())!
  await f.db.update(memories).set({ content: '一条被篡改的记忆。' }).where(eq(memories.id, relationMemory.id))
  expect(await auditUniverse(f.db, worldId, timelineId)).toContainEqual(expect.objectContaining({
    code: 'memory_projection', commandId: 'scene:journey-return-talk',
  }))
  await f.db.update(memories).set({ content: relationMemory.content }).where(eq(memories.id, relationMemory.id))

  const personaMessage = (await f.db.select().from(personaMessages).where(eq(personaMessages.recipientPersonId, visitorId)).get())!
  await f.db.update(personaMessages).set({ content: '一条被篡改的留言。' }).where(eq(personaMessages.id, personaMessage.id))
  expect(await auditUniverse(f.db, worldId, timelineId)).toContainEqual(expect.objectContaining({
    code: 'persona_message_projection', commandId: 'scene:journey-return-talk',
  }))
  await f.db.update(personaMessages).set({ content: personaMessage.content }).where(eq(personaMessages.id, personaMessage.id))

  await f.db.insert(events).values({ id: 'uncommanded-event', timelineId, simTime: WORLD_TIME,
    title: 'An untracked event', description: 'No accepted command supports this event.', kind: 'action' })
  expect(await auditUniverse(f.db, worldId, timelineId)).toContainEqual(expect.objectContaining({
    code: 'unproven_event_projection',
  }))
})

it('rolls back person and world creation if the immutable baseline cannot be written', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
  const request = (path: string, method: string, body?: unknown) => app.request(path, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, f.env)
  const count = (table: string) => Number(f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)
  const rejectRevision = () => f.sqlite.exec("CREATE TRIGGER reject_universe_baseline BEFORE INSERT ON universe_revisions BEGIN SELECT RAISE(ABORT, 'forced baseline failure'); END")

  rejectRevision()
  expect((await request('/api/persons', 'POST', { name: 'Atomic Person', model: {} })).status).toBe(500)
  expect(count('persons')).toBe(0)
  expect(count('world_model_versions')).toBe(0)
  expect(count('worlds')).toBe(2) // only the fixture's preexisting worlds remain
  expect(count('timelines')).toBe(2)

  f.sqlite.exec('DROP TRIGGER reject_universe_baseline')
  const person = await request('/api/persons', 'POST', { name: 'Atomic Person', model: {} })
  expect(person.status).toBe(200)
  const personId = (await person.json() as { id: string }).id
  f.sqlite.exec("CREATE TRIGGER reject_universe_baseline BEFORE INSERT ON universe_revisions BEGIN SELECT RAISE(ABORT, 'forced baseline failure'); END")
  expect((await request('/api/worlds', 'POST', {
    name: 'Atomic Universe', description: 'Must not be half-created', personIds: [personId],
    locations: ['Cafe', 'Harbor', 'Market', 'Library', 'Square'].map(name => ({ name, description: '' })),
  })).status).toBe(500)
  expect(count('worlds')).toBe(3) // the person's default world remains; failed new world is absent
  expect(count('timelines')).toBe(3)
  expect(count('world_model_versions')).toBe(1)
  expect(count('world_persons')).toBe(1)
})
