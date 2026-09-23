import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { persons, personStates, schedules, timelines, universeRevisions, worldCommands, worldFacts, worldPersons, worlds } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from './world-fixture'
import { buildEngineContext, buildWorldSnapshot } from '../agent/engine-context'
import { readWorldState } from '../world-state/query'
import { runTick } from '../engine/tick'
import { auditUniverse } from '../world-state/invariants'
import { advanceWorldClock } from '../world-state/system'

type Fixture = Awaited<ReturnType<typeof createWorldFixture>>
let fixture: Fixture | null = null
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); fixture?.close(); fixture = null })

it('recreates the same small-world seed with stable world, timeline, and location identifiers', async () => {
  fixture = await createWorldFixture()
  await addBaselineResidents(fixture)
  const first = await describeFixture(fixture)
  fixture.close()
  fixture = await createWorldFixture()
  await addBaselineResidents(fixture)
  expect(await describeFixture(fixture)).toEqual(first)
})

async function addBaselineResidents(f: Fixture) {
  await f.db.insert(persons).values([
    { id: 'baseline-resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME },
    { id: 'baseline-visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME },
  ])
  await f.db.insert(worldPersons).values(['baseline-resident', 'baseline-visitor'].map(personId => ({
    worldId: 'home-world', personId, joinedAt: WORLD_TIME,
  })))
}

async function describeFixture(f: Fixture) {
  const [worldRows, timelineRows, residentRows] = await Promise.all([
    f.db.select({ id: worlds.id, name: worlds.name, locationsJson: worlds.locationsJson }).from(worlds).orderBy(worlds.id).all(),
    f.db.select({ id: timelines.id, worldId: timelines.worldId, simNow: timelines.simNow }).from(timelines).orderBy(timelines.id).all(),
    f.db.select({ worldId: worldPersons.worldId, personId: worldPersons.personId, joinedAt: worldPersons.joinedAt })
      .from(worldPersons).orderBy(worldPersons.worldId, worldPersons.personId).all(),
  ])
  return { worlds: worldRows, timelines: timelineRows, residents: residentRows }
}

it('completes a structured full-day journey, forks, and keeps later root/child changes isolated', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  await f.db.update(worlds).set({ status: 'paused' }).where(eq(worlds.id, 'home-world'))
  vi.useFakeTimers()
  const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
  const request = (path: string, method: string, body?: unknown) => app.request(path, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, f.env)
  const personResponse = await request('/api/persons', 'POST', { name: 'Day Resident', model: { identity: ['A local reader'] } })
  expect(personResponse.status).toBe(200)
  const { id: personId } = await personResponse.json() as { id: string }
  const createResponse = await request('/api/worlds', 'POST', { name: 'Full Day Town', description: 'A fixed daily journey.', personIds: [personId],
    locations: ['Cafe', 'Harbor', 'Market', 'Library', 'Square'].map(name => ({ name, description: '' })) })
  expect(createResponse.status).toBe(200)
  const { id: worldId, timelineId } = await createResponse.json() as { id: string; timelineId: string }
  const journeyStart = (await f.db.select().from(timelines).where(eq(timelines.id, timelineId)).get())!.simNow

  const scheduleItems = [
    { start: '00:00', end: '08:00', location: 'Cafe', activity: 'Resting', kind: 'sleep' as const },
    { start: '08:00', end: '09:00', location: 'Library', activity: 'Researching' },
    { start: '09:00', end: '12:00', location: 'Cafe', activity: 'Reading' },
    { start: '12:00', end: '13:00', location: 'Library', activity: 'Having lunch' },
    { start: '13:00', end: '17:00', location: 'Cafe', activity: 'Working' },
    { start: '17:00', end: '20:00', location: 'Library', activity: 'Researching' },
    { start: '20:00', end: '00:00', location: 'Cafe', activity: 'Sleeping', kind: 'sleep' as const },
  ]
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
    const prompt = body.messages.map(message => message.content).join('\n')
    const content = prompt.includes('安排今日日程')
      ? JSON.stringify({ items: scheduleItems })
      : JSON.stringify({ events: [], thought: 'A quiet fixed day.', memory: null,
        nextLocation: null, nextActivity: null, mood: null, goal: null })
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))

  const realAnchor = Date.now()
  await f.db.update(timelines).set({ lastRealTickAt: new Date(realAnchor).toISOString() }).where(eq(timelines.id, timelineId))
  for (let tick = 1; tick <= 16; tick++) {
    vi.setSystemTime(realAnchor + tick * 15_000)
    const result = await runTick({ ...f.env, WORLD_SPEED: '360', DIRECTOR_LLM: '0' }, f.db)
    const timeline = result?.worlds.find(world => world.id === worldId)?.timelines.find(item => item.id === timelineId)
    expect(Date.parse(timeline?.simNow ?? '') - Date.parse(journeyStart)).toBe(tick * 90 * 60_000)
    expect(await auditUniverse(f.db, worldId, timelineId)).toEqual([])
  }

  const rootFactsAtFork = await f.db.select().from(worldFacts).where(eq(worldFacts.timelineId, timelineId)).all()
  expect(Date.parse(rootFactsAtFork.at(-1)?.simTime ?? journeyStart) - Date.parse(journeyStart)).toBeGreaterThanOrEqual(24 * 60 * 60_000)
  const forkResponse = await request(`/api/worlds/${worldId}/timelines/${timelineId}/fork`, 'POST', {
    requestId: 'full-day-child', scenario: { whatIf: 'A different evening', changedVariable: 'evening weather' },
  })
  expect(forkResponse.status).toBe(200)
  const { id: childId } = await forkResponse.json() as { id: string }
  expect(await auditUniverse(f.db, worldId, childId)).toEqual([])

  const rootRevision = (await f.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timelineId)).get())!
  const rootChange = await request(`/api/worlds/${worldId}/actions`, 'POST', { id: 'after-fork-root-weather', timelineId,
    expectedVersion: rootRevision.version, action: { type: 'environment', location: 'Cafe', condition: 'weather', value: 'rain' } })
  expect(rootChange.status).toBe(200)
  const rootAfterChange = await f.db.select().from(worldFacts).where(eq(worldFacts.timelineId, timelineId)).all()
  const rootProjectionAtFork = await f.db.select().from(personStates).where(eq(personStates.timelineId, timelineId)).all()
  const childChange = await request(`/api/worlds/${worldId}/actions`, 'POST', { id: 'child-weather', timelineId: childId,
    expectedVersion: 0, action: { type: 'environment', location: 'Cafe', condition: 'weather', value: 'clear' } })
  expect(childChange.status).toBe(200)
  const grandchildResponse = await request(`/api/worlds/${worldId}/timelines/${childId}/fork`, 'POST', {
    requestId: 'full-day-grandchild', scenario: { whatIf: 'A different morning', changedVariable: 'morning weather' },
  })
  expect(grandchildResponse.status).toBe(200)
  const { id: grandchildId } = await grandchildResponse.json() as { id: string }
  expect(await auditUniverse(f.db, worldId, grandchildId)).toEqual([])
  const laterChildChange = await request(`/api/worlds/${worldId}/actions`, 'POST', { id: 'later-child-weather', timelineId: childId,
    expectedVersion: 1, action: { type: 'environment', location: 'Cafe', condition: 'weather', value: 'fog' } })
  expect(laterChildChange.status).toBe(200)
  expect(await f.db.select().from(worldFacts).where(eq(worldFacts.timelineId, timelineId)).all()).toEqual(rootAfterChange)
  expect(await f.db.select().from(personStates).where(eq(personStates.timelineId, timelineId)).all()).toEqual(rootProjectionAtFork)
  const childState = await readWorldState(f.db, worldId, childId)
  const grandchildState = await readWorldState(f.db, worldId, grandchildId)
  expect(childState?.current.filter(fact => fact.factType === 'environment')
    .map(fact => (fact.value as Record<string, unknown>).value)).toEqual(['fog'])
  expect(grandchildState?.current.filter(fact => fact.factType === 'environment')
    .map(fact => (fact.value as Record<string, unknown>).value)).toEqual(['clear'])
  expect(await auditUniverse(f.db, worldId, timelineId)).toEqual([])
  expect(await auditUniverse(f.db, worldId, childId)).toEqual([])
  expect(await auditUniverse(f.db, worldId, grandchildId)).toEqual([])
})

/** A deterministic slice: enter -> fork -> change a condition -> inform one resident -> compare. */
describe('small world journey without an LLM', () => {
  it('delivers a child-line message into only the intended recipient knowledge', async () => {
    fixture = await createWorldFixture()
    const f = fixture
    const modelJson = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] })
    await f.db.insert(persons).values([
      { id: 'ada', userId: 'owner', name: 'Ada', modelJson, createdAt: WORLD_TIME },
      { id: 'bo', userId: 'owner', name: 'Bo', modelJson, createdAt: WORLD_TIME },
      { id: 'visitor', userId: 'owner', name: 'Visitor', modelJson, isUser: true, createdAt: WORLD_TIME },
    ])
    await f.db.insert(worldPersons).values(['ada', 'bo', 'visitor'].map(personId => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
    await f.db.insert(personStates).values(['ada', 'bo'].map(personId => ({ personId, timelineId: 'home-main', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', lastBeatSimTime: WORLD_TIME, updatedRealAt: WORLD_TIME })))
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers, body: JSON.stringify(body) }, f.env)
    const fork = async (requestId: string) => {
      const response = await post('/api/worlds/home-world/timelines/home-main/fork', {
        requestId, scenario: { whatIf: `Message branch ${requestId}`, changedVariable: 'message delivery' },
      })
      expect(response.status).toBe(200)
      return (await response.json() as { id: string }).id
    }
    const childId = await fork('message-child')
    const siblingId = await fork('message-sibling')
    const visitorEnters = await post('/api/worlds/home-world/scene/position', {
      timelineId: childId, commandId: 'message-child-visitor-enters', expectedVersion: 0, location: 'Cafe',
    })
    expect(visitorEnters.status).toBe(200)
    const delivery = await post('/api/worlds/home-world/scene/inform', { timelineId: childId, recipientId: 'ada', topic: 'road warning',
      content: 'The north road is flooded.', commandId: 'message-child-delivery', expectedVersion: 1 })
    expect(delivery.status, await delivery.clone().text()).toBe(200)
    const receipt = await delivery.json() as { factId: string; version: number; certainty: string }
    expect(receipt).toMatchObject({ version: 2, certainty: 'rumor', factId: expect.any(String) })
    expect(await f.db.select().from(worldFacts).where(eq(worldFacts.id, receipt.factId)).get()).toMatchObject({
      timelineId: childId, version: 2, factType: 'knowledge', subjectId: 'ada:road warning',
    })

    const knownFacts = async (personId: string, timelineId: string) => {
      const snapshot = (await buildWorldSnapshot(f.db, 'home-world', timelineId))!
      return (await buildEngineContext(f.db, personId, snapshot))?.knownFacts ?? []
    }
    const [adaChild, boChild, adaRoot, adaSibling] = await Promise.all([
      knownFacts('ada', childId), knownFacts('bo', childId), knownFacts('ada', 'home-main'), knownFacts('ada', siblingId),
    ])
    expect(adaChild).toEqual([expect.objectContaining({
      kind: 'knowledge', certainty: 'rumor', text: expect.stringContaining('The north road is flooded.'), sourceFactId: receipt.factId,
    })])
    expect(boChild).toEqual([])
    expect(adaRoot).toEqual([])
    expect(adaSibling).toEqual([])
    expect(await auditUniverse(f.db, 'home-world', 'home-main')).toEqual([])
    expect(await auditUniverse(f.db, 'home-world', childId)).toEqual([])
    expect(await auditUniverse(f.db, 'home-world', siblingId)).toEqual([])
    const comparison = await (await app.request(`/api/worlds/home-world/compare?left=home-main&right=${childId}`, { headers }, f.env)).json() as {
      differences: { facts: { key: string; right: { factId: string; version: number } | null }[] }
    }
    expect(comparison.differences.facts).toContainEqual(expect.objectContaining({
      key: 'knowledge:ada:road warning', right: expect.objectContaining({ factId: receipt.factId, version: 2 }),
    }))
  })

  it('keeps branch knowledge private and rejects unsafe actions without partial writes', async () => {
    fixture = await createWorldFixture()
    const f = fixture
    await f.db.insert(persons).values([
      { id: 'ada', userId: 'owner', name: 'Ada', modelJson: '{}', createdAt: WORLD_TIME },
      { id: 'bo', userId: 'owner', name: 'Bo', modelJson: '{}', createdAt: WORLD_TIME },
      { id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME },
    ])
    await f.db.insert(worldPersons).values(['ada', 'bo', 'visitor'].map(personId => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
    await f.db.insert(personStates).values(['ada', 'bo'].map(personId => ({ personId, timelineId: 'home-main', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })))
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers, body: JSON.stringify(body) }, f.env)
    const get = (path: string) => app.request(path, { headers }, f.env)

    const entered = await post('/api/worlds/home-world/scene/position', { timelineId: 'home-main', commandId: 'visitor-enters', expectedVersion: 0, location: 'Cafe' })
    expect(entered.status).toBe(200)
    const forkScenario = { whatIf: 'What if the storm never reaches the town?', changedVariable: 'storm arrival' }
    const forkResponse = await post('/api/worlds/home-world/timelines/home-main/fork', {
      requestId: 'child-fork', scenario: forkScenario,
    })
    expect(forkResponse.status).toBe(200)
    const childId = (await forkResponse.json() as { id: string }).id
    const childTimeline = await f.db.select().from(timelines).where(eq(timelines.id, childId)).get()
    expect(JSON.parse(childTimeline!.forkScenarioJson!)).toMatchObject(forkScenario)

    const condition = await post('/api/worlds/home-world/actions', { id: 'main-weather', timelineId: 'home-main', expectedVersion: 1,
      action: { type: 'environment', location: 'Cafe', condition: 'weather', value: 'storm' } })
    expect(condition.status).toBe(200)
    const sourceFactId = (await condition.json() as { factId: string }).factId
    const informed = await post('/api/worlds/home-world/scene/inform', { commandId: 'child-message', timelineId: childId, expectedVersion: 0,
      recipientId: 'ada', topic: 'storm', content: 'The storm has begun' })
    expect(informed.status).toBe(200)
    expect(await informed.json()).toMatchObject({ version: 1, certainty: 'rumor' })
    const rejected = await post('/api/worlds/home-world/actions', { id: 'wrong-source', timelineId: childId, expectedVersion: 1,
      action: { type: 'inform', recipientId: 'bo', topic: 'storm', content: 'The storm has begun', sourceFactId } })
    expect(rejected.status).toBe(400)
    const changedChild = await post('/api/worlds/home-world/actions', { id: 'child-weather', timelineId: childId, expectedVersion: 1,
      action: { type: 'environment', location: 'Cafe', condition: 'weather', value: 'clear' } })
    expect(changedChild.status).toBe(200)

    const main = await (await get('/api/worlds/home-world/state?timelineId=home-main')).json() as { version: number; current: { factType: string; value: { recipientId?: string; certainty?: string } }[] }
    const child = await (await get(`/api/worlds/home-world/state?timelineId=${childId}`)).json() as typeof main
    expect(main.version).toBe(2)
    expect(child.version).toBe(2)
    expect(main.current.some(f => f.factType === 'knowledge')).toBe(false)
    expect(child.current.find(f => f.factType === 'knowledge')?.value).toMatchObject({ recipientId: 'ada', certainty: 'rumor' })
    const comparison = await (await get(`/api/worlds/home-world/compare?left=home-main&right=${childId}`)).json() as { timeAlignment: string; differences: { facts: { key: string }[] } }
    expect(comparison.timeAlignment).toBe('same_sim_time')
    expect(comparison.differences.facts.map(f => f.key)).toContain('knowledge:ada:storm')
    expect(await get('/api/worlds/other-world/state?timelineId=other-main')).toMatchObject({ status: 404 })
  })

  it('lets an informed resident use the message in a later engine decision and versioned world change', async () => {
    fixture = await createWorldFixture()
    const f = fixture
    const modelJson = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] })
    await f.db.insert(persons).values([
      { id: 'ada', userId: 'owner', name: 'Ada', modelJson, createdAt: WORLD_TIME },
      { id: 'visitor', userId: 'owner', name: 'Visitor', modelJson, isUser: true, createdAt: WORLD_TIME },
    ])
    await f.db.insert(worldPersons).values(['ada', 'visitor'].map(personId => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
    await f.db.insert(personStates).values(['ada', 'visitor'].map(personId => ({ personId, timelineId: 'home-main', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', lastBeatSimTime: WORLD_TIME, updatedRealAt: WORLD_TIME })))
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const informed = await app.request('/api/worlds/home-world/scene/inform', { method: 'POST', headers,
      body: JSON.stringify({ timelineId: 'home-main', recipientId: 'ada', topic: 'storm warning', content: 'The north road is flooded.', commandId: 'journey-inform', expectedVersion: 0 }),
    }, f.env)
    expect(informed.status).toBe(200)
    expect(await informed.json()).toMatchObject({ version: 1, certainty: 'rumor' })

    const snapshot = (await buildWorldSnapshot(f.db, 'home-world', 'home-main'))!
    const context = (await buildEngineContext(f.db, 'ada', snapshot))!
    expect(context.knownFacts).toEqual([expect.objectContaining({
      kind: 'knowledge', certainty: 'rumor', text: expect.stringContaining('The north road is flooded'),
      sourceFactId: expect.any(String),
    })])
    const schedule = [
      { start: '00:00', end: '08:01', location: 'Cafe', activity: 'Reading' },
      { start: '08:01', end: '09:00', location: 'Cafe', activity: 'Breakfast' },
      { start: '09:00', end: '12:00', location: 'Cafe', activity: 'Monitoring' },
      { start: '12:00', end: '13:00', location: 'Cafe', activity: 'Lunch' },
      { start: '13:00', end: '17:00', location: 'Cafe', activity: 'Listening' },
      { start: '17:00', end: '00:00', location: 'Cafe', activity: 'Resting' },
    ]
    await f.db.insert(schedules).values({ personId: 'ada', timelineId: 'home-main', worldDate: WORLD_TIME.slice(0, 10),
      itemsJson: JSON.stringify(schedule), generatedAt: WORLD_TIME })
    const realAnchor = Date.now()
    await f.db.update(timelines).set({ lastRealTickAt: new Date(realAnchor).toISOString() }).where(eq(timelines.id, 'home-main'))
    vi.useFakeTimers()
    vi.setSystemTime(realAnchor + 15_000)
    await advanceWorldClock(f.db, { worldId: 'home-world', timelineId: 'home-main',
      observedAt: new Date(realAnchor + 10_000), worldSpeed: 6, maxElapsedSeconds: 150 })
    const leftAfterExchange = await app.request('/api/worlds/home-world/scene/position', { method: 'POST', headers,
      body: JSON.stringify({ timelineId: 'home-main', location: 'Library', commandId: 'visitor-leaves', expectedVersion: 2 }),
    }, f.env)
    expect(leftAfterExchange.status).toBe(200)
    vi.setSystemTime(realAnchor + 15_000) // 30 further virtual seconds; Ada's 08:01 schedule boundary is behind us.
    let sentPrompt = ''
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
      sentPrompt = request.messages.map(message => message.content).join('\n')
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        events: [{ title: 'Warns the neighbors', description: 'Ada decides to warn the others about the flooded north road.', offsetMin: 1 }],
        thought: 'I should warn the others about the flooded north road.',
        memory: { content: 'I heard the north road is flooded and decided to warn the others.', type: 'timeline', importance: 6 },
        nextLocation: null, nextActivity: null, mood: null, goal: 'Warn the others about the flooded north road',
      }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    const report = await runTick({ ...f.env, WORLD_SPEED: '6', DIRECTOR_LLM: '0', TICK_CALL_CAP: '8', DAILY_CALL_CAP: '20' }, f.db)
    expect(report?.worlds.find(world => world.id === 'home-world')?.timelines[0]?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'beat', personId: 'ada', ok: true }),
    ]))
    expect(sentPrompt).toContain('The north road is flooded.')
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    expect((await f.db.select().from(personStates).where(eq(personStates.personId, 'ada')).get())?.goal)
      .toBe('Warn the others about the flooded north road')
    expect(await f.db.select().from(worldCommands).all()).toHaveLength(6) // inform, two clock advances, visitor movement, schedule, resident decision
    expect((await f.db.select().from(worldFacts).all()).map(fact => fact.factType)).toEqual([
      'knowledge', 'clock', 'location', 'clock', 'resident_state', 'resident_state',
    ])
    expect((await f.db.select().from(worldFacts).orderBy(worldFacts.version).all()).map(fact => fact.version)).toEqual([1, 2, 3, 4, 5, 6])
    expect(await auditUniverse(f.db, 'home-world', 'home-main')).toEqual([])
  })

  it('rejects in-person messages to sleeping or busy residents without advancing the world', async () => {
    fixture = await createWorldFixture()
    const f = fixture
    await f.db.insert(persons).values([
      { id: 'ada', userId: 'owner', name: 'Ada', modelJson: '{}', createdAt: WORLD_TIME },
      { id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME },
    ])
    await f.db.insert(worldPersons).values(['ada', 'visitor'].map(personId => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
    await f.db.insert(personStates).values(['ada', 'visitor'].map(personId => ({ personId, timelineId: 'home-main', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })))
    await f.db.insert(schedules).values({ personId: 'ada', timelineId: 'home-main', worldDate: WORLD_TIME.slice(0, 10),
      itemsJson: JSON.stringify([{ start: '08:00', end: '09:00', location: 'Cafe', activity: 'Sleeping', kind: 'sleep' }]), generatedAt: WORLD_TIME })
    const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const send = (id: string) => app.request('/api/worlds/home-world/scene/inform', { method: 'POST', headers,
      body: JSON.stringify({ timelineId: 'home-main', recipientId: 'ada', topic: 'letter', content: 'A letter arrived', commandId: id, expectedVersion: 0 }),
    }, f.env)

    expect((await send('sleeping-message')).status).toBe(409)
    await f.db.delete(schedules).where(eq(schedules.personId, 'ada'))
    await f.db.update(personStates).set({ currentDialogueId: 'another-scene' }).where(eq(personStates.personId, 'ada'))
    expect((await send('busy-message')).status).toBe(409)
    expect(await f.db.select().from(worldCommands).all()).toHaveLength(0)
    expect(await f.db.select().from(worldFacts).all()).toHaveLength(0)
    expect(await f.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get()).toBeUndefined()

    await f.db.update(personStates).set({ currentDialogueId: null }).where(eq(personStates.personId, 'ada'))
    expect((await send('awake-message')).status).toBe(200)
    expect(await f.db.select().from(worldCommands).all()).toHaveLength(1)
    expect(await f.db.select().from(worldFacts).all()).toHaveLength(1)
    expect((await f.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())?.version).toBe(1)
  })
})
