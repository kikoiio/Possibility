import { afterEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as guestCleanup from '../demo/cleanup'
import * as engineTick from '../engine/tick'
import app, { type Env } from '../index'
import { engineTickLeases, events, llmCallLog, memories, personaMessages, timelines, universeEvidence, universeRevisions, worldCommands, worldFacts, worldVisits, worlds } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from './world-fixture'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); fixture?.close(); fixture = null })

const auth = { Authorization: 'Bearer owner-token' }

function snapshot(f: NonNullable<typeof fixture>) {
  return {
    worlds: f.sqlite.prepare('SELECT * FROM worlds ORDER BY id').all(),
    timelines: f.sqlite.prepare('SELECT * FROM timelines ORDER BY id').all(),
    commands: f.sqlite.prepare('SELECT * FROM world_commands ORDER BY id').all(),
    facts: f.sqlite.prepare('SELECT * FROM world_facts ORDER BY id').all(),
    events: f.sqlite.prepare('SELECT * FROM events ORDER BY id').all(),
    revisions: f.sqlite.prepare('SELECT * FROM universe_revisions ORDER BY timeline_id, version').all(),
    memories: f.sqlite.prepare('SELECT * FROM memories ORDER BY id').all(),
    messages: f.sqlite.prepare('SELECT * FROM persona_messages ORDER BY id').all(),
    visits: f.sqlite.prepare('SELECT * FROM world_visits ORDER BY user_id, timeline_id').all(),
    llm: f.sqlite.prepare('SELECT * FROM llm_call_log ORDER BY id').all(),
  }
}

it('D1 return and evidence GETs preserve world state, watermarks, and model-call history', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  await f.db.insert(events).values({ id: 'evidence-gap-event', timelineId: 'home-main', simTime: WORLD_TIME,
    title: 'A recorded observation', description: 'No command or fact was attached.', kind: 'action' })
  // A returned event remains visible even when its direct source and complete
  // projection baseline are missing; dependent reconstruction must be closed.
  await f.db.update(universeEvidence).set({ level: 'incomplete',
    baselineVersion: null, reasonCodesJson: '["acceptance_incomplete_history"]' })
    .where(eq(universeEvidence.timelineId, 'home-main'))
  const modelFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('read-only GET attempted a provider call'))
  const before = snapshot(f)
  f.queryLog.length = 0

  const returnResponse = await app.request('/api/worlds/home-world/return?timelineId=home-main', { headers: auth }, f.env)
  expect(returnResponse.status).toBe(200)
  expect(await returnResponse.json()).toMatchObject({ timelineId: 'home-main', changes: [
    expect.objectContaining({ id: 'event:evidence-gap-event', kind: 'event' }),
  ] })

  const detailResponse = await app.request('/api/worlds/home-world/events/evidence-gap-event/evidence?timelineId=home-main',
    { headers: auth }, f.env)
  expect(detailResponse.status).toBe(200)
  expect(await detailResponse.json()).toMatchObject({
    event: { id: 'evidence-gap-event' }, command: null, facts: [],
    reconstruction: { status: 'unsupported' }, forkAvailable: false,
    gaps: expect.arrayContaining([expect.stringContaining('没有可核实的来源命令'), expect.stringContaining('历史证据不完整')]),
  })
  expect(snapshot(f)).toEqual(before)
  expect(modelFetch).not.toHaveBeenCalled()
  expect(f.queryLog.every(({ query }) => /^\s*(SELECT|WITH)\b/i.test(query))).toBe(true)
  expect(await f.db.select().from(worldCommands)).toHaveLength(0)
  expect(await f.db.select().from(worldFacts)).toHaveLength(0)
  expect(await f.db.select().from(universeRevisions)).toHaveLength(0)
  expect(await f.db.select().from(memories)).toHaveLength(0)
  expect(await f.db.select().from(personaMessages)).toHaveLength(0)
  expect(await f.db.select().from(worldVisits)).toHaveLength(0)
  expect(await f.db.select().from(llmCallLog)).toHaveLength(0)
})

it('D4 tick entry rejects unauthorized dispatch and skips paused, capped, and archived worlds', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  const env = { ...f.env, ENGINE_TICK_SECRET: 'scheduled-tick-secret', DIRECTOR_LLM: '0' }
  const before = snapshot(f)
  const forbidden = await app.request('/api/engine/tick', { method: 'POST', headers: { 'x-engine-secret': 'wrong' } }, env)
  expect(forbidden.status).toBe(403)
  expect(snapshot(f)).toEqual(before)

  await f.db.update(worlds).set({ status: 'paused', pauseReason: 'owner_pause' }).where(eq(worlds.id, 'home-world'))
  const paused = await app.request('/api/engine/tick', { method: 'POST', headers: { 'x-engine-secret': env.ENGINE_TICK_SECRET } }, env)
  expect(paused.status).toBe(200)
  expect((await paused.json() as { worlds: unknown[] }).worlds).toEqual([])
  expect(await f.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get()).toMatchObject({ simNow: WORLD_TIME })

  await f.db.update(worlds).set({ status: 'capped', pauseReason: 'global_daily_cap',
    callsDay: new Date().toISOString().slice(0, 10), callsToday: 400 }).where(eq(worlds.id, 'home-world'))
  const capped = await app.request('/api/engine/tick', { method: 'POST', headers: { 'x-engine-secret': env.ENGINE_TICK_SECRET } }, env)
  expect(capped.status).toBe(200)
  expect((await capped.json() as { worlds: unknown[] }).worlds).toEqual([])

  await f.db.update(worlds).set({ status: 'archived', pauseReason: 'idle_archive' }).where(eq(worlds.id, 'home-world'))
  const archived = await app.request('/api/engine/tick', { method: 'POST', headers: { 'x-engine-secret': env.ENGINE_TICK_SECRET } }, env)
  expect(archived.status).toBe(200)
  expect((await archived.json() as { worlds: unknown[] }).worlds).toEqual([])
  expect(await f.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get()).toMatchObject({ simNow: WORLD_TIME })
})

it('D4 scheduled handler selects daily cleanup and opt-in engine cadence independently', async () => {
  fixture = await createWorldFixture()
  const cleanup = vi.spyOn(guestCleanup, 'cleanupExpiredGuestData').mockResolvedValue({ sessions: 0, sandboxes: 0, worlds: 0 })
  const tick = vi.spyOn(engineTick, 'runTick').mockResolvedValue(null)
  vi.spyOn(console, 'error').mockImplementation(() => {})

  const dispatch = async (cron: string, env: Env) => {
    const scheduledWork: Promise<unknown>[] = []
    app.scheduled({ cron, scheduledTime: Date.now() } as ScheduledController,
      env, { waitUntil: promise => { scheduledWork.push(promise) } } as unknown as ExecutionContext)
    await Promise.all(scheduledWork)
  }

  await dispatch('* * * * *', { ...fixture!.env, DIRECTOR_LLM: '0' })
  expect(cleanup).not.toHaveBeenCalled()
  expect(tick).not.toHaveBeenCalled()

  await dispatch('17 3 * * *', { ...fixture!.env, DIRECTOR_LLM: '0' })
  expect(cleanup).toHaveBeenCalledTimes(1)
  expect(tick).not.toHaveBeenCalled()

  cleanup.mockRejectedValueOnce(new Error('guest cleanup failed'))
  await dispatch('17 3 * * *', { ...fixture!.env, DIRECTOR_LLM: '0', ENGINE_CRON_TICK: '1' })
  expect(cleanup).toHaveBeenCalledTimes(2)
  expect(tick).toHaveBeenCalledTimes(1)

  await dispatch('* * * * *', { ...fixture!.env, DIRECTOR_LLM: '0', ENGINE_CRON_TICK: '1' })
  expect(cleanup).toHaveBeenCalledTimes(2)
  expect(tick).toHaveBeenCalledTimes(2)
})

it('D4 scheduled handler dispatches an opted-in engine tick, preserves default pinger mode, and releases its lease', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  const realAnchor = new Date()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(realAnchor.getTime() + 15_000))
  await f.db.update(timelines).set({ lastRealTickAt: realAnchor.toISOString() }).where(eq(timelines.id, 'home-main'))

  const dispatch = async (env: typeof f.env, cron = '17 3 * * *') => {
    const scheduledWork: Promise<unknown>[] = []
    app.scheduled({ cron, scheduledTime: Date.now() } as ScheduledController,
      env, { waitUntil: promise => { scheduledWork.push(promise) } } as unknown as ExecutionContext)
    await Promise.all(scheduledWork)
  }

  // External pinger deployments keep the established behavior by default.
  await dispatch({ ...f.env, DIRECTOR_LLM: '0' })
  expect(await f.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())
    .toMatchObject({ simNow: WORLD_TIME })

  await dispatch({ ...f.env, DIRECTOR_LLM: '0', ENGINE_CRON_TICK: '1' }, '* * * * *')
  const afterTick = (await f.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())!
  expect(Date.parse(afterTick.simNow)).toBeGreaterThan(Date.parse(WORLD_TIME))
  expect(await f.db.select().from(engineTickLeases)).toEqual([])

  await f.db.update(worlds).set({ status: 'paused', pauseReason: 'owner_pause' }).where(eq(worlds.id, 'home-world'))
  const pausedAt = (await f.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())!.simNow
  await dispatch({ ...f.env, DIRECTOR_LLM: '0', ENGINE_CRON_TICK: '1' }, '* * * * *')
  expect(await f.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get()).toMatchObject({ simNow: pausedAt })
  expect(await f.db.select().from(engineTickLeases)).toEqual([])
})

it('D4 overlapping scheduled engine events commit one tick and leave no lease behind', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  const realAnchor = new Date()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(realAnchor.getTime() + 15_000))
  await f.db.update(timelines).set({ lastRealTickAt: realAnchor.toISOString() }).where(eq(timelines.id, 'home-main'))

  const pending: Promise<unknown>[] = []
  const context = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise) } } as unknown as ExecutionContext
  const controller = { cron: '* * * * *', scheduledTime: Date.now() } as ScheduledController
  const env = { ...f.env, DIRECTOR_LLM: '0', ENGINE_CRON_TICK: '1' }
  app.scheduled(controller, env, context)
  app.scheduled(controller, env, context)
  await Promise.all(pending)

  const clockCommands = await f.db.select().from(worldCommands).where(eq(worldCommands.type, 'clock_advance'))
  expect(clockCommands.filter(command => command.timelineId === 'home-main')).toHaveLength(1)
  expect(await f.db.select().from(engineTickLeases)).toEqual([])
})
