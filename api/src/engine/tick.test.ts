import { afterEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { persons, personStates, schedules, timelines, universeRevisions, worldFacts, worldModelVersions, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { auditUniverse } from '../world-state/invariants'
import app from '../index'
import { runTick } from './tick'
import { acquireEngineTickLease, releaseEngineTickLease } from './tick-lease'
import { createRootProjectionBaseline } from '../world-state/model'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => {
  vi.useRealTimers()
  fixture?.close()
  fixture = null
})

it('applies a crossed schedule transition once across consecutive ticks', async () => {
  fixture = await createWorldFixture()
  const realAnchor = new Date()
  const firstTick = new Date(realAnchor.getTime() + 15_000)
  vi.useFakeTimers()
  vi.setSystemTime(firstTick)
  await fixture.db.update(timelines).set({ lastRealTickAt: realAnchor.toISOString() }).where(eq(timelines.id, 'home-main'))
  await fixture.db.insert(persons).values({ id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'visitor', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ personId: 'visitor', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Explore', lastBeatSimTime: WORLD_TIME,
    updatedRealAt: WORLD_TIME })
  await fixture.db.insert(schedules).values({ personId: 'visitor', timelineId: 'home-main', worldDate: WORLD_TIME.slice(0, 10),
    generatedAt: WORLD_TIME, itemsJson: JSON.stringify([
      { start: '00:00', end: '08:01', location: 'Cafe', activity: 'Reading' },
      { start: '08:01', end: '12:00', location: 'Library', activity: 'Researching' },
      { start: '12:00', end: '13:00', location: 'Cafe', activity: 'Having lunch' },
      { start: '13:00', end: '17:00', location: 'Library', activity: 'Researching' },
      { start: '17:00', end: '20:00', location: 'Cafe', activity: 'Relaxing' },
      { start: '20:00', end: '00:00', location: 'Cafe', activity: 'Sleeping', kind: 'sleep' },
    ]) })
  const env = { ...fixture.env, WORLD_SPEED: '6', DIRECTOR_LLM: '0' }

  const first = await runTick(env, fixture.db)
  expect(first?.worlds[0]?.timelines[0]?.simNow).toBe('2026-09-21T08:01:30.000Z')
  expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'visitor')).get()))
    .toMatchObject({ location: 'Library', activity: 'Researching' })
  const scheduleFacts = (await fixture.db.select().from(worldFacts).all())
    .filter(fact => JSON.parse(fact.valueJson).cause === 'schedule')
  expect(scheduleFacts).toHaveLength(1)

  vi.setSystemTime(new Date(realAnchor.getTime() + 30_000))
  await runTick(env, fixture.db)
  expect((await fixture.db.select().from(worldFacts).all()).filter(fact => JSON.parse(fact.valueJson).cause === 'schedule')).toHaveLength(1)
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
})

it('keeps a resident at one location per virtual instant across repeated schedule and beat ticks', async () => {
  fixture = await createWorldFixture()
  const realAnchor = new Date()
  vi.useFakeTimers()
  await fixture.db.update(timelines).set({ lastRealTickAt: realAnchor.toISOString() }).where(eq(timelines.id, 'home-main'))
  const emptyModel = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] })
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: emptyModel, createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Explore', lastBeatSimTime: WORLD_TIME,
    updatedRealAt: WORLD_TIME })
  await fixture.db.insert(schedules).values({ personId: 'resident', timelineId: 'home-main', worldDate: WORLD_TIME.slice(0, 10),
    generatedAt: WORLD_TIME, itemsJson: JSON.stringify([
      { start: '00:00', end: '09:00', location: 'Cafe', activity: 'Reading' },
      { start: '09:00', end: '11:00', location: 'Library', activity: 'Researching' },
      { start: '11:00', end: '14:00', location: 'Cafe', activity: 'Having lunch' },
      { start: '14:00', end: '17:00', location: 'Library', activity: 'Researching' },
      { start: '17:00', end: '20:00', location: 'Cafe', activity: 'Relaxing' },
      { start: '20:00', end: '00:00', location: 'Cafe', activity: 'Sleeping', kind: 'sleep' },
    ]) })
  const modelFetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    events: [{ title: 'Read a page', description: 'The resident spends time with a book.', offsetMin: 10 }],
    thought: 'The book is absorbing.', memory: null, nextLocation: null, nextActivity: null, mood: null, goal: null,
  }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', modelFetch)
  const env = { ...fixture.env, WORLD_SPEED: '360', DIRECTOR_LLM: '0' }

  for (let tick = 1; tick <= 7; tick++) {
    vi.setSystemTime(new Date(realAnchor.getTime() + tick * 15_000))
    const result = await runTick(env, fixture.db)
    expect(result?.worlds[0]?.timelines[0]?.steps.some(step => step.kind === 'beat' && step.ok), JSON.stringify({ tick, timeline: result?.worlds[0]?.timelines[0] }))
      .toBe(tick === 1 || tick === 2 || tick === 4 || tick === 6)
  }

  const locationFacts = (await fixture.db.select().from(worldFacts).where(eq(worldFacts.factType, 'location')).all())
    .filter(fact => fact.subjectId === 'resident')
  expect(locationFacts.map(fact => JSON.parse(fact.valueJson).changes.location)).toEqual(['Library', 'Cafe', 'Library', 'Cafe'])
  expect(new Set(locationFacts.map(fact => fact.simTime)).size).toBe(locationFacts.length)
  expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'resident')).get())?.location).toBe('Cafe')
  expect(modelFetch).toHaveBeenCalledTimes(4)
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
})

it('advances an accelerated fixed world through a full simulated day and audits each tick', async () => {
  fixture = await createWorldFixture()
  const realAnchor = new Date()
  vi.useFakeTimers()
  await fixture.db.update(timelines).set({ lastRealTickAt: realAnchor.toISOString() }).where(eq(timelines.id, 'home-main'))
  await fixture.db.insert(persons).values({ id: 'day-resident', userId: 'owner', name: 'Day Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'day-resident', joinedAt: WORLD_TIME })
  const initialState = { personId: 'day-resident', timelineId: 'home-main', simTime: WORLD_TIME, location: 'Cafe',
    activity: 'Reading', mood: 'Calm', goal: 'Explore', currentDialogueId: null, lastBeatSimTime: null, updatedRealAt: WORLD_TIME }
  await fixture.db.insert(personStates).values(initialState)
  const daySchedule = JSON.stringify([
    { start: '00:00', end: '08:00', location: 'Cafe', activity: 'Sleeping', kind: 'sleep' },
    { start: '08:00', end: '09:00', location: 'Library', activity: 'Researching' },
    { start: '09:00', end: '12:00', location: 'Cafe', activity: 'Reading' },
    { start: '12:00', end: '13:00', location: 'Library', activity: 'Having lunch' },
    { start: '13:00', end: '17:00', location: 'Cafe', activity: 'Working' },
    { start: '17:00', end: '20:00', location: 'Library', activity: 'Researching' },
    { start: '20:00', end: '00:00', location: 'Cafe', activity: 'Resting' },
  ])
  const initialSchedules = ['2026-09-21', '2026-09-22'].map(worldDate => ({
    personId: 'day-resident', timelineId: 'home-main', worldDate, itemsJson: daySchedule, generatedAt: WORLD_TIME,
  }))
  await fixture.db.insert(schedules).values(initialSchedules)
  const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [initialState])
  baseline.rows.schedules = initialSchedules
  await fixture.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
    modelJson: JSON.stringify({ name: 'Home world', description: 'A small town', locations: [], residents: [],
      initialStates: { capturedAt: WORLD_TIME, states: [initialState] }, initialEvents: { timelineId: 'home-main', eventIds: [] },
      projectionBaseline: baseline }) })
  await fixture.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME,
    worldModelVersion: 1, updatedAt: WORLD_TIME })

  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    events: [], thought: 'A quiet stretch of the day.', memory: null,
    nextLocation: null, nextActivity: null, mood: null, goal: null,
  }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  const env = { ...fixture.env, WORLD_SPEED: '360', DIRECTOR_LLM: '0' }
  for (let tick = 1; tick <= 16; tick++) {
    vi.setSystemTime(new Date(realAnchor.getTime() + tick * 15_000))
    const result = await runTick(env, fixture.db)
    const simNow = result?.worlds[0]?.timelines[0]?.simNow
    expect(Date.parse(simNow ?? '') - Date.parse(WORLD_TIME)).toBe(tick * 90 * 60_000)
    const revision = await fixture.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get()
    expect(revision?.simTime).toBe(simNow)
    expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
  }

  const scheduleFacts = (await fixture.db.select().from(worldFacts).all())
    .filter(fact => JSON.parse(fact.valueJson).cause === 'schedule')
  expect(Date.parse((await fixture.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())!.simNow)
    - Date.parse(WORLD_TIME)).toBeGreaterThanOrEqual(24 * 60 * 60_000)
  expect(scheduleFacts.length).toBeGreaterThanOrEqual(3)
  expect(new Set(scheduleFacts.map(fact => fact.simTime)).size).toBe(scheduleFacts.length)
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
})

it('rejects an overlapping engine HTTP tick while the active tick finishes once', async () => {
  fixture = await createWorldFixture()
  const realAnchor = new Date()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(realAnchor.getTime() + 15_000))
  await fixture.db.update(timelines).set({ lastRealTickAt: realAnchor.toISOString() }).where(eq(timelines.id, 'home-main'))
  const model = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] })
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: model, createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Explore', lastBeatSimTime: WORLD_TIME,
    updatedRealAt: WORLD_TIME })
  await fixture.db.insert(schedules).values({ personId: 'resident', timelineId: 'home-main', worldDate: WORLD_TIME.slice(0, 10),
    generatedAt: WORLD_TIME, itemsJson: JSON.stringify([
      { start: '00:00', end: '08:01', location: 'Cafe', activity: 'Reading' },
      { start: '08:01', end: '09:00', location: 'Library', activity: 'Researching' },
      { start: '09:00', end: '12:00', location: 'Cafe', activity: 'Working' },
      { start: '12:00', end: '13:00', location: 'Cafe', activity: 'Lunch' },
      { start: '13:00', end: '17:00', location: 'Library', activity: 'Researching' },
      { start: '17:00', end: '00:00', location: 'Cafe', activity: 'Resting' },
    ]) })

  let signalModelStarted!: () => void
  let finishModel!: (response: Response) => void
  const modelStarted = new Promise<void>(resolve => { signalModelStarted = resolve })
  const modelFetch = vi.fn(() => new Promise<Response>(resolve => {
    finishModel = resolve
    signalModelStarted()
  }))
  vi.stubGlobal('fetch', modelFetch)
  const env = { ...fixture.env, ENGINE_TICK_SECRET: 'engine-secret', WORLD_SPEED: '6', DIRECTOR_LLM: '0' }
  const callTick = () => app.request('/api/engine/tick', { method: 'POST', headers: { 'x-engine-secret': 'engine-secret' } }, env)
  const firstRun = callTick()
  await modelStarted
  expect((await callTick()).status).toBe(409)
  finishModel(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    events: [{ title: 'Begins research', description: 'The resident opens a reference book.', offsetMin: 1 }],
    thought: 'I should begin with the old records.', memory: null,
    nextLocation: null, nextActivity: null, mood: null, goal: 'Research the old records',
  }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

  const response = await firstRun
  expect(response.status).toBe(200)
  const report = await response.json() as Awaited<ReturnType<typeof runTick>>
  expect(modelFetch).toHaveBeenCalledTimes(1)
  expect(report?.worlds[0]?.timelines[0]?.simNow).toBe('2026-09-21T08:01:30.000Z')
  expect(report?.worlds[0]?.timelines[0]?.steps.filter(step => step.kind === 'beat')).toHaveLength(1)
  expect((await fixture.db.select().from(worldFacts).all()).map(fact => fact.version)).toEqual([1, 2, 3])
  expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'resident')).get())?.goal)
    .toBe('Research the old records')
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
})

it('returns 409 without side effects when another Worker owns the D1 tick lease', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  const ownerToken = crypto.randomUUID()
  expect(await acquireEngineTickLease(f.db, ownerToken)).toBe(true)
  const response = await app.request('/api/engine/tick', { method: 'POST',
    headers: { 'x-engine-secret': 'engine-secret' } }, { ...f.env, ENGINE_TICK_SECRET: 'engine-secret' })
  expect(response.status).toBe(409)
  expect(await f.db.select().from(worldFacts).all()).toEqual([])
  expect(await f.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get()).toMatchObject({ simNow: WORLD_TIME })
  await releaseEngineTickLease(f.db, ownerToken)
})
