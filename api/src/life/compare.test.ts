import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createTestDb } from '../test/db'
import { commitments, dialogueTurns, dialogues, events, memories, personaMessages, persons, personStates, schedules, sessions, timelines, users, worldPersons, worlds } from '../db/schema'
import { visibleMemories, retrieveForPrompt } from '../agent/memory'
import { readForkSnapshot } from '../agent/visibility'
import { comparisonRoutes, compareTimelines } from './compare'
import { forkTimeline } from './fork'
import { commitWorldCommand } from '../world-state/commit'
import { readWorldState } from '../world-state/query'
import { buildEngineContext, buildWorldSnapshot } from '../agent/engine-context'
import { auditUniverse } from '../world-state/invariants'
import { worldsRoutes } from '../worlds/routes'
import { dialogueDetail, personFocus, worldSnapshot } from '../worlds/queries'
import { timelineRoutes } from '../timelines/routes'

const SIM = '2026-09-19T09:00:00.000Z'
const REAL = '2026-09-18T09:00:00.000Z'
const forkScenario = { whatIf: 'A different possibility', changedVariable: 'message delivery' }
let fixture: ReturnType<typeof createTestDb>

async function seed() {
  const db = fixture.db
  await db.insert(users).values([
    { id: 'owner', username: 'owner', passwordHash: 'unused', createdAt: REAL },
    { id: 'other', username: 'other', passwordHash: 'unused', createdAt: REAL },
  ])
  await db.insert(sessions).values([
    { token: 'token', userId: 'owner', expiresAt: '2099-01-01T00:00:00.000Z' },
    { token: 'other-token', userId: 'other', expiresAt: '2099-01-01T00:00:00.000Z' },
  ])
  await db.insert(worlds).values([
    { id: 'world', userId: 'owner', name: 'World', description: '', status: 'running' },
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

  it('rejects cross-user and cross-world Fork attempts without creating a timeline', async () => {
    const before = await fixture.db.select().from(timelines).all()
    const otherUserFork = await worldsRoutes.request('/world/timelines/main/fork', {
      method: 'POST', headers: { Authorization: 'Bearer other-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: forkScenario }),
    }, fixture.env)
    const foreignTimelineFork = await worldsRoutes.request('/world/timelines/foreign-main/fork', {
      method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: forkScenario }),
    }, fixture.env)
    const otherUserCompare = await comparisonRoutes.request('/worlds/world/compare?left=main&right=main', {
      headers: { Authorization: 'Bearer other-token' },
    }, fixture.env)

    expect(otherUserFork.status).toBe(404)
    expect(foreignTimelineFork.status).toBe(404)
    expect(otherUserCompare.status).toBe(404)
    expect(await fixture.db.select().from(timelines).all()).toEqual(before)
  })

  it('returns deterministic evidence and makes no writes, including in a paused world', async () => {
    const fork = await forkTimeline(fixture.db, 'world', 'main', { whatIf: 'The message never arrives', startTime: SIM,
      changedVariable: 'message delivery', participants: ['npc'], invariants: ['The weather remains unchanged'] })
    await fixture.db.update(worlds).set({ status: 'paused' }).where(eq(worlds.id, 'world'))
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
      sourceStateVersion: 0, scenario: { whatIf: 'The message never arrives', changedVariable: 'message delivery',
        participants: ['npc'], invariants: ['The weather remains unchanged'] },
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

  it('keeps legacy forks readable but never calls a timestamp-only history checkpoint complete', async () => {
    await fixture.db.insert(timelines).values({
      id: 'legacy-fork', worldId: 'world', parentTimelineId: 'main',
      forkScenarioJson: JSON.stringify({ startTime: SIM }), ancestorIdsJson: '["main"]',
      simNow: SIM, createdAt: REAL, status: 'active',
    })
    await fixture.db.insert(events).values({ id: 'legacy-own-event', timelineId: 'legacy-fork', simTime: SIM,
      title: 'A later record', description: 'This event belongs to the legacy fork.', actorPersonId: 'npc' })

    const result = await compareTimelines(fixture.db, 'world', 'main', 'legacy-fork')
    expect(result?.right.historyComplete).toBe(false)
    expect(result?.differences.events.rightOnly.map(event => event.id)).toContain('legacy-own-event')
    expect(result?.sharedForkOrigin?.rightFork).toMatchObject({ provenance: 'legacy', scenario: { startTime: SIM } })
    expect(result?.limitations).toContain('Legacy fork history lacks an immutable event snapshot; unavailable ancestor events are omitted.')
  })
})

describe('fork snapshots', () => {
  it('keeps memory, commitment, and knowledge on one Root→Child→Grandchild checkpoint matrix', async () => {
    await fixture.db.insert(commitments).values({ id: 'root-commitment-before-child', worldId: 'world', timelineId: 'main',
      personId: 'npc', visitorId: 'visitor', sourceDialogueId: 'root-dialogue', title: 'Meet before the fork',
      kind: 'meeting', location: 'Cafe', dueSim: new Date(Date.parse(SIM) + 60 * 60_000).toISOString(), status: 'proposed', createdSim: SIM, updatedSim: SIM, createdAt: REAL })
    await commitWorldCommand(fixture.db, { id: 'matrix-root-commitment', worldId: 'world', timelineId: 'main',
      userId: 'owner', expectedVersion: 0,
      action: { type: 'commitment', commitmentId: 'root-commitment-before-child', next: 'accepted' } })
    const rootKnowledge = await commitWorldCommand(fixture.db, { id: 'matrix-root-knowledge', worldId: 'world', timelineId: 'main',
      userId: 'owner', expectedVersion: 1,
      action: { type: 'inform', recipientId: 'npc', topic: 'matrix-root', content: 'Known before Child exists.' } })
    const child = await forkTimeline(fixture.db, 'world', 'main')

    await fixture.db.insert(memories).values({ id: 'root-memory-after-child', personId: 'npc', timelineId: 'main', type: 'thought',
      content: 'Added after Child was created.', createdAt: '2026-09-19T10:00:00.000Z', simTime: SIM })
    await fixture.db.insert(commitments).values({ id: 'root-commitment-after-child', worldId: 'world', timelineId: 'main',
      personId: 'npc', visitorId: 'visitor', sourceDialogueId: 'root-late-dialogue', title: 'Root only later commitment',
      kind: 'meeting', location: 'Library', dueSim: new Date(Date.parse(SIM) + 60 * 60_000).toISOString(), status: 'proposed', createdSim: SIM, updatedSim: SIM, createdAt: REAL })
    await commitWorldCommand(fixture.db, { id: 'matrix-root-late-commitment', worldId: 'world', timelineId: 'main',
      userId: 'owner', expectedVersion: 2,
      action: { type: 'commitment', commitmentId: 'root-commitment-after-child', next: 'accepted' } })
    const rootLateKnowledge = await commitWorldCommand(fixture.db, { id: 'matrix-root-late-knowledge', worldId: 'world', timelineId: 'main',
      userId: 'owner', expectedVersion: 3,
      action: { type: 'inform', recipientId: 'visitor', topic: 'root-late', content: 'Added after Child was created.' } })

    await fixture.db.insert(memories).values({ id: 'child-memory-before-grandchild', personId: 'npc', timelineId: child.id, type: 'thought',
      content: 'Added on Child before Grandchild was created.', createdAt: '2026-09-19T11:00:00.000Z', simTime: SIM })
    await fixture.db.insert(commitments).values({ id: 'child-commitment-before-grandchild', worldId: 'world', timelineId: child.id,
      personId: 'npc', visitorId: 'visitor', sourceDialogueId: 'child-dialogue', title: 'Child commitment', kind: 'meeting',
      location: 'Cafe', dueSim: new Date(Date.parse(SIM) + 60 * 60_000).toISOString(), status: 'proposed', createdSim: SIM, updatedSim: SIM, createdAt: REAL })
    const childKnowledge = await commitWorldCommand(fixture.db, { id: 'matrix-child-knowledge', worldId: 'world', timelineId: child.id,
      userId: 'owner', expectedVersion: 0,
      action: { type: 'inform', recipientId: 'visitor', topic: 'matrix-child', content: 'Known on Child before Grandchild exists.' } })
    await commitWorldCommand(fixture.db, { id: 'matrix-child-commitment', worldId: 'world', timelineId: child.id,
      userId: 'owner', expectedVersion: 1,
      action: { type: 'commitment', commitmentId: 'child-commitment-before-grandchild', next: 'accepted' } })
    const grandchild = await forkTimeline(fixture.db, 'world', child.id)

    await fixture.db.insert(memories).values([
      { id: 'child-memory-after-grandchild', personId: 'npc', timelineId: child.id, type: 'thought',
        content: 'Child only after Grandchild was created.', createdAt: '2026-09-19T12:00:00.000Z', simTime: SIM },
      { id: 'grandchild-memory', personId: 'npc', timelineId: grandchild.id, type: 'thought',
        content: 'Grandchild only.', createdAt: '2026-09-19T12:00:00.000Z', simTime: SIM },
    ])

    const childRow = (await fixture.db.select().from(timelines).where(eq(timelines.id, child.id)).get())!
    const grandchildRow = (await fixture.db.select().from(timelines).where(eq(timelines.id, grandchild.id)).get())!
    const childSnapshot = readForkSnapshot(childRow)!
    const grandchildSnapshot = readForkSnapshot(grandchildRow)!
    const commitmentIds = (timelineId: string) => fixture.db.select().from(commitments).where(eq(commitments.timelineId, timelineId)).all()
    const [rootCommitments, childCommitments, grandchildCommitments] = await Promise.all([
      commitmentIds('main'), commitmentIds(child.id), commitmentIds(grandchild.id),
    ])
    const [rootState, childState, grandchildState] = await Promise.all([
      readWorldState(fixture.db, 'world', 'main'), readWorldState(fixture.db, 'world', child.id), readWorldState(fixture.db, 'world', grandchild.id),
    ])
    const factIds = (state: typeof rootState) => [...new Set(state.facts.map(fact => fact.id))]

    expect(childSnapshot.memories.map(memory => memory.id)).toContain('remembered')
    expect(childSnapshot.memories.map(memory => memory.id)).not.toContain('root-memory-after-child')
    expect(grandchildSnapshot.memories.map(memory => memory.id)).toEqual(expect.arrayContaining([
      'remembered', 'child-memory-before-grandchild', 'commitment:root-commitment-before-child:accepted:memory',
    ]))
    expect(grandchildSnapshot.memories.map(memory => memory.id)).not.toContain('root-memory-after-child')
    expect(grandchildSnapshot.memories.map(memory => memory.id)).not.toContain('child-memory-after-grandchild')
    expect(grandchildSnapshot.memories.map(memory => memory.id)).not.toContain('grandchild-memory')

    expect(rootCommitments.map(row => row.title)).toEqual(expect.arrayContaining(['Meet before the fork', 'Root only later commitment']))
    expect(childCommitments.map(row => row.title)).toEqual(expect.arrayContaining(['Meet before the fork', 'Child commitment']))
    expect(childCommitments.map(row => row.title)).not.toContain('Root only later commitment')
    expect(grandchildCommitments.map(row => row.title)).toEqual(expect.arrayContaining(['Meet before the fork', 'Child commitment']))
    expect(grandchildCommitments.map(row => row.title)).not.toContain('Root only later commitment')

    expect(factIds(rootState)).toEqual(expect.arrayContaining([rootKnowledge.factId, rootLateKnowledge.factId]))
    expect(factIds(childState)).toEqual(expect.arrayContaining([rootKnowledge.factId, childKnowledge.factId]))
    expect(factIds(childState)).not.toContain(rootLateKnowledge.factId)
    expect(factIds(grandchildState)).toEqual(expect.arrayContaining([rootKnowledge.factId, childKnowledge.factId]))
    expect(factIds(grandchildState)).not.toContain(rootLateKnowledge.factId)
    expect(rootState.facts.map(fact => fact.id)).not.toContain(childKnowledge.factId)
    expect(await auditUniverse(fixture.db, 'world', 'main')).toEqual([])
    expect(await auditUniverse(fixture.db, 'world', child.id)).toEqual([])
    expect(await auditUniverse(fixture.db, 'world', grandchild.id)).toEqual([])
  })

  it('replays a world fork request ID without creating a second universe', async () => {
    const request = () => worldsRoutes.request('/world/timelines/main/fork', { method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'stable-fork-id', scenario: forkScenario }) }, fixture.env)
    const first = await request()
    const second = await request()
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect((await first.json() as { id: string }).id).toBe('stable-fork-id')
    expect((await second.json() as { id: string }).id).toBe('stable-fork-id')
    expect(await fixture.db.select().from(timelines).where(eq(timelines.worldId, 'world')).all()).toHaveLength(2)
  })

  it('enforces the active-universe limit at the database boundary for inserts and reactivation', async () => {
    await fixture.db.insert(timelines).values([
      { id: 'active-fork-a', worldId: 'world', parentTimelineId: 'main', simNow: SIM, createdAt: REAL, status: 'active' },
      { id: 'active-fork-b', worldId: 'world', parentTimelineId: 'main', simNow: SIM, createdAt: REAL, status: 'active' },
      { id: 'archived-fork', worldId: 'world', parentTimelineId: 'main', simNow: SIM, createdAt: REAL, status: 'archived' },
    ])

    expect(() => fixture.sqlite.prepare(`INSERT INTO timelines
      (id, world_id, parent_timeline_id, sim_now, created_at, status)
      VALUES ('fourth-active-fork', 'world', 'main', ?, ?, 'active')`).run(SIM, REAL))
      .toThrow('active_timeline_limit')
    expect(() => fixture.sqlite.prepare("UPDATE timelines SET status = 'active' WHERE id = 'archived-fork'").run())
      .toThrow('active_timeline_limit')
    expect((await fixture.db.select().from(timelines).where(eq(timelines.worldId, 'world')).all())
      .filter(timeline => timeline.status === 'active')).toHaveLength(3)
    expect((await fixture.db.select().from(timelines).where(eq(timelines.id, 'archived-fork')).get())?.status).toBe('archived')
  })

  it('rejects Fork from an archived source without creating child records', async () => {
    const archivedSource = await forkTimeline(fixture.db, 'world', 'main')
    await fixture.db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, archivedSource.id))
    const before = fixture.sqlite.prepare(`SELECT
      (SELECT COUNT(*) FROM timelines WHERE world_id = 'world') AS timelines,
      (SELECT COUNT(*) FROM universe_revisions) AS revisions,
      (SELECT COUNT(*) FROM world_commands) AS commands,
      (SELECT COUNT(*) FROM world_facts) AS facts`).get()
    const response = await worldsRoutes.request(`/world/timelines/${archivedSource.id}/fork`, { method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'fork-archived-source', scenario: forkScenario }),
    }, fixture.env)
    const after = fixture.sqlite.prepare(`SELECT
      (SELECT COUNT(*) FROM timelines WHERE world_id = 'world') AS timelines,
      (SELECT COUNT(*) FROM universe_revisions) AS revisions,
      (SELECT COUNT(*) FROM world_commands) AS commands,
      (SELECT COUNT(*) FROM world_facts) AS facts`).get()

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: '只能分叉活跃时间线' })
    expect(after).toEqual(before)
  })

  it('returns a retryable conflict when the database closes a concurrent active-fork race', async () => {
    fixture.sqlite.exec(`CREATE TRIGGER simulate_fork_limit_race BEFORE INSERT ON timelines
      WHEN NEW.parent_timeline_id IS NOT NULL AND NEW.status = 'active'
      BEGIN SELECT RAISE(ABORT, 'active_timeline_limit'); END`)
    const response = await worldsRoutes.request('/world/timelines/main/fork', { method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'racing-fork', scenario: forkScenario }),
    }, fixture.env)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: '活跃时间线已达上限（3 条），请先归档一条' })

    fixture.sqlite.exec('DROP TRIGGER simulate_fork_limit_race')
    fixture.sqlite.exec(`CREATE TRIGGER simulate_fork_source_race BEFORE INSERT ON timelines
      WHEN NEW.parent_timeline_id IS NOT NULL AND NEW.status = 'active'
      BEGIN SELECT RAISE(ABORT, 'fork_source_version_conflict'); END`)
    const stale = await worldsRoutes.request('/world/timelines/main/fork', { method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'stale-racing-fork', scenario: forkScenario }),
    }, fixture.env)
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: '源宇宙在创建分叉前已变化；请刷新当前状态后重试。' })
    expect(await fixture.db.select().from(timelines).where(eq(timelines.worldId, 'world')).all()).toHaveLength(1)
  })

  it('copies structured facts at the checkpoint and isolates later changes across nested forks', async () => {
    await fixture.db.update(worlds).set({ status: 'running', locationsJson: JSON.stringify([{ name: 'Cafe', description: '' }, { name: 'Library', description: '' }]) }).where(eq(worlds.id, 'world'))
    const moved = await commitWorldCommand(fixture.db, {
      id: 'root-move', worldId: 'world', timelineId: 'main', userId: 'owner', expectedVersion: 0,
      action: { type: 'move', personId: 'npc', to: 'Library' },
    })
    const changed = await commitWorldCommand(fixture.db, {
      id: 'root-intervention', worldId: 'world', timelineId: 'main', userId: 'owner', expectedVersion: 1,
      action: { type: 'intervention', requestId: 'root-rain', text: 'Rain begins.' },
    })
    const first = await forkTimeline(fixture.db, 'world', 'main')
    const firstRow = (await fixture.db.select().from(timelines).where(eq(timelines.id, first.id)).get())!
    expect(readForkSnapshot(firstRow)).toMatchObject({ sourceStateVersion: 2, worldModelVersion: 1 })
    expect((await readWorldState(fixture.db, 'world', first.id)).current.map(f => f.id)).toEqual(expect.arrayContaining([moved.factId, changed.factId]))

    await commitWorldCommand(fixture.db, {
      id: 'child-weather', worldId: 'world', timelineId: first.id, userId: 'owner', expectedVersion: 0,
      action: { type: 'environment', location: null, condition: 'weather', value: 'storm' },
    })
    expect((await readWorldState(fixture.db, 'world', 'main')).current.map(f => f.factType)).not.toContain('environment')
    const nested = await forkTimeline(fixture.db, 'world', first.id)
    const nestedState = await readWorldState(fixture.db, 'world', nested.id)
    expect(nestedState.current.map(f => f.factType).sort()).toEqual(['environment', 'intervention', 'location'])
    const comparison = await compareTimelines(fixture.db, 'world', 'main', first.id)
    expect(comparison?.differences.facts.map(f => f.key)).toEqual(['environment:world:weather'])
  })

  it('inherits only ancestor knowledge at each fork boundary across a child and grandchild', async () => {
    const rootMessage = await commitWorldCommand(fixture.db, { id: 'root-message', worldId: 'world', timelineId: 'main',
      userId: 'owner', expectedVersion: 0,
      action: { type: 'inform', recipientId: 'npc', topic: 'warning', content: 'The north road is flooded.' } })
    const child = await forkTimeline(fixture.db, 'world', 'main')
    expect(child.snapshot.sourceStateVersion).toBe(1)
    const rootLateMessage = await commitWorldCommand(fixture.db, { id: 'root-late-message', worldId: 'world', timelineId: 'main',
      userId: 'owner', expectedVersion: 1,
      action: { type: 'inform', recipientId: 'visitor', topic: 'root-only', content: 'This stays on the root.' } })
    const childMessage = await commitWorldCommand(fixture.db, { id: 'child-message', worldId: 'world', timelineId: child.id,
      userId: 'owner', expectedVersion: 0,
      action: { type: 'inform', recipientId: 'visitor', topic: 'child-only', content: 'This stays in the child.' } })
    const grandchild = await forkTimeline(fixture.db, 'world', child.id)

    const rootState = await readWorldState(fixture.db, 'world', 'main')
    const childState = await readWorldState(fixture.db, 'world', child.id)
    const grandchildState = await readWorldState(fixture.db, 'world', grandchild.id)
    const keys = (state: typeof rootState) => new Set(state.current.map(fact => `${fact.factType}:${fact.subjectId}`))
    expect(keys(rootState)).toEqual(new Set(['knowledge:npc:warning', 'knowledge:visitor:root-only']))
    expect(keys(childState)).toEqual(new Set(['knowledge:npc:warning', 'knowledge:visitor:child-only']))
    expect(keys(grandchildState)).toEqual(new Set(['knowledge:npc:warning', 'knowledge:visitor:child-only']))
    expect(grandchildState.facts.map(fact => fact.id)).toEqual(expect.arrayContaining([rootMessage.factId, childMessage.factId]))
    expect(grandchildState.facts.map(fact => fact.id)).not.toContain(rootLateMessage.factId)
    expect(rootState.facts.map(fact => fact.id)).not.toContain(childMessage.factId)
  })

  it('freezes accepted commitment facts and projections across nested fork cutoffs', async () => {
    await fixture.db.update(personStates).set({ currentDialogueId: null }).where(eq(personStates.timelineId, 'main'))
    await fixture.db.insert(commitments).values({ id: 'accepted-meeting', worldId: 'world', timelineId: 'main',
      personId: 'npc', visitorId: 'visitor', sourceDialogueId: 'scene-before-fork', title: 'Meet at the cafe',
      kind: 'meeting', location: 'Cafe', dueSim: new Date(Date.parse(SIM) + 20 * 60_000).toISOString(),
      status: 'proposed', createdSim: SIM, updatedSim: SIM, createdAt: REAL })
    await commitWorldCommand(fixture.db, { id: 'root-accept-meeting', worldId: 'world', timelineId: 'main',
      userId: 'owner', expectedVersion: 0,
      action: { type: 'commitment', commitmentId: 'accepted-meeting', next: 'accepted' } })

    const child = await forkTimeline(fixture.db, 'world', 'main')
    const childCommitment = (await fixture.db.select().from(commitments).where(eq(commitments.timelineId, child.id)).all())[0]
    expect(childCommitment).toMatchObject({ status: 'accepted', title: 'Meet at the cafe', sourceDialogueId: 'scene-before-fork' })
    const grandchild = await forkTimeline(fixture.db, 'world', child.id)
    const grandchildCommitment = (await fixture.db.select().from(commitments).where(eq(commitments.timelineId, grandchild.id)).all())[0]
    expect(grandchildCommitment).toMatchObject({ status: 'accepted', title: 'Meet at the cafe', sourceDialogueId: 'scene-before-fork' })

    await commitWorldCommand(fixture.db, { id: 'root-fulfill-meeting', worldId: 'world', timelineId: 'main',
      userId: 'owner', expectedVersion: 1,
      action: { type: 'commitment', commitmentId: 'accepted-meeting', next: 'fulfilled' } })
    const rootState = await readWorldState(fixture.db, 'world', 'main')
    const childState = await readWorldState(fixture.db, 'world', child.id)
    const grandchildState = await readWorldState(fixture.db, 'world', grandchild.id)
    const statusOf = (state: typeof rootState) => state.current.find(fact => fact.factType === 'commitment')?.value
    expect(statusOf(rootState)).toMatchObject({ to: 'fulfilled' })
    expect(statusOf(childState)).toMatchObject({ to: 'accepted' })
    expect(statusOf(grandchildState)).toMatchObject({ to: 'accepted' })
    expect((await fixture.db.select().from(commitments).where(eq(commitments.timelineId, child.id)).all())[0].status).toBe('accepted')
    expect((await fixture.db.select().from(commitments).where(eq(commitments.timelineId, grandchild.id)).all())[0].status).toBe('accepted')
    const comparison = await compareTimelines(fixture.db, 'world', 'main', child.id)
    expect(comparison?.differences.facts.map(fact => fact.key)).toContain('commitment:accepted-meeting')
  })

  it('freezes nested fork memories and events at each branch checkpoint', async () => {
    const child = await forkTimeline(fixture.db, 'world', 'main')
    await fixture.db.insert(memories).values([
      { id: 'root-memory-after-child-fork', personId: 'npc', timelineId: 'main', type: 'thought',
        content: 'The root learned this later.', createdAt: '2099-01-01T00:00:00.000Z', simTime: SIM },
      { id: 'child-memory-before-grandchild-fork', personId: 'npc', timelineId: child.id, type: 'thought',
        content: 'The child learned this before its fork.', createdAt: '2026-09-19T10:00:00.000Z', simTime: SIM },
    ])
    await fixture.db.insert(events).values([
      { id: 'root-event-after-child-fork', timelineId: 'main', simTime: SIM, title: 'Later root event', description: 'Only the root observes this.' },
      { id: 'child-event-before-grandchild-fork', timelineId: child.id, simTime: SIM, title: 'Child event', description: 'The child observes this before forking.' },
    ])

    const grandchild = await forkTimeline(fixture.db, 'world', child.id)
    const row = (await fixture.db.select().from(timelines).where(eq(timelines.id, grandchild.id)).get())!
    const snapshot = readForkSnapshot(row)!
    const visible = await visibleMemories(fixture.db, 'npc', row)

    expect(snapshot.memories.map(memory => memory.id)).toContain('remembered')
    expect(snapshot.memories.map(memory => memory.id)).toContain('child-memory-before-grandchild-fork')
    expect(snapshot.memories.map(memory => memory.id)).not.toContain('root-memory-after-child-fork')
    expect(visible.map(memory => memory.id)).toContain('child-memory-before-grandchild-fork')
    expect(snapshot.events.map(event => event.id)).toContain('original')
    expect(snapshot.events.map(event => event.id)).toContain('child-event-before-grandchild-fork')
    expect(snapshot.events.map(event => event.id)).not.toContain('root-event-after-child-fork')
  })

  it('pins world locations and resident models in a child even if shared asset rows change', async () => {
    await fixture.db.update(worlds).set({ locationsJson: JSON.stringify([{ name: 'Cafe', description: 'Original' }]) }).where(eq(worlds.id, 'world'))
    await fixture.db.update(persons).set({ modelJson: JSON.stringify({ identity: [{ text: 'Original', provenance: 'known' }] }) }).where(eq(persons.id, 'npc'))
    const child = await forkTimeline(fixture.db, 'world', 'main')
    await fixture.db.update(worlds).set({ locationsJson: JSON.stringify([{ name: 'New Place', description: 'Changed' }]) }).where(eq(worlds.id, 'world'))
    await fixture.db.update(persons).set({ modelJson: JSON.stringify({ identity: [{ text: 'Changed', provenance: 'known' }] }) }).where(eq(persons.id, 'npc'))
    const snap = await buildWorldSnapshot(fixture.db, 'world', child.id)
    expect(snap?.locations).toEqual([{ name: 'Cafe', description: 'Original' }])
    expect(snap?.models.get('npc')?.identity[0].text).toBe('Original')
  })

  it('makes fork provenance immutable while leaving ordinary timeline lifecycle updates available', async () => {
    const scenario = { whatIf: 'Carry the letter', startTime: SIM, changedVariable: 'letter_delivery', participants: ['npc'], invariants: ['The town remains isolated'] }
    const child = await forkTimeline(fixture.db, 'world', 'main', scenario)
    const row = (await fixture.db.select().from(timelines).where(eq(timelines.id, child.id)).get())!
    const sqlite = fixture.sqlite
    expect(() => sqlite.prepare('UPDATE timelines SET fork_snapshot_json = ? WHERE id = ?').run('{}', child.id))
      .toThrow('fork_provenance_immutable')
    expect(() => sqlite.prepare('UPDATE timelines SET fork_scenario_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...scenario, whatIf: 'Change history' }), child.id)).toThrow('fork_provenance_immutable')
    expect(() => sqlite.prepare('UPDATE timelines SET parent_timeline_id = NULL WHERE id = ?').run(child.id))
      .toThrow('fork_provenance_immutable')
    expect(() => sqlite.prepare('UPDATE timelines SET ancestor_ids_json = ? WHERE id = ?').run('[]', child.id))
      .toThrow('fork_provenance_immutable')
    expect(() => sqlite.prepare('UPDATE timelines SET parent_timeline_id = ? WHERE id = ?').run(child.id, 'main'))
      .toThrow('fork_provenance_immutable')
    await fixture.db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, child.id))
    const unchanged = (await fixture.db.select().from(timelines).where(eq(timelines.id, child.id)).get())!
    expect(unchanged.status).toBe('archived')
    expect(unchanged.parentTimelineId).toBe('main')
    expect(unchanged.forkSnapshotJson).toBe(row.forkSnapshotJson)
  })

  it('does not import ambiguous legacy NULL memories when one person is reused by another world', async () => {
    await fixture.db.insert(worldPersons).values({ worldId: 'other-world', personId: 'npc', joinedAt: REAL })
    await fixture.db.insert(memories).values({ id: 'ambiguous', personId: 'npc', timelineId: null,
      type: 'relationship', content: 'A secret from an unknown world', createdAt: REAL })
    const main = (await fixture.db.select().from(timelines).where(eq(timelines.id, 'main')).get())!
    expect((await visibleMemories(fixture.db, 'npc', main)).map(m => m.id)).not.toContain('ambiguous')
    const child = await forkTimeline(fixture.db, 'world', 'main')
    expect(child.snapshot.memories.map(m => m.id)).not.toContain('ambiguous')
    expect(child.snapshot.memories.map(m => m.id)).toContain('remembered')
  })

  it('keeps a reused resident’s state, knowledge, and relationship memories inside each world', async () => {
    await fixture.db.insert(worldPersons).values({ worldId: 'other-world', personId: 'npc', joinedAt: REAL })
    await fixture.db.insert(personStates).values({
      personId: 'npc', timelineId: 'other-main', simTime: SIM, location: 'Harbor', activity: 'Waiting', mood: 'Calm',
      goal: 'Watch the boats', updatedRealAt: REAL,
    })
    await fixture.db.insert(memories).values([
      { id: 'world-a-relationship', personId: 'npc', timelineId: 'main', type: 'relationship', content: 'Visitor betrayed me at the Cafe', createdAt: REAL },
      { id: 'world-b-relationship', personId: 'npc', timelineId: 'other-main', type: 'relationship', content: 'Visitor helped me at the Harbor', createdAt: REAL },
    ])
    const informed = await commitWorldCommand(fixture.db, { id: 'world-a-secret', worldId: 'world', timelineId: 'main',
      userId: 'owner', expectedVersion: 0,
      action: { type: 'inform', recipientId: 'npc', topic: 'private warning', content: 'The old bridge is unsafe.' } })

    const worldASnapshot = await buildWorldSnapshot(fixture.db, 'world', 'main')
    const worldBSnapshot = await buildWorldSnapshot(fixture.db, 'other-world', 'other-main')
    expect(worldASnapshot).not.toBeNull()
    expect(worldBSnapshot).not.toBeNull()
    const worldAContext = await buildEngineContext(fixture.db, 'npc', worldASnapshot!)
    const worldBContext = await buildEngineContext(fixture.db, 'npc', worldBSnapshot!)

    expect(worldAContext?.state.location).toBe('Cafe')
    expect(worldAContext?.knownFacts?.map(f => f.sourceFactId)).toContain(informed.factId)
    expect(worldAContext?.memories.map(m => m.id)).toContain('world-a-relationship')
    expect(worldAContext?.memories.map(m => m.id)).not.toContain('world-b-relationship')
    expect(worldBContext?.state.location).toBe('Harbor')
    expect(worldBContext?.state.goal).toBe('Watch the boats')
    expect(worldBContext?.knownFacts?.map(f => f.sourceFactId)).not.toContain(informed.factId)
    expect(worldBContext?.memories.map(m => m.id)).toContain('world-b-relationship')
    expect(worldBContext?.memories.map(m => m.id)).not.toContain('world-a-relationship')
  })

  it('copies every person and goal, current/future schedules and open commitments with stable references', async () => {
    await fixture.db.insert(schedules).values(['2026-09-18', '2026-09-19', '2026-09-20'].map((worldDate) => ({
      personId: 'npc', timelineId: 'main', worldDate, itemsJson: '[{"activity":"Read"}]', generatedAt: REAL,
    })))
    await fixture.db.insert(commitments).values(['proposed', 'accepted', 'fulfilled', 'missed'].map((status) => ({
      id: status, worldId: 'world', timelineId: 'main', personId: 'npc', visitorId: 'visitor', sourceDialogueId: 'dialogue-ref',
      title: 'Meet', location: 'Cafe', dueSim: SIM, status, createdSim: REAL, updatedSim: REAL, createdAt: REAL,
    })))
    const response = await worldsRoutes.request('/world/timelines/main/fork', { method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: forkScenario }),
    }, fixture.env)
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
    await fixture.db.insert(dialogues).values({ id: 'root-dialogue', timelineId: 'main', location: 'Cafe',
      participantIdsJson: JSON.stringify(['npc', 'visitor']), status: 'ended', turnLimit: 8,
      simStart: REAL, simEnd: SIM, kind: 'npc' })
    await fixture.db.insert(dialogueTurns).values({ id: 'root-turn-before-fork', dialogueId: 'root-dialogue', turnIndex: 0,
      personId: 'npc', utterance: 'We should keep this between us.', thought: 'I trust them.', simTime: REAL, createdAt: REAL })
    await fixture.db.insert(events).values({ id: 'root-dialogue-event', timelineId: 'main', simTime: REAL,
      title: 'A private conversation', description: 'Two residents spoke.', kind: 'dialogue', dialogueId: 'root-dialogue' })
    const first = await forkTimeline(fixture.db, 'world', 'main')
    await fixture.db.update(memories).set({ summarized: true, content: 'Later rewrite' }).where(eq(memories.id, 'remembered'))
    await fixture.db.insert(memories).values({ id: 'root-late', personId: 'npc', timelineId: 'main', type: 'world', content: 'Backdated but inserted after fork', simTime: REAL, createdAt: REAL })
    await fixture.db.insert(events).values({ id: 'root-late-event', timelineId: 'main', simTime: REAL, title: 'Later insert', description: '' })
    await fixture.db.insert(dialogueTurns).values({ id: 'root-turn-after-fork', dialogueId: 'root-dialogue', turnIndex: 1,
      personId: 'visitor', utterance: 'Now I will change the story.', thought: 'Only in the source line.', simTime: REAL, createdAt: '2099-01-01T00:00:00.000Z' })
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
    const focus = await personFocus(fixture.db, 'world', 'npc', child.id)
    expect(focus?.memories.map((memory) => memory.id).sort()).toEqual(['branch-memory', 'remembered'])
    expect(focus?.memories.map((memory) => memory.id)).not.toContain('parent-late')
    const snapshot = await worldSnapshot(fixture.db, 'world', child.id)
    expect(snapshot?.events.map((event) => event.id)).toEqual(['original', 'root-dialogue-event', 'branch-before'])
    expect(snapshot?.events.map((event) => event.id)).not.toContain('parent-late-event')
    expect(snapshot?.events.find(event => event.id === 'root-dialogue-event')?.dialoguePreview)
      .toEqual([{ personName: 'npc', utterance: 'We should keep this between us.' }])
    const detail = await dialogueDetail(fixture.db, 'root-dialogue', child.id)
    expect(detail?.turns.map(turn => turn.utterance)).toEqual(['We should keep this between us.'])
    expect(await dialogueDetail(fixture.db, 'root-dialogue', first.id)).toMatchObject({
      turns: [{ utterance: 'We should keep this between us.' }],
    })
    expect(await dialogueDetail(fixture.db, 'root-dialogue', 'main')).toMatchObject({
      turns: [{ utterance: 'We should keep this between us.' }, { utterance: 'Now I will change the story.' }],
    })
    const result = await compareTimelines(fixture.db, 'world', first.id, second.id)
    expect(result?.sharedForkOrigin?.timelineId).toBe(first.id)
    expect(result?.differences.events.shared.map((e) => e.id)).toEqual(['original', 'root-dialogue-event', 'branch-before'])
    expect(result?.differences.events.leftOnly.map((e) => e.id)).toEqual(['parent-late-event'])
    expect(result?.differences.events.rightOnly).toEqual([])
  })

  it('freezes persona messages across root, child, and grandchild checkpoint boundaries', async () => {
    const insertMessage = (id: string, timelineId: string) => fixture.db.insert(personaMessages).values({
      id, worldId: 'world', timelineId, senderPersonId: 'npc', recipientPersonId: 'visitor',
      content: id, location: 'Cafe', simTime: SIM, createdAt: REAL,
    })
    await insertMessage('root-before', 'main')
    const child = await forkTimeline(fixture.db, 'world', 'main')
    await insertMessage('root-after', 'main')
    await insertMessage('child-before', child.id)
    const grandchild = await forkTimeline(fixture.db, 'world', child.id)

    const childSnapshot = readForkSnapshot((await fixture.db.select().from(timelines).where(eq(timelines.id, child.id)).get())!)!
    const grandchildSnapshot = readForkSnapshot((await fixture.db.select().from(timelines).where(eq(timelines.id, grandchild.id)).get())!)!
    expect(childSnapshot.personaMessages?.map(message => message.id)).toEqual(['root-before'])
    expect(grandchildSnapshot.personaMessages?.map(message => message.id)).toEqual(['root-before', 'child-before'])
    expect(grandchildSnapshot.personaMessages?.map(message => message.id)).not.toContain('root-after')
  })

  it('rolls back all child rows if a copied schedule cannot be written', async () => {
    await fixture.db.insert(schedules).values({ personId: 'npc', timelineId: 'main', worldDate: '2026-09-19', itemsJson: '[]', generatedAt: REAL })
    fixture.sqlite.exec("CREATE TRIGGER fail_fork_schedule BEFORE INSERT ON schedules WHEN NEW.timeline_id <> 'main' BEGIN SELECT RAISE(ABORT, 'test copy failure'); END")
    await expect(forkTimeline(fixture.db, 'world', 'main')).rejects.toThrow()
    expect(await fixture.db.select().from(timelines).where(eq(timelines.worldId, 'world')).all()).toHaveLength(1)
    expect(await fixture.db.select().from(personStates).all()).toHaveLength(2)
  })

  it('rejects a stale checkpoint even when a legacy state writer changed no revision', async () => {
    const first = await forkTimeline(fixture.db, 'world', 'main')
    await fixture.db.update(personStates).set({ location: 'Library' }).where(and(eq(personStates.timelineId, 'main'), eq(personStates.personId, 'npc')))
    let failure: unknown
    try {
      await fixture.db.insert(timelines).values({ id: 'stale-child', worldId: 'world', parentTimelineId: 'main',
        forkSnapshotJson: JSON.stringify(first.snapshot), simNow: SIM, createdAt: REAL, status: 'active' })
    } catch (error) { failure = error }
    expect((failure as { cause?: Error }).cause?.message).toContain('fork_source_state_conflict')
    expect(await fixture.db.select().from(timelines).where(eq(timelines.id, 'stale-child')).get()).toBeUndefined()
  })

  it('rejects a fork checkpoint when the source revision advances after snapshot capture', async () => {
    const captured = await forkTimeline(fixture.db, 'world', 'main')
    await commitWorldCommand(fixture.db, { id: 'source-advanced', worldId: 'world', timelineId: 'main', userId: 'owner', expectedVersion: 0,
      action: { type: 'environment', location: null, condition: 'weather', value: 'rain' } })
    let failure: unknown
    try {
      await fixture.db.insert(timelines).values({ id: 'stale-version-child', worldId: 'world', parentTimelineId: 'main',
        forkSnapshotJson: JSON.stringify(captured.snapshot), simNow: SIM, createdAt: REAL, status: 'active' })
    } catch (error) { failure = error }
    expect((failure as { cause?: Error }).cause?.message).toContain('fork_source_version_conflict')
    expect(await fixture.db.select().from(timelines).where(eq(timelines.id, 'stale-version-child')).get()).toBeUndefined()
  })

  it('rejects a fork checkpoint if a current/future source schedule appears after snapshot capture', async () => {
    const captured = await forkTimeline(fixture.db, 'world', 'main')
    await fixture.db.insert(schedules).values({ personId: 'npc', timelineId: 'main', worldDate: SIM.slice(0, 10),
      itemsJson: JSON.stringify([{ start: '09:00', end: '10:00', location: 'Cafe', activity: 'Read' }]), generatedAt: REAL })
    let failure: unknown
    try {
      await fixture.db.insert(timelines).values({ id: 'stale-schedule-child', worldId: 'world', parentTimelineId: 'main',
        forkSnapshotJson: JSON.stringify(captured.snapshot), simNow: SIM, createdAt: REAL, status: 'active' })
    } catch (error) { failure = error }
    expect((failure as { cause?: Error }).cause?.message).toContain('fork_source_schedule_conflict')
    expect(await fixture.db.select().from(timelines).where(eq(timelines.id, 'stale-schedule-child')).get()).toBeUndefined()
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
    expect(result?.limitations).toHaveLength(3)
    expect(result?.limitations.some(x => x.includes('missing facts'))).toBe(true)
  })
})
