import { afterEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { demoBaselines, demoSandboxes, guestSessions, llmCallLog, persons, personStates, schedules, timelines, universeEvidence, universeRevisions, worldFacts, worldModelVersions, worldPersons, worlds } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { scheduleExecutor } from './steps/schedule'
import { auditUniverse } from '../world-state/invariants'
import app from '../index'
import { runTick } from './tick'
import { acquireEngineTickLease, releaseEngineTickLease } from './tick-lease'
import { createRootProjectionBaseline } from '../world-state/model'
import * as worldStateSystem from '../world-state/system'
import * as budgetModule from './budget'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  fixture?.close()
  fixture = null
})

async function markMainComplete() {
  await fixture!.db.insert(universeEvidence).values({ timelineId: 'home-main', level: 'complete', assessedVersion: 0,
    baselineVersion: 0, reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME }).onConflictDoNothing()
}

it('skips an active read-only baseline world while advancing guest and regular worlds', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  const realAnchor = new Date()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(realAnchor.getTime() + 15_000))
  await f.db.insert(worlds).values({ id: 'baseline-world', userId: 'other', name: 'Read-only baseline',
    description: 'Active public baseline', status: 'running' })
  await f.db.insert(timelines).values({ id: 'baseline-main', worldId: 'baseline-world', simNow: WORLD_TIME,
    createdAt: WORLD_TIME, lastRealTickAt: realAnchor.toISOString() })
  await f.db.update(timelines).set({ lastRealTickAt: realAnchor.toISOString() })
    .where(eq(timelines.id, 'home-main'))
  await f.db.update(timelines).set({ lastRealTickAt: realAnchor.toISOString() })
    .where(eq(timelines.id, 'other-main'))
  await f.db.insert(universeEvidence).values([
    { timelineId: 'home-main', level: 'complete', assessedVersion: 0, baselineVersion: 0,
      reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME },
    { timelineId: 'other-main', level: 'complete', assessedVersion: 0, baselineVersion: 0,
      reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME },
    { timelineId: 'baseline-main', level: 'complete', assessedVersion: 0, baselineVersion: 0,
      reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME },
  ]).onConflictDoNothing()
  await f.db.insert(demoBaselines).values({ id: 'active-baseline', worldId: 'baseline-world', sceneVersion: 1,
    contentHash: 'baseline-hash', status: 'active', createdAt: WORLD_TIME })
  await f.db.insert(worlds).values({ id: 'guest-world', userId: 'other', name: 'Guest sandbox',
    description: 'Isolated guest world', status: 'running' })
  await f.db.insert(timelines).values({ id: 'guest-main', worldId: 'guest-world', simNow: WORLD_TIME,
    createdAt: WORLD_TIME, lastRealTickAt: realAnchor.toISOString() })
  await f.db.insert(universeEvidence).values({ timelineId: 'guest-main', level: 'complete', assessedVersion: 0,
    baselineVersion: 0, reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME })
  await f.db.insert(guestSessions).values({ id: 'guest-session', tokenHash: 'guest-token-hash', ownerUserId: 'other',
    currentSandboxWorldId: 'guest-world', generation: 0, status: 'active', resumeTimelineId: 'guest-main',
    resumeSpaceId: 'exterior', resumeMode: 'life', expiresAt: '2099-01-01T00:00:00.000Z',
    createdAt: WORLD_TIME, updatedAt: WORLD_TIME })
  await f.db.insert(demoSandboxes).values({ id: 'guest-sandbox', sessionId: 'guest-session', baselineId: 'active-baseline',
    worldId: 'guest-world', generation: 0, status: 'active', requestId: 'guest-request', claimedWorldId: null,
    createdAt: WORLD_TIME, expiresAt: '2099-01-01T00:00:00.000Z' })
  const env = { ...f.env, DIRECTOR_LLM: '0', WORLD_SPEED: '6' }

  // S2/F1：基线按 active 登记精确排除——不推进、不出现在结果中；其余世界正常推进,整拍不抛错
  const result = await runTick(env, f.db)

  expect(result?.worlds.some(world => world.id === 'baseline-world')).toBe(false)
  expect((await f.db.select().from(timelines).where(eq(timelines.id, 'baseline-main')).get())?.simNow).toBe(WORLD_TIME)
  expect(result?.worlds.find(world => world.id === 'guest-world')?.timelines.map(timeline => timeline.id))
    .toEqual(['guest-main'])
  expect((await f.db.select().from(timelines).where(eq(timelines.id, 'guest-main')).get())?.simNow)
    .toBe('2026-09-21T08:01:30.000Z')
})

it('advances an eligible guest timeline when the active baseline timeline is ineligible', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  const realAnchor = new Date()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(realAnchor.getTime() + 15_000))
  await f.db.insert(worlds).values({ id: 'baseline-world', userId: 'other', name: 'Read-only baseline',
    description: 'Active public baseline', status: 'running' })
  await f.db.insert(timelines).values({ id: 'baseline-main', worldId: 'baseline-world', simNow: WORLD_TIME,
    createdAt: WORLD_TIME, lastRealTickAt: realAnchor.toISOString() })
  await f.db.insert(universeEvidence).values({ timelineId: 'baseline-main', level: 'incomplete', assessedVersion: 0,
    baselineVersion: null, reasonCodesJson: '["test_incomplete"]', assessedAt: WORLD_TIME })
  await f.db.insert(demoBaselines).values({ id: 'active-baseline', worldId: 'baseline-world', sceneVersion: 1,
    contentHash: 'baseline-hash', status: 'active', createdAt: WORLD_TIME })
  await f.db.insert(worlds).values({ id: 'guest-world', userId: 'other', name: 'Guest sandbox',
    description: 'Isolated guest world', status: 'running' })
  await f.db.insert(timelines).values({ id: 'guest-main', worldId: 'guest-world', simNow: WORLD_TIME,
    createdAt: WORLD_TIME, lastRealTickAt: realAnchor.toISOString() })
  await f.db.insert(universeEvidence).values({ timelineId: 'guest-main', level: 'complete', assessedVersion: 0,
    baselineVersion: 0, reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME })
  await f.db.insert(guestSessions).values({ id: 'guest-session', tokenHash: 'guest-token-hash', ownerUserId: 'other',
    currentSandboxWorldId: 'guest-world', generation: 0, status: 'active', resumeTimelineId: 'guest-main',
    resumeSpaceId: 'exterior', resumeMode: 'life', expiresAt: '2099-01-01T00:00:00.000Z',
    createdAt: WORLD_TIME, updatedAt: WORLD_TIME })
  await f.db.insert(demoSandboxes).values({ id: 'guest-sandbox', sessionId: 'guest-session', baselineId: 'active-baseline',
    worldId: 'guest-world', generation: 0, status: 'active', requestId: 'guest-request', claimedWorldId: null,
    createdAt: WORLD_TIME, expiresAt: '2099-01-01T00:00:00.000Z' })
  const env = { ...f.env, DIRECTOR_LLM: '0', WORLD_SPEED: '6' }
  const result = await runTick(env, f.db)

  // S2/F1：基线世界在世界选择阶段即被排除,不进入结果集
  expect(result?.worlds.some(world => world.id === 'baseline-world')).toBe(false)
  expect(result?.worlds.find(world => world.id === 'guest-world')?.timelines.map(timeline => timeline.id))
    .toEqual(['guest-main'])
  expect((await f.db.select().from(timelines).where(eq(timelines.id, 'baseline-main')).get())?.simNow).toBe(WORLD_TIME)
  expect((await f.db.select().from(timelines).where(eq(timelines.id, 'guest-main')).get())?.simNow)
    .toBe('2026-09-21T08:01:30.000Z')
})

it('isolates a world clock failure and advances later worlds', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  const realAnchor = new Date()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(realAnchor.getTime() + 15_000))
  await f.db.update(timelines).set({ lastRealTickAt: realAnchor.toISOString() })
  await f.db.insert(universeEvidence).values({ timelineId: 'other-main', level: 'complete', assessedVersion: 0,
    baselineVersion: 0, reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME })
  const runningWorldIds = (await f.db.select().from(worlds).all()).filter(world => world.status === 'running')
    .map(world => world.id)
  const homeWorldIndex = runningWorldIds.indexOf('home-world')
  const laterWorldId = runningWorldIds.slice(homeWorldIndex + 1).find(id => id === 'other-world')
  expect(homeWorldIndex).toBeGreaterThanOrEqual(0)
  expect(laterWorldId).toBeDefined()
  const advanceWorldClock = worldStateSystem.advanceWorldClock
  const advanceSpy = vi.spyOn(worldStateSystem, 'advanceWorldClock').mockImplementation(async (db, params) => {
    if (params.worldId === 'home-world') throw new Error('controlled world clock failure')
    return advanceWorldClock(db, params)
  })

  // S2/F2：单世界失败隔离——失败世界带诊断,后续世界照常推进,整拍正常返回
  const result = await runTick({ ...f.env, DIRECTOR_LLM: '0' }, f.db)

  expect(result?.worlds.find(world => world.id === 'home-world')?.timelines[0]?.error)
    .toBe('controlled world clock failure')
  expect(advanceSpy.mock.calls.map(([_, params]) => params.worldId)).toEqual(['home-world', 'other-world'])
  const laterTimeline = result?.worlds.find(world => world.id === 'other-world')?.timelines[0]
  expect(laterTimeline?.error).toBeUndefined()
  expect(laterTimeline?.simNow).not.toBe(WORLD_TIME)
})

it('isolates a failed timeline and advances the sibling timeline in the same world', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  const realAnchor = new Date()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(realAnchor.getTime() + 15_000))
  await f.db.update(timelines).set({ lastRealTickAt: realAnchor.toISOString() }).where(eq(timelines.id, 'home-main'))
  await markMainComplete()
  await f.db.insert(timelines).values({ id: 'home-fork', worldId: 'home-world', parentTimelineId: 'home-main',
    simNow: WORLD_TIME, createdAt: WORLD_TIME, lastRealTickAt: realAnchor.toISOString() })
  await f.db.insert(universeEvidence).values({ timelineId: 'home-fork', level: 'complete', assessedVersion: 0,
    baselineVersion: 0, reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME })
  const advanceWorldClock = worldStateSystem.advanceWorldClock
  vi.spyOn(worldStateSystem, 'advanceWorldClock').mockImplementation(async (db, params) => {
    if (params.timelineId === 'home-main') throw new Error('controlled timeline clock failure')
    return advanceWorldClock(db, params)
  })

  // S2/F2：单时间线失败不阻塞同世界其他时间线
  const result = await runTick({ ...f.env, DIRECTOR_LLM: '0', WORLD_SPEED: '6' }, f.db)
  const tls = result?.worlds.find(world => world.id === 'home-world')?.timelines

  expect(tls?.find(timeline => timeline.id === 'home-main')?.error).toBe('controlled timeline clock failure')
  const fork = tls?.find(timeline => timeline.id === 'home-fork')
  expect(fork?.error).toBeUndefined()
  expect(fork?.simNow).toBe('2026-09-21T08:01:30.000Z')
})

it('isolates a failed schedule step and attempts the next schedule step', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  await markMainComplete()
  const realAnchor = new Date()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(realAnchor.getTime() + 15_000))
  await f.db.update(timelines).set({ lastRealTickAt: realAnchor.toISOString() })
  const emptyModel = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [],
    boundaries: [], unknowns: [] })
  await f.db.insert(persons).values([
    { id: 'resident-fails', userId: 'owner', name: 'Fails', modelJson: emptyModel, createdAt: WORLD_TIME },
    { id: 'resident-next', userId: 'owner', name: 'Next', modelJson: emptyModel, createdAt: WORLD_TIME },
  ])
  await f.db.insert(worldPersons).values([
    { worldId: 'home-world', personId: 'resident-fails', joinedAt: WORLD_TIME },
    { worldId: 'home-world', personId: 'resident-next', joinedAt: WORLD_TIME },
  ])
  await f.db.insert(personStates).values([
    { personId: 'resident-fails', timelineId: 'home-main', simTime: WORLD_TIME, location: 'Cafe', activity: 'Reading',
      mood: 'Calm', goal: 'Continue', lastBeatSimTime: WORLD_TIME, updatedRealAt: WORLD_TIME },
    { personId: 'resident-next', timelineId: 'home-main', simTime: WORLD_TIME, location: 'Cafe', activity: 'Reading',
      mood: 'Calm', goal: 'Continue', lastBeatSimTime: WORLD_TIME, updatedRealAt: WORLD_TIME },
  ])
  const attempted: string[] = []
  vi.spyOn(scheduleExecutor, 'decide').mockImplementation(async (_env, input) => {
    attempted.push(input.step.personId!)
    if (input.step.personId === 'resident-fails') throw new Error('controlled schedule decision failure')
    return { value: null, llmCalls: 0 }
  })

  const result = await runTick({ ...f.env, DIRECTOR_LLM: '0' }, f.db)
  const steps = result?.worlds.find(world => world.id === 'home-world')?.timelines
    .find(timeline => timeline.id === 'home-main')?.steps

  expect(attempted, JSON.stringify(result)).toEqual(expect.arrayContaining(['resident-fails', 'resident-next']))
  expect(steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'schedule', personId: 'resident-fails', ok: false,
      note: 'controlled schedule decision failure' }),
    expect.objectContaining({ kind: 'schedule', personId: 'resident-next', ok: false }),
  ]))
})

it('skips active timelines whose evidence is not complete without changing history', async () => {
  fixture = await createWorldFixture()
  await fixture.db.update(universeEvidence).set({ level: 'incomplete', baselineVersion: null,
    reasonCodesJson: '["test_incomplete"]' }).where(eq(universeEvidence.timelineId, 'home-main'))
  const before = await fixture.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get()
  const result = await runTick({ ...fixture.env, DIRECTOR_LLM: '0' }, fixture.db)
  expect(result?.worlds.find(world => world.id === 'home-world')?.timelines).toEqual([])
  expect(await fixture.db.select().from(worldFacts).all()).toEqual([])
  expect(await fixture.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get()).toEqual(before)
})

it('applies a crossed schedule transition once across consecutive ticks', async () => {
  fixture = await createWorldFixture()
  await markMainComplete()
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
  await markMainComplete()
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

it('persists receipts across independent ticks, fails one invalid decision safely, and resumes on the next tick', async () => {
  fixture = await createWorldFixture()
  await markMainComplete()
  const realAnchor = new Date()
  vi.useFakeTimers()
  await fixture.db.update(timelines).set({ lastRealTickAt: realAnchor.toISOString() }).where(eq(timelines.id, 'home-main'))
  const emptyModel = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] })
  await fixture.db.insert(persons).values({ id: 'continuous-resident', userId: 'owner', name: 'Continuous Resident',
    modelJson: emptyModel, createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'continuous-resident', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ personId: 'continuous-resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Continue', lastBeatSimTime: WORLD_TIME,
    updatedRealAt: WORLD_TIME })
  await fixture.db.insert(schedules).values({ personId: 'continuous-resident', timelineId: 'home-main',
    worldDate: WORLD_TIME.slice(0, 10), generatedAt: WORLD_TIME, itemsJson: JSON.stringify([
      { start: '00:00', end: '08:01', location: 'Cafe', activity: 'Reading' },
      { start: '08:01', end: '08:03', location: 'Library', activity: 'Researching' },
      { start: '08:03', end: '08:05', location: 'Cafe', activity: 'Writing' },
      { start: '08:05', end: '12:00', location: 'Library', activity: 'Studying' },
      { start: '12:00', end: '18:00', location: 'Cafe', activity: 'Working' },
      { start: '18:00', end: '00:00', location: 'Cafe', activity: 'Resting' },
    ]) })

  const validBeat = (title: string) => JSON.stringify({
    events: [{ title, description: `${title} is recorded as a deterministic event.`, offsetMin: 1 }],
    thought: `Thinking about ${title}.`, memory: null,
    nextLocation: null, nextActivity: null, mood: null, goal: null,
  })
  const replies = [validBeat('First decision'), JSON.stringify({ events: [] }), JSON.stringify({ events: [] }),
    validBeat('Recovered decision')]
  const modelFetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: replies.shift() } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', modelFetch)
  const env = { ...fixture.env, WORLD_SPEED: '6', DIRECTOR_LLM: '0' }

  vi.setSystemTime(new Date(realAnchor.getTime() + 15_000))
  const first = await runTick(env, fixture.db)
  expect(first?.worlds[0]?.timelines[0]?.steps).toContainEqual(expect.objectContaining({ kind: 'beat', ok: true }))
  const firstRevision = (await fixture.db.select().from(universeRevisions)
    .where(eq(universeRevisions.timelineId, 'home-main')).get())!.version
  const afterFirst = await fixture.db.select().from(llmCallLog).where(eq(llmCallLog.worldId, 'home-world')).all()
  expect(afterFirst).toEqual([expect.objectContaining({ purpose: 'beat', status: 'completed', errorCode: null,
    contractVersion: 'beat/v2', contextHash: expect.stringMatching(/^[a-f0-9]{64}$/) })])
  const firstBeatFacts = (await fixture.db.select().from(worldFacts).all())
    .filter(fact => JSON.parse(fact.valueJson).cause === 'beat').length
  expect(firstBeatFacts).toBe(1)
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])

  // No browser/client state is retained between these invocations. Both retries
  // return schema-invalid JSON, so the decision fails without a beat write.
  vi.setSystemTime(new Date(realAnchor.getTime() + 30_000))
  const failed = await runTick(env, fixture.db)
  expect(failed?.worlds[0]?.timelines[0]?.steps).toContainEqual(expect.objectContaining({ kind: 'beat', ok: false }))
  const failedRevision = (await fixture.db.select().from(universeRevisions)
    .where(eq(universeRevisions.timelineId, 'home-main')).get())!.version
  expect(failedRevision).toBeGreaterThan(firstRevision)
  const afterFailure = await fixture.db.select().from(llmCallLog).where(eq(llmCallLog.worldId, 'home-world')).all()
  expect(afterFailure).toHaveLength(3)
  expect(afterFailure.slice(1)).toEqual([
    expect.objectContaining({ status: 'failed', errorCode: 'contract_violation', contractVersion: 'beat/v2' }),
    expect.objectContaining({ status: 'failed', errorCode: 'contract_violation', contractVersion: 'beat/v2' }),
  ])
  expect((await fixture.db.select().from(worldFacts).all())
    .filter(fact => JSON.parse(fact.valueJson).cause === 'beat')).toHaveLength(firstBeatFacts)
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])

  vi.setSystemTime(new Date(realAnchor.getTime() + 45_000))
  const recovered = await runTick(env, fixture.db)
  expect(recovered?.worlds[0]?.timelines[0]?.steps).toContainEqual(expect.objectContaining({ kind: 'beat', ok: true }))
  const recoveredRevision = (await fixture.db.select().from(universeRevisions)
    .where(eq(universeRevisions.timelineId, 'home-main')).get())!.version
  expect(recoveredRevision).toBeGreaterThan(failedRevision)
  const finalReceipts = await fixture.db.select().from(llmCallLog).where(eq(llmCallLog.worldId, 'home-world')).all()
  expect(finalReceipts).toHaveLength(4)
  expect(finalReceipts.at(-1)).toMatchObject({ status: 'completed', errorCode: null, contractVersion: 'beat/v2' })
  expect(finalReceipts.every(receipt => /^[a-f0-9]{64}$/.test(receipt.contextHash ?? ''))).toBe(true)
  expect((await fixture.db.select().from(worldFacts).all())
    .filter(fact => JSON.parse(fact.valueJson).cause === 'beat')).toHaveLength(firstBeatFacts + 1)
  expect(modelFetch).toHaveBeenCalledTimes(4)
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
})

it('advances an accelerated fixed world through a full simulated day and audits each tick', async () => {
  fixture = await createWorldFixture()
  await markMainComplete()
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
    personId: 'day-resident', timelineId: 'home-main', worldDate, itemsJson: daySchedule, generatedAt: WORLD_TIME, createdVersion: null,
  }))
  await fixture.db.insert(schedules).values(initialSchedules)
  const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [initialState])
  baseline.rows.schedules = initialSchedules
  await fixture.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
    modelJson: JSON.stringify({ name: 'Home world', description: 'A small town', locations: [],
      residents: [{ id: 'day-resident', name: 'Day Resident', model: {} }],
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
  const scheduleTransitions = (await fixture.db.select().from(worldFacts).all())
    .filter(fact => fact.subjectId === 'day-resident' && JSON.parse(fact.valueJson).cause === 'schedule')
  expect(scheduleTransitions.map(fact => JSON.parse(fact.valueJson).after.activity)).toEqual(['Working', 'Resting', 'Sleeping'])
  expect(new Set(scheduleTransitions.map(fact => fact.simTime)).size).toBe(scheduleTransitions.length)
  expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'day-resident')).get())?.location).toBe('Cafe')
  expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toEqual([])
})

it('rejects an overlapping engine HTTP tick while the active tick finishes once', async () => {
  fixture = await createWorldFixture()
  await markMainComplete()
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

it('rejects a tick call with a wrong engine secret', async () => {
  fixture = await createWorldFixture()
  const response = await app.request('/api/engine/tick', { method: 'POST',
    headers: { 'x-engine-secret': 'wrong' } }, { ...fixture.env, ENGINE_TICK_SECRET: 'engine-secret' })
  expect(response.status).toBe(403)
})

it('returns a structured 500 without rethrowing when the whole tick run fails', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  // 整拍级故障(世界循环之前):路由只记录并返回结构化 500,不向上抛(S2/F2)
  vi.spyOn(budgetModule, 'recoverCappedWorlds').mockRejectedValue(new Error('controlled whole-tick failure'))
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  const response = await app.request('/api/engine/tick', { method: 'POST',
    headers: { 'x-engine-secret': 'engine-secret' } }, { ...f.env, ENGINE_TICK_SECRET: 'engine-secret' })

  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ error: '引擎节拍失败', detail: 'controlled whole-tick failure' })
  expect(consoleSpy).toHaveBeenCalled()
})
