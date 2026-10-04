import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import app from '../index'
import { createTestDb } from './db'
import { demoSandboxes, events, forkSnapshots, guestSessions, persons, personStates, sessions, timelines, users, worldPersons, worlds } from '../db/schema'
import { seedDemoWorld } from '../dev/seed-demo'
import { createGuestSession } from '../demo/session-service'
import { cloneWorldGraph } from '../demo/world-graph-cloner'

describe('S03 guest participation API', () => {
  it('allows a guest to register, enter and move only inside its sandbox', async () => {
    const fixture = createTestDb()
    await fixture.db.insert(users).values({ id: 'admin', username: 'admin', passwordHash: 'x', createdAt: new Date().toISOString() })
    await seedDemoWorld(fixture.db)
    const guest = await createGuestSession(fixture.db, 'guest-participation')
    const headers = { 'X-Possibility-Guest': guest.token!, 'Content-Type': 'application/json' }
    const personaResponse = await app.request(`/api/worlds/${guest.worldId}/persona?timelineId=${guest.timelineId}`, { headers }, fixture.env)
    expect(personaResponse.status, await personaResponse.clone().text()).toBe(200)
    const stateResponse = await app.request(`/api/worlds/${guest.worldId}/state?timelineId=${guest.timelineId}`, { headers }, fixture.env)
    expect(stateResponse.status).toBe(200)
    const state = await stateResponse.json() as { version: number }
    const moved = await app.request(`/api/worlds/${guest.worldId}/scene/position`, {
      method: 'POST', headers,
      body: JSON.stringify({ timelineId: guest.timelineId, location: '温室花房', commandId: 'guest-enter-greenhouse', expectedVersion: state.version }),
    }, fixture.env)
    expect(moved.status).toBe(200)
    expect(await moved.json()).toMatchObject({ location: '温室花房', version: state.version + 1 })

    const otherWorld = await app.request('/api/worlds/not-this-sandbox/state?timelineId=elsewhere', { headers }, fixture.env)
    expect(otherWorld.status).toBe(404)
    const forbidden = await app.request(`/api/worlds/${guest.worldId}/pause`, { method: 'POST', headers }, fixture.env)
    expect(forbidden.status).toBe(404)
    fixture.close()
  })

  it('claims the active guest sandbox into the authenticated user account', async () => {
    const fixture = createTestDb()
    await fixture.db.insert(users).values({ id: 'admin', username: 'admin', passwordHash: 'x', createdAt: new Date().toISOString() })
    await fixture.db.insert(users).values([
      { id: 'member', username: 'member', passwordHash: 'x', createdAt: new Date().toISOString() },
      { id: 'other-member', username: 'other-member', passwordHash: 'x', createdAt: new Date().toISOString() },
    ])
    await fixture.db.insert(sessions).values([
      { token: 'member-token', userId: 'member', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      { token: 'other-member-token', userId: 'other-member', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    ])
    const baseline = await seedDemoWorld(fixture.db)
    const priorWorld = await cloneWorldGraph(fixture.db, {
      sourceWorldId: baseline.worldId, targetOwnerId: 'member', requestId: 'existing-account-world', name: '账号已有世界',
    })
    const priorWorldIds = (await fixture.db.select({ id: worlds.id }).from(worlds).where(eq(worlds.userId, 'member')).all()).map(row => row.id)
    const guest = await createGuestSession(fixture.db, 'guest-claim-api')
    const participation = await app.request(`/api/worlds/${guest.worldId}/scene/position`, {
      method: 'POST',
      headers: { 'X-Possibility-Guest': guest.token!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timelineId: guest.timelineId, location: '温室花房', commandId: 'claim-api-move', expectedVersion: 0 }),
    }, fixture.env)
    expect(participation.status, await participation.clone().text()).toBe(200)

    const forkResponse = await app.request(`/api/demo/worlds/${guest.worldId}/fork`, {
      method: 'POST',
      headers: { 'X-Possibility-Guest': guest.token!, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timelineId: guest.timelineId, requestId: 'claim-api-fork',
        name: '提前抵达', whatIf: '访客提前到达花房', changedVariable: '抵达时间',
      }),
    }, fixture.env)
    expect(forkResponse.status, await forkResponse.clone().text()).toBe(200)
    const fork = await forkResponse.json() as { id: string }
    const sourceVisitor = await fixture.db.select({ personId: worldPersons.personId }).from(worldPersons)
      .innerJoin(persons, eq(worldPersons.personId, persons.id))
      .where(and(eq(worldPersons.worldId, guest.worldId), eq(persons.isUser, true))).get()
    await fixture.db.insert(events).values({
      id: 'claim-api-event', timelineId: guest.timelineId, simTime: '2026-10-02T00:00:00.000Z',
      title: '访客抵达花房', description: '访客留下了一条可追溯的事件。', actorPersonId: sourceVisitor!.personId,
    })

    const claim = () => app.request('/api/demo/session/claim', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer member-token',
        'X-Possibility-Guest': guest.token!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requestId: 'claim-api-request' }),
    }, fixture.env)
    const response = await claim()
    expect(response.status, await response.clone().text()).toBe(200)
    const result = await response.json() as { kind: string; worldId: string; replayed: boolean }
    expect(result).toMatchObject({ kind: 'claimed', replayed: false })
    const replay = await claim()
    expect(replay.status, await replay.clone().text()).toBe(200)
    expect(await replay.json()).toEqual({ ...result, replayed: true })

    const otherAccountClaim = await app.request('/api/demo/session/claim', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer other-member-token',
        'X-Possibility-Guest': guest.token!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requestId: 'other-account-retry' }),
    }, fixture.env)
    expect(otherAccountClaim.status).toBe(409)
    const conflict = await otherAccountClaim.json() as Record<string, unknown>
    expect(conflict).toMatchObject({ code: 'already_claimed_elsewhere' })
    expect(conflict).not.toHaveProperty('worldId')

    expect(await fixture.db.select().from(worlds).where(eq(worlds.id, result.worldId)).get()).toMatchObject({ id: result.worldId, userId: 'member' })
    const memberWorldIds = (await fixture.db.select({ id: worlds.id }).from(worlds).where(eq(worlds.userId, 'member')).all()).map(row => row.id)
    expect(memberWorldIds).toHaveLength(priorWorldIds.length + 1)
    expect(memberWorldIds).toContain(priorWorld.worldId)
    expect(memberWorldIds).toContain(result.worldId)
    expect(await fixture.db.select({ status: guestSessions.status }).from(guestSessions).where(eq(guestSessions.id, guest.sessionId)).get()).toMatchObject({ status: 'claimed' })
    expect(await fixture.db.select().from(demoSandboxes).where(eq(demoSandboxes.sessionId, guest.sessionId)).get()).toMatchObject({ status: 'claimed', claimedWorldId: result.worldId })

    const clonedTimelines = await fixture.db.select().from(timelines).where(eq(timelines.worldId, result.worldId)).all()
    expect(clonedTimelines).toHaveLength(2)
    const clonedMain = clonedTimelines.find(row => row.parentTimelineId === null)!
    const clonedFork = clonedTimelines.find(row => row.id !== clonedMain.id)!
    expect(clonedFork).toMatchObject({ parentTimelineId: clonedMain.id, forkScenarioJson: expect.stringContaining('访客提前到达花房') })
    expect(clonedFork.forkSnapshotJson).toContain('fork_snapshots')
    expect(await fixture.db.select().from(forkSnapshots).where(eq(forkSnapshots.timelineId, clonedFork.id)).get()).toMatchObject({ timelineId: clonedFork.id, version: 1 })

    const clonedEvent = await fixture.db.select().from(events).where(and(
      eq(events.timelineId, clonedMain.id), eq(events.title, '访客抵达花房'),
    )).get()
    expect(clonedEvent).toBeDefined()

    const visitor = await fixture.db.select().from(persons)
      .innerJoin(worldPersons, eq(worldPersons.personId, persons.id))
      .where(and(eq(worldPersons.worldId, result.worldId), eq(persons.isUser, true))).get()
    expect(visitor!.persons).toMatchObject({ userId: 'member', isUser: true })
    expect(clonedEvent?.actorPersonId).toBe(visitor!.persons.id)
    expect(clonedEvent?.actorPersonId).not.toBe(sourceVisitor!.personId)
    expect(await fixture.db.select().from(personStates).where(and(
      eq(personStates.personId, visitor!.persons.id), eq(personStates.timelineId, clonedMain.id),
    )).get()).toMatchObject({ location: '温室花房' })
    expect(await fixture.db.select().from(personStates).where(and(
      eq(personStates.personId, visitor!.persons.id), eq(personStates.timelineId, clonedFork.id),
    )).get()).toMatchObject({ location: '温室花房' })
    expect(clonedTimelines.some(row => row.parentTimelineId === fork.id)).toBe(false)
    fixture.close()
  })

  it('keeps a failed claim recoverable and routes authenticated guest requests to the guest copy', async () => {
    const fixture = createTestDb()
    try {
      await fixture.db.insert(users).values([
        { id: 'admin', username: 'admin', passwordHash: 'x', createdAt: new Date().toISOString() },
        { id: 'member', username: 'member', passwordHash: 'x', createdAt: new Date().toISOString() },
      ])
      await fixture.db.insert(sessions).values({ token: 'member-token', userId: 'member', expiresAt: new Date(Date.now() + 60_000).toISOString() })
      await seedDemoWorld(fixture.db)
      const guest = await createGuestSession(fixture.db, 'guest-claim-failure-api')
      await fixture.db.insert(events).values({
        id: 'claim-failure-event', timelineId: guest.timelineId, simTime: '2026-10-02T00:00:00.000Z',
        title: 'Claim failure fixture', description: 'Ensures cloning touches the injected failing table.',
      })
      fixture.sqlite.exec(`CREATE TRIGGER fail_claim_event BEFORE INSERT ON events
        BEGIN SELECT RAISE(ABORT, 'forced claim clone failure'); END`)
      const failed = await app.request('/api/demo/session/claim', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer member-token', 'X-Possibility-Guest': guest.token!, 'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requestId: 'claim-failure-api' }),
      }, fixture.env)
      expect(failed.status).toBe(500)
      expect(await fixture.db.select({ status: guestSessions.status }).from(guestSessions)
        .where(eq(guestSessions.id, guest.sessionId)).get()).toMatchObject({ status: 'claim_pending' })

      const resume = await app.request('/api/demo/session', {
        headers: { 'X-Possibility-Guest': guest.token! },
      }, fixture.env)
      expect(resume.status).toBe(200)
      expect(await resume.json()).toMatchObject({ sessionId: guest.sessionId, worldId: guest.worldId, claimPending: true })

      const state = await app.request(`/api/worlds/${guest.worldId}/state?timelineId=${guest.timelineId}`, {
        headers: { Authorization: 'Bearer member-token', 'X-Possibility-Guest': guest.token! },
      }, fixture.env)
      expect(state.status, await state.clone().text()).toBe(200)
    } finally { fixture.close() }
  })
})

it('S4C 访客分支名称校验无副作用，时钟推进后的重试仍返回本次来源和新分支', async () => {
  const fixture = createTestDb()
  try {
    await fixture.db.insert(users).values({ id: 'admin', username: 'admin', passwordHash: 'x', createdAt: new Date().toISOString() })
    await seedDemoWorld(fixture.db)
    const guest = await createGuestSession(fixture.db, 'guest-s4c-replay')
    const headers = { 'X-Possibility-Guest': guest.token!, 'Content-Type': 'application/json' }
    const input = { timelineId: guest.timelineId, requestId: 'guest-s4c-fork', name: '提前抵达', whatIf: '访客提前到达花房', changedVariable: '抵达时间' }
    const fork = (body: unknown) => app.request(`/api/demo/worlds/${guest.worldId}/fork`, { method: 'POST', headers, body: JSON.stringify(body) }, fixture.env)
    const before = await fixture.db.select().from(timelines).all()
    const snapshots = await fixture.db.select().from(forkSnapshots).all()
    for (const [key, value] of [['name', undefined], ['name', ' '], ['name', '字'.repeat(81)], ['whatIf', ''], ['changedVariable', '']] as const) {
      expect((await fork({ ...input, [key]: value })).status).toBe(400)
    }
    expect(await fixture.db.select().from(timelines).all()).toEqual(before)
    expect(await fixture.db.select().from(forkSnapshots).all()).toEqual(snapshots)
    const response = await fork(input)
    expect(response.status, await response.clone().text()).toBe(200)
    const created = await response.json()
    expect(created).toMatchObject({ id: input.requestId, sourceTimelineId: guest.timelineId, name: input.name, whatIf: input.whatIf })
    await fixture.db.update(timelines).set({ simNow: '2026-10-03T12:00:00.000Z' }).where(eq(timelines.id, guest.timelineId))
    const replay = await fork(input)
    expect(replay.status, await replay.clone().text()).toBe(200)
    expect(await replay.json()).toEqual(created)
    expect((await fork({ ...input, name: '其他名称' })).status).toBe(409)
    expect(await fixture.db.select().from(timelines)).toHaveLength(before.length + 1)
  } finally { fixture.close() }
})
