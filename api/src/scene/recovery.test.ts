import { afterEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { dialogueTurns, dialogues, persons, personStates, sceneRequests, universeEvidence, worldCommands,
  worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { SCENE_REQUEST_STALE_MS } from './routes'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { vi.unstubAllGlobals(); fixture?.close(); fixture = null })

it('recovers a crashed scene reservation and makes late worker commits impossible', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  await f.db.insert(universeEvidence).values({ timelineId: 'home-main', level: 'complete', assessedVersion: 0,
    baselineVersion: 0, reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME }).onConflictDoNothing()
  const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
  await f.db.insert(persons).values([
    { id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME },
    { id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME },
  ])
  await f.db.insert(worldPersons).values(['resident', 'visitor'].map(personId => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
  await f.db.insert(dialogues).values({ id: 'crashed-dialogue', timelineId: 'home-main', location: 'Cafe',
    participantIdsJson: JSON.stringify(['visitor', 'resident']), status: 'scene', kind: 'scene', visitorId: 'visitor',
    turnLimit: 100, simStart: WORLD_TIME, simEnd: WORLD_TIME })
  const stale = Date.now() - SCENE_REQUEST_STALE_MS - 1
  await f.db.insert(sceneRequests).values({ id: 'crashed-request', dialogueId: 'crashed-dialogue', contentHash: 'hash',
    status: 'pending', createdAt: stale, heartbeatAt: stale })

  const status = await app.request('/api/worlds/home-world/scene/requests/crashed-request?timelineId=home-main', { headers }, f.env)
  expect(status.status).toBe(200)
  expect(await status.json()).toMatchObject({ status: 'pending', recoverable: true })
  expect((await f.db.select().from(sceneRequests).get())?.status).toBe('pending') // GET remains read-only.

  await f.db.update(universeEvidence).set({ level: 'incomplete', baselineVersion: null,
    reasonCodesJson: '["missing_checkpoint"]' }).where(eq(universeEvidence.timelineId, 'home-main'))
  const blocked = await app.request('/api/worlds/home-world/scene/requests/crashed-request/recover?timelineId=home-main', {
    method: 'POST', headers,
  }, f.env)
  expect(blocked.status).toBe(409)
  expect((await f.db.select().from(sceneRequests).get())?.status).toBe('pending')
  await f.db.update(universeEvidence).set({ level: 'complete', baselineVersion: 0,
    reasonCodesJson: '["test_complete"]' }).where(eq(universeEvidence.timelineId, 'home-main'))

  const recovery = await app.request('/api/worlds/home-world/scene/requests/crashed-request/recover?timelineId=home-main', {
    method: 'POST', headers,
  }, f.env)
  expect(recovery.status).toBe(200)
  expect(await recovery.json()).toMatchObject({ status: 'failed', recoverable: false })
  expect((await f.db.select().from(sceneRequests).get())?.status).toBe('failed')

  // Even a worker that resumes after recovery cannot commit the same reserved scene.
  expect(() => f.sqlite.prepare(`INSERT INTO world_commands
    (id, world_id, timeline_id, actor_kind, actor_id, type, payload_json, expected_version, result_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'scene:crashed-request', 'home-world', 'home-main', 'visitor', 'visitor', 'conversation',
    JSON.stringify({ type: 'conversation', dialogueId: 'crashed-dialogue', requestId: 'crashed-request', turns: [{ id: 'visitor-turn', personId: 'visitor' }] }),
    0, 1, WORLD_TIME,
  )).toThrow(/scene_request_not_live/)
  expect((await f.db.select().from(worldCommands).all()).filter(command => command.type === 'conversation')).toHaveLength(0)
  expect(await f.db.select().from(dialogueTurns).all()).toHaveLength(0)
})

it('does not recover a live worker reservation', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  await f.db.insert(universeEvidence).values({ timelineId: 'home-main', level: 'complete', assessedVersion: 0,
    baselineVersion: 0, reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME }).onConflictDoNothing()
  const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
  await f.db.insert(persons).values([
    { id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME },
    { id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME },
  ])
  await f.db.insert(worldPersons).values(['resident', 'visitor'].map(personId => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
  await f.db.insert(personStates).values(['resident', 'visitor'].map(personId => ({ personId, timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Talk', updatedRealAt: WORLD_TIME })))
  await f.db.insert(dialogues).values({ id: 'live-dialogue', timelineId: 'home-main', location: 'Cafe',
    participantIdsJson: JSON.stringify(['visitor', 'resident']), status: 'scene', kind: 'scene', visitorId: 'visitor',
    turnLimit: 100, simStart: WORLD_TIME, simEnd: WORLD_TIME })
  const now = Date.now()
  await f.db.insert(sceneRequests).values({ id: 'live-request', dialogueId: 'live-dialogue', contentHash: 'hash',
    status: 'pending', createdAt: now, heartbeatAt: now })
  const response = await app.request('/api/worlds/home-world/scene/requests/live-request/recover?timelineId=home-main', {
    method: 'POST', headers,
  }, f.env)
  expect(await response.json()).toMatchObject({ status: 'pending', recoverable: false })
  expect((await f.db.select().from(sceneRequests).where(eq(sceneRequests.id, 'live-request')).get())?.status).toBe('pending')
})

it('cancels a live request when the visitor closes the panel and fences a late worker', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  await f.db.insert(universeEvidence).values({ timelineId: 'home-main', level: 'complete', assessedVersion: 0,
    baselineVersion: 0, reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME }).onConflictDoNothing()
  const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
  await f.db.insert(persons).values([
    { id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME },
    { id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME },
  ])
  await f.db.insert(worldPersons).values(['resident', 'visitor'].map(personId => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
  await f.db.insert(dialogues).values({ id: 'cancel-dialogue', timelineId: 'home-main', location: 'Cafe',
    participantIdsJson: JSON.stringify(['visitor', 'resident']), status: 'scene', kind: 'scene', visitorId: 'visitor',
    turnLimit: 100, simStart: WORLD_TIME, simEnd: WORLD_TIME })
  await f.db.insert(sceneRequests).values({ id: 'cancel-request', dialogueId: 'cancel-dialogue', contentHash: 'hash',
    status: 'pending', createdAt: Date.now(), heartbeatAt: Date.now() })

  const response = await app.request('/api/worlds/home-world/scene/requests/cancel-request/cancel?timelineId=home-main', {
    method: 'POST', headers,
  }, f.env)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'failed' })
  expect((await f.db.select().from(sceneRequests).where(eq(sceneRequests.id, 'cancel-request')).get())?.status).toBe('failed')

  expect(() => f.sqlite.prepare(`INSERT INTO world_commands
    (id, world_id, timeline_id, actor_kind, actor_id, type, payload_json, expected_version, result_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'scene:cancel-request', 'home-world', 'home-main', 'visitor', 'visitor', 'conversation',
    JSON.stringify({ type: 'conversation', dialogueId: 'cancel-dialogue', requestId: 'cancel-request', turns: [{ id: 'late-turn', personId: 'resident' }] }),
    0, 1, WORLD_TIME,
  )).toThrow(/scene_request_not_live/)
  expect(await f.db.select().from(worldCommands).all()).toHaveLength(0)
  expect(await f.db.select().from(dialogueTurns).all()).toHaveLength(0)
})

it('aborts the provider call in the owning Worker when the cancel endpoint is called', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  await f.db.insert(universeEvidence).values({ timelineId: 'home-main', level: 'complete', assessedVersion: 0,
    baselineVersion: 0, reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME }).onConflictDoNothing()
  const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
  const emptyModel = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] })
  await f.db.insert(persons).values([
    { id: 'resident', userId: 'owner', name: 'Resident', modelJson: emptyModel, createdAt: WORLD_TIME },
    { id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME },
  ])
  await f.db.insert(worldPersons).values(['resident', 'visitor'].map(personId => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
  await f.db.insert(personStates).values(['resident', 'visitor'].map(personId => ({ personId, timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Talk', updatedRealAt: WORLD_TIME })))

  let providerSignal: AbortSignal | undefined
  let signalStarted!: () => void
  const providerStarted = new Promise<void>(resolve => { signalStarted = resolve })
  vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    providerSignal = init?.signal ?? undefined
    signalStarted()
    return new Promise<Response>(() => {})
  }))

  const response = await app.request('/api/worlds/home-world/scene', { method: 'POST', headers,
    body: JSON.stringify({ timelineId: 'home-main', location: 'Cafe', content: 'Please say hello.', requestId: 'worker-cancel-request' }),
  }, f.env)
  const reader = response.body!.getReader()
  const firstFrame = await reader.read()
  expect(new TextDecoder().decode(firstFrame.value)).toContain('scene_start')
  await providerStarted
  expect(providerSignal?.aborted).toBe(false)

  const cancelled = await app.request('/api/worlds/home-world/scene/requests/worker-cancel-request/cancel?timelineId=home-main', {
    method: 'POST', headers,
  }, f.env)
  expect(await cancelled.json()).toEqual({ status: 'failed' })
  expect(providerSignal?.aborted).toBe(true)
  await reader.cancel()
  expect((await f.db.select().from(sceneRequests).where(eq(sceneRequests.id, 'worker-cancel-request')).get())?.status).toBe('failed')
  expect((await f.db.select().from(worldCommands).all()).filter(command => command.type === 'conversation')).toHaveLength(0)
  expect(await f.db.select().from(dialogueTurns).all()).toHaveLength(0)
})
