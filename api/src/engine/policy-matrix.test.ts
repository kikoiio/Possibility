import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { commitments, llmCallLog, memories, persons, personStates, timelines, universeEvidence, universeRevisions,
  sessions, worldCommands, worldFacts, worldPersons, worlds } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { budgetFromEnv } from './budget'
import { INTERNAL_ENGINE_CALL_PURPOSES, worldReservation } from './guard'
import { runTick } from './tick'

type Fixture = Awaited<ReturnType<typeof createWorldFixture>>
let fixture: Fixture | null = null
afterEach(() => { vi.unstubAllGlobals(); fixture?.close(); fixture = null })

async function universeSnapshot(f: Fixture) {
  return {
    timeline: await f.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get(),
    revisions: await f.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).all(),
    commands: await f.db.select().from(worldCommands).where(eq(worldCommands.timelineId, 'home-main')).all(),
    facts: await f.db.select().from(worldFacts).where(eq(worldFacts.timelineId, 'home-main')).all(),
    states: await f.db.select().from(personStates).where(eq(personStates.timelineId, 'home-main')).all(),
  }
}

type MatrixCase = {
  name: string
  timelineId?: string
  prepare(f: Fixture): Promise<void>
}

const cases: MatrixCase[] = [
  { name: 'missing evidence', prepare: async f => {
    await f.db.delete(universeEvidence).where(eq(universeEvidence.timelineId, 'home-main'))
  } },
  { name: 'unassessed evidence', prepare: async f => {
    await f.db.update(universeEvidence).set({ level: 'unassessed', baselineVersion: null,
      reasonCodesJson: '["not_assessed"]' }).where(eq(universeEvidence.timelineId, 'home-main'))
  } },
  { name: 'upgradeable evidence', prepare: async f => {
    await f.db.update(universeEvidence).set({ level: 'upgradeable', baselineVersion: null,
      reasonCodesJson: '["upgrade_required"]' }).where(eq(universeEvidence.timelineId, 'home-main'))
  } },
  { name: 'incomplete evidence', prepare: async f => {
    await f.db.update(universeEvidence).set({ level: 'incomplete', baselineVersion: null,
      reasonCodesJson: '["missing_baseline"]' }).where(eq(universeEvidence.timelineId, 'home-main'))
  } },
  { name: 'paused world', prepare: async f => {
    await markComplete(f)
    await f.db.update(worlds).set({ status: 'paused', pauseReason: 'manual' }).where(eq(worlds.id, 'home-world'))
  } },
  { name: 'capped world', prepare: async f => {
    await markComplete(f)
    await f.db.update(worlds).set({ status: 'capped', pauseReason: 'test_cap' }).where(eq(worlds.id, 'home-world'))
  } },
  { name: 'archived world', prepare: async f => {
    await markComplete(f)
    await f.db.update(worlds).set({ status: 'archived', pauseReason: 'manual' }).where(eq(worlds.id, 'home-world'))
  } },
  { name: 'archived timeline', prepare: async f => {
    await markComplete(f)
    await f.db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, 'home-main'))
  } },
  { name: 'timeline belonging to another world', timelineId: 'other-main', prepare: async f => {
    await markComplete(f)
    // Keep tick itself inert while the reservation half of this case exercises
    // the cross-world timeline reference.
    await f.db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, 'home-main'))
  } },
]

async function markComplete(f: Fixture) {
  await f.db.insert(universeEvidence).values({ timelineId: 'home-main', level: 'complete', assessedVersion: 0,
    baselineVersion: 0, reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME }).onConflictDoNothing()
}

describe('internal engine policy matrix', () => {
  it('keeps the autonomous entry inventory explicit', () => {
    expect(INTERNAL_ENGINE_CALL_PURPOSES).toEqual([
      'director', 'schedule', 'beat', 'dialogue_turn', 'injection', 'summary', 'voxel_distill',
    ])
  })

  for (const entry of cases) {
    it(`rejects tick and every autonomous model entry for ${entry.name} with zero side effects`, async () => {
      fixture = await createWorldFixture()
      await entry.prepare(fixture)
      const before = await universeSnapshot(fixture)
      const fetchSpy = vi.fn(async () => new Response('unexpected provider call', { status: 500 }))
      vi.stubGlobal('fetch', fetchSpy)
      const cfg = budgetFromEnv(fixture.env)

      for (const purpose of INTERNAL_ENGINE_CALL_PURPOSES) {
        const reserve = worldReservation(fixture.db, 'home-world', cfg, {
          timelineId: entry.timelineId ?? 'home-main', personId: purpose === 'director' ? null : 'resident', purpose,
        })
        await expect(reserve({ contextHash: 'a'.repeat(64), contractVersion: `${purpose}/test` }))
          .rejects.toMatchObject({ name: 'BudgetRefusal' })
      }

      await runTick({ ...fixture.env, DIRECTOR_LLM: '1' }, fixture.db)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(await fixture.db.select().from(llmCallLog).where(eq(llmCallLog.worldId, 'home-world')).all()).toEqual([])
      expect(await universeSnapshot(fixture)).toEqual(before)
    })
  }
})

describe('management write policy matrix', () => {
  const MANAGEMENT_OPERATIONS = [
    'world.pause', 'world.resume', 'world.archive', 'timeline.archive', 'timeline.reactivate',
  ] as const

  it('keeps the lifecycle and safe-freeze inventory explicit', () => {
    expect(MANAGEMENT_OPERATIONS).toEqual([
      'world.pause', 'world.resume', 'world.archive', 'timeline.archive', 'timeline.reactivate',
    ])
  })

  it('rejects another owner from world and timeline lifecycle controls without changing state', async () => {
    fixture = await createWorldFixture()
    await fixture.db.insert(sessions).values({ token: 'other-token', userId: 'other', expiresAt: '2099-01-01T00:00:00.000Z' })
    const before = {
      world: await fixture.db.select().from(worlds).where(eq(worlds.id, 'home-world')).get(),
      timeline: await fixture.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get(),
      commands: await fixture.db.select().from(worldCommands),
      facts: await fixture.db.select().from(worldFacts),
      revisions: await fixture.db.select().from(universeRevisions),
    }
    const headers = { Authorization: 'Bearer other-token', 'Content-Type': 'application/json' }
    const call = (path: string) => app.request(path, { method: 'POST', headers }, fixture!.env)
    const results = await Promise.all([
      call('/api/worlds/home-world/pause'), call('/api/worlds/home-world/resume'),
      call('/api/worlds/home-world/archive'), call('/api/timelines/home-main/archive'),
      call('/api/timelines/home-main/reactivate'),
    ])
    expect(results.map(result => result.status)).toEqual([404, 404, 404, 404, 404])
    expect({
      world: await fixture.db.select().from(worlds).where(eq(worlds.id, 'home-world')).get(),
      timeline: await fixture.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get(),
      commands: await fixture.db.select().from(worldCommands),
      facts: await fixture.db.select().from(worldFacts),
      revisions: await fixture.db.select().from(universeRevisions),
    }).toEqual(before)
  })

  it('allows only safe freezes for incomplete history and rejects resume, reactivate, persona, memory, and commitment writes', async () => {
    fixture = await createWorldFixture()
    await fixture.db.update(universeEvidence).set({ level: 'incomplete', baselineVersion: null,
      reasonCodesJson: '["missing_baseline"]' }).where(eq(universeEvidence.timelineId, 'home-main'))
    await fixture.db.insert(timelines).values({ id: 'home-child', worldId: 'home-world', parentTimelineId: 'home-main',
      simNow: WORLD_TIME, createdAt: WORLD_TIME })
    const modelJson = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [],
      relationships: [], boundaries: [], unknowns: [] })
    await fixture.db.insert(persons).values([
      { id: 'policy-resident', userId: 'owner', name: 'Resident', modelJson, createdAt: WORLD_TIME },
      { id: 'policy-visitor', userId: 'owner', name: 'Visitor', modelJson, isUser: true, createdAt: WORLD_TIME },
    ])
    await fixture.db.insert(worldPersons).values(['policy-resident', 'policy-visitor'].map(personId => ({
      worldId: 'home-world', personId, joinedAt: WORLD_TIME,
    })))
    await fixture.db.insert(memories).values({ id: 'policy-memory', personId: 'policy-resident', timelineId: 'home-main',
      type: 'thought', content: 'Original memory', importance: 5, simTime: WORLD_TIME, createdAt: WORLD_TIME })
    await fixture.db.insert(commitments).values({ id: 'policy-commitment', worldId: 'home-world', timelineId: 'home-main',
      personId: 'policy-resident', visitorId: 'policy-visitor', title: 'Meet later', kind: 'meeting', location: 'Cafe',
      dueSim: '2026-09-21T10:00:00.000Z', status: 'proposed', createdSim: WORLD_TIME, updatedSim: WORLD_TIME,
      createdAt: WORLD_TIME })
    const auth = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
    const call = (path: string, body?: unknown, method = 'POST') => app.request(path, {
      method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, fixture!.env)
    const before = await universeSnapshot(fixture)

    const persona = await call('/api/worlds/home-world/persona', { name: 'Updated Visitor', description: 'Should not write.' })
    const memory = await call('/api/memories/policy-memory', { content: 'Changed', personId: 'policy-resident',
      timelineId: 'home-main', expectedVersion: 0, commandId: 'blocked-memory', before: {
        type: 'thought', content: 'Original memory', importance: 5, simTime: WORLD_TIME, createdAt: WORLD_TIME,
        summarized: false,
      } }, 'PATCH')
    const commitment = await call('/api/worlds/home-world/commitments/policy-commitment', { action: 'accept' })
    expect([persona.status, memory.status, commitment.status]).toEqual([409, 409, 409])
    expect(await universeSnapshot(fixture)).toEqual(before)
    expect((await fixture.db.select().from(memories).where(eq(memories.id, 'policy-memory')).get())?.content)
      .toBe('Original memory')
    expect((await fixture.db.select().from(commitments).where(eq(commitments.id, 'policy-commitment')).get())?.status)
      .toBe('proposed')

    expect((await call('/api/worlds/home-world/pause')).status).toBe(200)
    expect((await call('/api/worlds/home-world/resume')).status).toBe(409)
    expect((await call('/api/worlds/home-world/archive')).status).toBe(200)
    expect((await call('/api/timelines/home-main/archive')).status).toBe(200)
    expect((await call('/api/timelines/home-main/reactivate')).status).toBe(409)
    expect(await fixture.db.select().from(worldCommands)).toEqual([])
    expect(await fixture.db.select().from(worldFacts)).toEqual([])
    expect(await fixture.db.select().from(llmCallLog)).toEqual([])
    expect(await fixture.db.select().from(universeRevisions)).toEqual([])
    expect(await fixture.db.select().from(worlds).where(eq(worlds.id, 'home-world')).get())
      .toMatchObject({ status: 'archived' })
    expect(await fixture.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())
      .toMatchObject({ status: 'archived' })
  })

  for (const level of ['missing', 'unassessed', 'upgradeable', 'incomplete', 'complete'] as const) {
    it(`allows world resume only when every active timeline has complete evidence (${level})`, async () => {
      fixture = await createWorldFixture()
      await fixture.db.update(worlds).set({ status: 'paused', pauseReason: 'manual' }).where(eq(worlds.id, 'home-world'))
      if (level === 'missing') await fixture.db.delete(universeEvidence).where(eq(universeEvidence.timelineId, 'home-main'))
      else await fixture.db.update(universeEvidence).set({ level, baselineVersion: level === 'complete' ? 0 : null,
        reasonCodesJson: JSON.stringify([`matrix_${level}`]) }).where(eq(universeEvidence.timelineId, 'home-main'))
      const before = await universeSnapshot(fixture)
      const response = await app.request('/api/worlds/home-world/resume', {
        method: 'POST', headers: { Authorization: 'Bearer owner-token' },
      }, fixture.env)
      expect(response.status).toBe(level === 'complete' ? 200 : 409)
      expect((await fixture.db.select().from(worlds).where(eq(worlds.id, 'home-world')).get())?.status)
        .toBe(level === 'complete' ? 'running' : 'paused')
      const after = await universeSnapshot(fixture)
      expect({ ...after, timeline: before.timeline }).toMatchObject({
        revisions: before.revisions, commands: before.commands, facts: before.facts, states: before.states,
      })
    })

    it(`allows timeline reactivation only with complete immutable evidence (${level})`, async () => {
      fixture = await createWorldFixture()
      await fixture.db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, 'home-main'))
      if (level === 'missing') await fixture.db.delete(universeEvidence).where(eq(universeEvidence.timelineId, 'home-main'))
      else await fixture.db.update(universeEvidence).set({ level, baselineVersion: level === 'complete' ? 0 : null,
        reasonCodesJson: JSON.stringify([`matrix_${level}`]) }).where(eq(universeEvidence.timelineId, 'home-main'))
      const before = await universeSnapshot(fixture)
      const response = await app.request('/api/timelines/home-main/reactivate', {
        method: 'POST', headers: { Authorization: 'Bearer owner-token' },
      }, fixture.env)
      expect(response.status).toBe(level === 'complete' ? 200 : 409)
      expect((await fixture.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())?.status)
        .toBe(level === 'complete' ? 'active' : 'archived')
      const after = await universeSnapshot(fixture)
      expect({ revisions: after.revisions, commands: after.commands, facts: after.facts, states: after.states })
        .toEqual({ revisions: before.revisions, commands: before.commands, facts: before.facts, states: before.states })
    })
  }

  it('keeps pause, world archive, and timeline archive available as history-free safety operations', async () => {
    fixture = await createWorldFixture()
    await fixture.db.update(universeEvidence).set({ level: 'incomplete', baselineVersion: null,
      reasonCodesJson: '["missing_checkpoint"]' }).where(eq(universeEvidence.timelineId, 'home-main'))
    await fixture.db.insert(timelines).values({ id: 'home-sibling', worldId: 'home-world', simNow: WORLD_TIME,
      createdAt: WORLD_TIME })
    const before = await universeSnapshot(fixture)
    const auth = { Authorization: 'Bearer owner-token' }
    expect((await app.request('/api/worlds/home-world/pause', { method: 'POST', headers: auth }, fixture.env)).status).toBe(200)
    expect((await app.request('/api/worlds/home-world/archive', { method: 'POST', headers: auth }, fixture.env)).status).toBe(200)
    expect((await app.request('/api/timelines/home-main/archive', { method: 'POST', headers: auth }, fixture.env)).status).toBe(200)
    expect(await fixture.db.select().from(worldCommands)).toEqual(before.commands)
    expect(await fixture.db.select().from(worldFacts)).toEqual(before.facts)
    expect(await fixture.db.select().from(universeRevisions)).toEqual(before.revisions)
    expect((await fixture.db.select().from(worlds).where(eq(worlds.id, 'home-world')).get())?.status).toBe('archived')
    expect((await fixture.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())?.status).toBe('archived')
  })
})
