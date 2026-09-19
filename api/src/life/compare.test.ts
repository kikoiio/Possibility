import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createTestDb } from '../test/db'
import { commitments, events, memories, persons, personStates, schedules, sessions, timelines, users, worldPersons, worlds } from '../db/schema'
import { visibleMemories, retrieveForPrompt } from '../agent/memory'
import { readForkSnapshot } from '../agent/visibility'
import { comparisonRoutes, compareTimelines } from './compare'
import { forkTimeline } from './fork'
import { worldsRoutes } from '../worlds/routes'
import { timelineRoutes } from '../timelines/routes'

const SIM = '2026-09-19T09:00:00.000Z'
const REAL = '2026-09-18T09:00:00.000Z'
let fixture: ReturnType<typeof createTestDb>

async function seed() {
  const db = fixture.db
  await db.insert(users).values([
    { id: 'owner', username: 'owner', passwordHash: 'unused', createdAt: REAL },
    { id: 'other', username: 'other', passwordHash: 'unused', createdAt: REAL },
  ])
  await db.insert(sessions).values({ token: 'token', userId: 'owner', expiresAt: '2099-01-01T00:00:00.000Z' })
  await db.insert(worlds).values([
    { id: 'world', userId: 'owner', name: 'World', description: '', status: 'paused' },
    { id: 'foreign', userId: 'other', name: 'Secret', description: '' },
    { id: 'other-world', userId: 'owner', name: 'Other world', description: '' },
  ])
  await db.insert(timelines).values([
    { id: 'main', worldId: 'world', simNow: SIM, createdAt: REAL },
    { id: 'foreign-main', worldId: 'foreign', simNow: SIM, createdAt: REAL },
    { id: 'other-main', worldId: 'other-world', simNow: SIM, createdAt: REAL },
  ])
  for (const id of ['npc', 'visitor']) {
    await db.insert(persons).values({ id, userId: 'owner', name: id, modelJson: '{}', createdAt: REAL, isUser: id === 'visitor' })
    await db.insert(worldPersons).values({ worldId: 'world', personId: id, joinedAt: REAL })
    await db.insert(personStates).values({
      personId: id, timelineId: 'main', simTime: SIM, location: 'Cafe', activity: 'Reading', mood: 'Calm',
      goal: 'Finish the book', updatedRealAt: REAL, currentDialogueId: 'old-dialogue', lastBeatSimTime: REAL,
    })
  }
  await db.insert(memories).values({ id: 'remembered', personId: 'npc', timelineId: 'main', type: 'world', content: 'Before the fork', createdAt: REAL, simTime: REAL })
  await db.insert(events).values({ id: 'original', timelineId: 'main', simTime: REAL, title: 'Arrived', description: 'At the cafe', actorPersonId: 'npc' })
}

beforeEach(async () => {
  fixture = createTestDb()
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Tests must not call an LLM or network') }))
  await seed()
})
afterEach(() => { fixture.close(); vi.unstubAllGlobals() })

function request(path: string, auth = true) {
  return comparisonRoutes.request(path, { headers: auth ? { Authorization: 'Bearer token' } : {} }, fixture.env)
}

describe('owner-only, read-only comparison API', () => {
  it('rejects missing auth, missing queries, foreign worlds and timelines from any other world', async () => {
    expect((await request('/worlds/world/compare?left=main&right=main', false)).status).toBe(401)
    expect((await request('/worlds/world/compare?left=main')).status).toBe(400)
    expect((await request('/worlds/foreign/compare?left=foreign-main&right=foreign-main')).status).toBe(404)
    for (const right of ['missing', 'foreign-main', 'other-main']) {
      expect((await request(`/worlds/world/compare?left=main&right=${right}`)).status).toBe(404)
    }
  })

  it('returns deterministic evidence and makes no writes, including in a paused world', async () => {
    const fork = await forkTimeline(fixture.db, 'world', 'main')
    await fixture.db.update(personStates).set({ mood: 'Excited', goal: 'Meet a friend' })
      .where(and(eq(personStates.timelineId, fork.id), eq(personStates.personId, 'npc')))
    await fixture.db.insert(events).values({ id: 'branch-event', timelineId: fork.id, simTime: SIM, title: 'Meeting', description: 'A friend arrived', actorPersonId: 'npc' })
    const before = fixture.sqlite.prepare('SELECT total_changes() AS n').get()!.n
    const response = await request(`/worlds/world/compare?left=main&right=${fork.id}`)
    expect(response.status).toBe(200)
    const body = await response.json() as NonNullable<Awaited<ReturnType<typeof compareTimelines>>>
    expect(body.interpretation).toBe('observed_differences_not_causal_claims')
    expect(body.timeAlignment).toBe('same_sim_time')
    expect(body.differences.states).toEqual([{ personId: 'npc', changes: [
      expect.objectContaining({ field: 'mood', left: 'Calm', right: 'Excited', rightEvidence: expect.objectContaining({ table: 'person_states', timelineId: fork.id, simTime: SIM }) }),
      expect.objectContaining({ field: 'goal', left: 'Finish the book', right: 'Meet a friend' }),
    ] }])
    expect(body.differences.events.shared.map((e) => e.id)).toEqual(['original'])
    expect(body.differences.events.leftOnly).toEqual([])
    expect(body.differences.events.rightOnly.map((e) => e.id)).toEqual(['branch-event'])
    expect(body.sharedForkOrigin).toMatchObject({ timelineId: 'main', leftFork: null, rightFork: {
      forkTimelineId: fork.id, sourceSimTime: SIM, provenance: 'snapshot', eventIds: ['original'],
    } })
    expect(await (await request(`/worlds/world/compare?left=main&right=${fork.id}`)).json()).toEqual(body)
    expect(fixture.sqlite.prepare('SELECT total_changes() AS n').get()!.n).toBe(before)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('compares an archived timeline, reports clock differences and missing state explicitly', async () => {
    const fork = await forkTimeline(fixture.db, 'world', 'main')
    await fixture.db.update(timelines).set({ status: 'archived', simNow: '2026-09-20T09:00:00.000Z' }).where(eq(timelines.id, fork.id))
    await fixture.db.delete(personStates).where(and(eq(personStates.timelineId, fork.id), eq(personStates.personId, 'visitor')))
    const result = await compareTimelines(fixture.db, 'world', 'main', fork.id)
    expect(result?.timeAlignment).toBe('different_sim_times')
    expect(result?.right.status).toBe('archived')
    expect(result?.differences.states[0].changes.every((c) => c.right === null && c.rightEvidence === null)).toBe(true)
    const same = await compareTimelines(fixture.db, 'world', 'main', 'main')
    expect(same?.differences.states).toEqual([])
    expect(same?.differences.events.leftOnly).toEqual([])
    expect(same?.differences.events.rightOnly).toEqual([])
  })
})

describe('fork snapshots', () => {
  it('copies every person and goal, current/future schedules and open commitments with stable references', async () => {
    await fixture.db.insert(schedules).values(['2026-09-18', '2026-09-19', '2026-09-20'].map((worldDate) => ({
      personId: 'npc', timelineId: 'main', worldDate, itemsJson: '[{"activity":"Read"}]', generatedAt: REAL,
    })))
    await fixture.db.insert(commitments).values(['proposed', 'accepted', 'fulfilled', 'missed'].map((status) => ({
      id: status, worldId: 'world', timelineId: 'main', personId: 'npc', visitorId: 'visitor', sourceDialogueId: 'dialogue-ref',
      title: 'Meet', location: 'Cafe', dueSim: SIM, status, createdSim: REAL, updatedSim: REAL, createdAt: REAL,
    })))
    const response = await worldsRoutes.request('/world/timelines/main/fork', { method: 'POST', headers: { Authorization: 'Bearer token' } }, fixture.env)
    expect(response.status).toBe(200)
    const body = await response.json() as { id: string }
    const child = await fixture.db.select().from(timelines).where(eq(timelines.id, body.id)).get()
    expect(child?.ancestorIdsJson).toBe('["main"]')
    expect(child?.lastRealTickAt).toBeTruthy()
    const states = await fixture.db.select().from(personStates).where(eq(personStates.timelineId, body.id)).all()
    expect(states).toHaveLength(2)
    expect(states.every((s) => s.goal === 'Finish the book' && s.currentDialogueId === null && s.lastBeatSimTime === REAL)).toBe(true)
    const copied = await fixture.db.select().from(schedules).where(eq(schedules.timelineId, body.id)).all()
    expect(copied.map((s) => s.worldDate)).toEqual(['2026-09-19', '2026-09-20'])
    const promises = await fixture.db.select().from(commitments).where(eq(commitments.timelineId, body.id)).all()
    expect(promises.map((c) => c.status).sort()).toEqual(['accepted', 'proposed'])
    expect(promises.every((c) => c.id !== c.status && c.sourceDialogueId === 'dialogue-ref' && c.visitorId === 'visitor')).toBe(true)
    expect(readForkSnapshot(child!)?.commitments).toHaveLength(4)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('freezes inherited events/memories including summary flags across nested forks and later source edits', async () => {
    const first = await forkTimeline(fixture.db, 'world', 'main')
    await fixture.db.update(memories).set({ summarized: true, content: 'Later rewrite' }).where(eq(memories.id, 'remembered'))
    await fixture.db.insert(memories).values({ id: 'root-late', personId: 'npc', timelineId: 'main', type: 'world', content: 'Backdated but inserted after fork', simTime: REAL, createdAt: REAL })
    await fixture.db.insert(events).values({ id: 'root-late-event', timelineId: 'main', simTime: REAL, title: 'Later insert', description: '' })
    await fixture.db.insert(memories).values({ id: 'branch-memory', personId: 'npc', timelineId: first.id, type: 'world', content: 'Branch before nested fork', createdAt: REAL })
    await fixture.db.insert(events).values({ id: 'branch-before', timelineId: first.id, simTime: SIM, title: 'Branch', description: '' })
    const second = await forkTimeline(fixture.db, 'world', first.id)
    await fixture.db.insert(memories).values({ id: 'parent-late', personId: 'npc', timelineId: first.id, type: 'world', content: 'Parent after nested fork', createdAt: REAL })
    await fixture.db.insert(events).values({ id: 'parent-late-event', timelineId: first.id, simTime: SIM, title: 'Parent later', description: '' })
    const child = (await fixture.db.select().from(timelines).where(eq(timelines.id, second.id)).get())!
    expect(child.ancestorIdsJson).toBe(JSON.stringify(['main', first.id]))
    const visible = await visibleMemories(fixture.db, 'npc', child)
    expect(visible.map((m) => m.id).sort()).toEqual(['branch-memory', 'remembered'])
    expect(visible.find((m) => m.id === 'remembered')).toMatchObject({ content: 'Before the fork', summarized: false })
    expect((await retrieveForPrompt(fixture.db, 'npc', child)).map((m) => m.id)).toContain('remembered')
    const result = await compareTimelines(fixture.db, 'world', first.id, second.id)
    expect(result?.sharedForkOrigin?.timelineId).toBe(first.id)
    expect(result?.differences.events.shared.map((e) => e.id)).toEqual(['original', 'branch-before'])
    expect(result?.differences.events.leftOnly.map((e) => e.id)).toEqual(['parent-late-event'])
    expect(result?.differences.events.rightOnly).toEqual([])
  })

  it('rolls back all child rows if a copied schedule cannot be written', async () => {
    await fixture.db.insert(schedules).values({ personId: 'npc', timelineId: 'main', worldDate: '2026-09-19', itemsJson: '[]', generatedAt: REAL })
    fixture.sqlite.exec("CREATE TRIGGER fail_fork_schedule BEFORE INSERT ON schedules WHEN NEW.timeline_id <> 'main' BEGIN SELECT RAISE(ABORT, 'test copy failure'); END")
    await expect(forkTimeline(fixture.db, 'world', 'main')).rejects.toThrow()
    expect(await fixture.db.select().from(timelines).where(eq(timelines.worldId, 'world')).all()).toHaveLength(1)
    expect(await fixture.db.select().from(personStates).all()).toHaveLength(2)
  })

  it('rejects historical scenario snapshots before writes or model calls', async () => {
    await fixture.db.update(worlds).set({ status: 'running' }).where(eq(worlds.id, 'world'))
    const response = await timelineRoutes.request('/persons/npc/fork', {
      method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: { whatIf: 'Stay home', startTime: REAL } }),
    }, fixture.env)
    expect(response.status).toBe(409)
    expect(await fixture.db.select().from(timelines).where(eq(timelines.worldId, 'world')).all()).toHaveLength(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses each legacy ancestor’s cutoff and distrusts cached ancestor IDs', async () => {
    const firstReal = '2026-09-18T10:00:00.000Z'
    const secondReal = '2026-09-18T12:00:00.000Z'
    await fixture.db.insert(timelines).values([
      { id: 'old-child', worldId: 'world', parentTimelineId: 'main', simNow: SIM, createdAt: firstReal, ancestorIdsJson: 'garbage' },
      { id: 'old-grandchild', worldId: 'world', parentTimelineId: 'old-child', simNow: SIM, createdAt: secondReal, ancestorIdsJson: '["foreign-main"]' },
    ])
    await fixture.db.insert(memories).values([
      { id: 'legacy-null', personId: 'npc', timelineId: null, type: 'world', content: 'Old NULL bucket', createdAt: REAL },
      { id: 'root-too-late', personId: 'npc', timelineId: 'main', type: 'world', content: 'Wrong root memory', createdAt: '2026-09-18T11:00:00.000Z' },
      { id: 'parent-in-time', personId: 'npc', timelineId: 'old-child', type: 'world', content: 'Right parent memory', createdAt: '2026-09-18T11:00:00.000Z' },
      { id: 'foreign-memory', personId: 'npc', timelineId: 'foreign-main', type: 'world', content: 'Other world', createdAt: REAL },
    ])
    const child = (await fixture.db.select().from(timelines).where(eq(timelines.id, 'old-grandchild')).get())!
    expect((await visibleMemories(fixture.db, 'npc', child)).map((m) => m.id).sort()).toEqual(['legacy-null', 'parent-in-time', 'remembered'])
    const result = await compareTimelines(fixture.db, 'world', 'main', child.id)
    expect(result?.right.historyComplete).toBe(false)
    expect(result?.limitations).toHaveLength(2)
  })
})
