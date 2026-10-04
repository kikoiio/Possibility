import { describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../test/db'
import { and, eq } from 'drizzle-orm'
import { demoBaselines, demoSandboxes, events, guestSessions, persons, timelines, users, worlds } from '../db/schema'
import { seedDemoWorld } from '../dev/seed-demo'
import { claimGuestSession, ClaimVerificationError, createGuestSession, resetGuestSession, resumeGuestSession } from './session-service'
import { cleanupExpiredGuestData } from './cleanup'
import * as cloneVerification from './clone-verification'

async function demoFixture() {
  const fixture = createTestDb()
  await fixture.db.insert(users).values({ id: 'admin', username: 'admin', passwordHash: 'x', createdAt: '2026-09-28T00:00:00.000Z' })
  await seedDemoWorld(fixture.db)
  return fixture
}

describe('guest demo sandbox lifecycle', () => {
  it('isolates sessions, resumes one sandbox and resets only that guest', async () => {
    const fixture = await demoFixture()
    const a = await createGuestSession(fixture.db, 'create-a')
    const b = await createGuestSession(fixture.db, 'create-b')
    expect(a.worldId).not.toBe(b.worldId)
    expect((await resumeGuestSession(fixture.db, a.token!))?.worldId).toBe(a.worldId)
    const reset = await resetGuestSession(fixture.db, a.token!, 'reset-a')
    expect(reset?.worldId).not.toBe(a.worldId)
    expect((await resumeGuestSession(fixture.db, b.token!))?.worldId).toBe(b.worldId)
    expect((await fixture.db.select().from(demoSandboxes).all()).length).toBeGreaterThanOrEqual(3)
  })

  it('claims a copy for a login user and remains idempotent', async () => {
    const fixture = await demoFixture()
    await fixture.db.insert(users).values({ id: 'member', username: 'member', passwordHash: 'x', createdAt: '2026-09-28T00:00:00.000Z' })
    const guest = await createGuestSession(fixture.db, 'create')
    const first = await claimGuestSession(fixture.db, { token: guest.token!, userId: 'member', requestId: 'claim' })
    const second = await claimGuestSession(fixture.db, { token: guest.token!, userId: 'member', requestId: 'claim' })
    if (first?.kind !== 'claimed') throw new Error('claim should succeed')
    expect(second).toEqual({ ...first, replayed: true })
    expect((await fixture.db.select().from(worlds).all()).some(world => world.id === first.worldId && world.userId === 'member')).toBe(true)
    expect((await fixture.db.select().from(guestSessions).get())?.tokenHash).not.toContain(guest.token!)
  })

  it('keeps the guest sandbox active after a clone failure and allows retry', async () => {
    const fixture = await demoFixture()
    await fixture.db.insert(users).values({ id: 'member', username: 'member', passwordHash: 'x', createdAt: '2026-09-28T00:00:00.000Z' })
    const guest = await createGuestSession(fixture.db, 'create-before-claim-failure')
    const sandboxBefore = await fixture.db.select().from(demoSandboxes)
      .where(and(eq(demoSandboxes.sessionId, guest.sessionId), eq(demoSandboxes.status, 'active'))).get()
    await fixture.db.insert(events).values({
      id: 'existing-event', timelineId: guest.timelineId, simTime: '2026-10-02T00:00:00.000Z',
      title: 'Existing event', description: 'Copied before the injected failure.',
    })

    fixture.sqlite.exec(`CREATE TRIGGER fail_claim_event BEFORE INSERT ON events
      WHEN NEW.id != 'existing-event'
      BEGIN SELECT RAISE(ABORT, 'forced claim clone failure'); END`)
    await expect(claimGuestSession(fixture.db, {
      token: guest.token!, userId: 'member', requestId: 'retryable-claim',
    })).rejects.toThrow('forced claim clone failure')

    expect(await fixture.db.select().from(guestSessions).where(eq(guestSessions.id, guest.sessionId)).get())
      .toMatchObject({ status: 'claim_pending', currentSandboxWorldId: guest.worldId })
    expect(await fixture.db.select().from(demoSandboxes).where(eq(demoSandboxes.id, sandboxBefore!.id)).get())
      .toMatchObject({ status: 'active', claimedWorldId: null })
    expect(await fixture.db.select().from(worlds).where(eq(worlds.userId, 'member')).all()).toEqual([])
    expect(await fixture.db.select().from(persons).where(eq(persons.userId, 'member')).all()).toEqual([])
    expect(await fixture.db.select().from(timelines).where(eq(timelines.worldId, guest.worldId)).all()).toHaveLength(1)
    expect(await fixture.db.select().from(events).where(eq(events.title, 'Existing event')).all()).toHaveLength(1)
    expect(await fixture.db.select().from(guestSessions).where(eq(guestSessions.id, guest.sessionId)).get())
      .toMatchObject({ currentSandboxWorldId: guest.worldId })
    expect(await resumeGuestSession(fixture.db, guest.token!)).toMatchObject({ worldId: guest.worldId, claimPending: true })
    expect(await fixture.db.select().from(worlds).where(eq(worlds.id, guest.worldId)).get()).toBeDefined()

    fixture.sqlite.exec('DROP TRIGGER fail_claim_event')
    const first = await claimGuestSession(fixture.db, {
      token: guest.token!, userId: 'member', requestId: 'retryable-claim-success',
    })
    const replay = await claimGuestSession(fixture.db, {
      token: guest.token!, userId: 'member', requestId: 'retryable-claim-success',
    })
    expect(first).toMatchObject({ kind: 'claimed', replayed: false })
    expect(replay).toEqual({ ...first, replayed: true })
    if (first?.kind !== 'claimed') throw new Error('claim should succeed')
    expect(await fixture.db.select().from(guestSessions).where(eq(guestSessions.id, guest.sessionId)).get())
      .toMatchObject({ status: 'claimed' })
    expect(await fixture.db.select().from(demoSandboxes).where(eq(demoSandboxes.id, sandboxBefore!.id)).get())
      .toMatchObject({ status: 'claimed', claimedWorldId: first.worldId })
    expect((await fixture.db.select().from(worlds).where(eq(worlds.userId, 'member')).all()).map(world => world.id))
      .toEqual([first.worldId])
    fixture.close()
  })

  it('cleans up the half-cloned graph when verification fails and allows a clean retry', async () => {
    const fixture = await demoFixture()
    await fixture.db.insert(users).values({ id: 'member', username: 'member', passwordHash: 'x', createdAt: '2026-09-28T00:00:00.000Z' })
    const guest = await createGuestSession(fixture.db, 'verify-failure-cleanup')
    const sandboxBefore = await fixture.db.select().from(demoSandboxes)
      .where(and(eq(demoSandboxes.sessionId, guest.sessionId), eq(demoSandboxes.status, 'active'))).get()

    // S2/F4：核验失败 → 删除半成品克隆图,访客会话与副本原样保留
    vi.spyOn(cloneVerification, 'verifyClonedWorld').mockResolvedValueOnce({
      ok: false, issues: [{ code: 'injected_failure', detail: 'controlled verification failure' }],
    })
    await expect(claimGuestSession(fixture.db, {
      token: guest.token!, userId: 'member', requestId: 'verify-retry',
    })).rejects.toThrow(ClaimVerificationError)

    expect(await fixture.db.select().from(worlds).where(eq(worlds.userId, 'member')).all()).toEqual([])
    expect(await fixture.db.select().from(persons).where(eq(persons.userId, 'member')).all()).toEqual([])
    expect(await fixture.db.select().from(guestSessions).where(eq(guestSessions.id, guest.sessionId)).get())
      .toMatchObject({ status: 'claim_pending', currentSandboxWorldId: guest.worldId })
    expect(await fixture.db.select().from(demoSandboxes).where(eq(demoSandboxes.id, sandboxBefore!.id)).get())
      .toMatchObject({ status: 'active', claimedWorldId: null })
    expect(await resumeGuestSession(fixture.db, guest.token!)).toMatchObject({ worldId: guest.worldId, claimPending: true })

    // 去除故障后同 requestId 重试:干净重建同一世界并保持幂等
    const first = await claimGuestSession(fixture.db, { token: guest.token!, userId: 'member', requestId: 'verify-retry' })
    const replay = await claimGuestSession(fixture.db, { token: guest.token!, userId: 'member', requestId: 'verify-retry' })
    expect(first).toMatchObject({ kind: 'claimed', replayed: false })
    expect(replay).toEqual({ ...first, replayed: true })
    if (first?.kind !== 'claimed') throw new Error('claim should succeed')
    expect((await fixture.db.select().from(worlds).where(eq(worlds.userId, 'member')).all()).map(world => world.id))
      .toEqual([first.worldId])
    expect(await fixture.db.select().from(guestSessions).where(eq(guestSessions.id, guest.sessionId)).get())
      .toMatchObject({ status: 'claimed' })
    fixture.close()
  })

  it('purges expired sandbox graphs while keeping the public baseline', async () => {    const fixture = await demoFixture()
    const guest = await createGuestSession(fixture.db, 'expire-me')
    const session = await fixture.db.select().from(guestSessions).where(eq(guestSessions.id, guest.sessionId)).get()
    const sandbox = await fixture.db.select().from(demoSandboxes).where(and(eq(demoSandboxes.sessionId, guest.sessionId), eq(demoSandboxes.status, 'active'))).get()
    const baseline = await fixture.db.select().from(demoBaselines).where(eq(demoBaselines.status, 'active')).get()
    await fixture.db.update(guestSessions).set({ expiresAt: '2020-01-01T00:00:00.000Z' }).where(eq(guestSessions.id, guest.sessionId))
    await fixture.db.update(demoSandboxes).set({ expiresAt: '2020-01-01T00:00:00.000Z' }).where(eq(demoSandboxes.id, sandbox!.id))

    const result = await cleanupExpiredGuestData(fixture.db, new Date('2026-09-28T00:00:00.000Z'))

    expect(result).toEqual({ sessions: 1, sandboxes: 1, worlds: 1 })
    expect(await fixture.db.select().from(worlds).where(eq(worlds.id, guest.worldId)).get()).toBeUndefined()
    expect(await fixture.db.select().from(guestSessions).where(eq(guestSessions.id, guest.sessionId)).get()).toBeUndefined()
    expect(await fixture.db.select().from(worlds).where(eq(worlds.id, baseline!.worldId)).get()).toBeDefined()
    expect(await fixture.db.select().from(users).where(eq(users.id, session!.ownerUserId)).get()).toBeUndefined()
  })

  it('keeps claim-pending sessions beyond the ordinary rolling expiry', async () => {
    const fixture = await demoFixture()
    const ordinary = await createGuestSession(fixture.db, 'ordinary-expired')
    const pending = await createGuestSession(fixture.db, 'claim-pending-retained')
    const ordinarySandbox = await fixture.db.select().from(demoSandboxes).where(eq(demoSandboxes.sessionId, ordinary.sessionId)).get()
    const pendingSandbox = await fixture.db.select().from(demoSandboxes).where(eq(demoSandboxes.sessionId, pending.sessionId)).get()
    await fixture.db.update(guestSessions).set({ expiresAt: '2020-01-01T00:00:00.000Z', status: 'claim_pending' })
      .where(eq(guestSessions.id, pending.sessionId))
    await fixture.db.update(demoSandboxes).set({ expiresAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(demoSandboxes.id, pendingSandbox!.id))
    await fixture.db.update(guestSessions).set({ expiresAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(guestSessions.id, ordinary.sessionId))
    await fixture.db.update(demoSandboxes).set({ expiresAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(demoSandboxes.id, ordinarySandbox!.id))

    const result = await cleanupExpiredGuestData(fixture.db, new Date('2026-10-04T00:00:00.000Z'))

    expect(result).toEqual({ sessions: 1, sandboxes: 1, worlds: 1 })
    expect(await fixture.db.select().from(guestSessions).where(eq(guestSessions.id, pending.sessionId)).get())
      .toMatchObject({ status: 'claim_pending', currentSandboxWorldId: pending.worldId })
    expect(await resumeGuestSession(fixture.db, pending.token!, new Date('2026-10-04T00:00:00.000Z')))
      .toMatchObject({ worldId: pending.worldId, claimPending: true })
    expect(await fixture.db.select().from(worlds).where(eq(worlds.id, pending.worldId)).get()).toBeDefined()
    fixture.close()
  })

  it('allows only one concurrent claimant and hides the winner world from another account', async () => {
    const fixture = await demoFixture()
    await fixture.db.insert(users).values([
      { id: 'member-a', username: 'member-a', passwordHash: 'x', createdAt: '2026-09-28T00:00:00.000Z' },
      { id: 'member-b', username: 'member-b', passwordHash: 'x', createdAt: '2026-09-28T00:00:00.000Z' },
    ])
    const guest = await createGuestSession(fixture.db, 'concurrent-claim')
    const [a, b] = await Promise.all([
      claimGuestSession(fixture.db, { token: guest.token!, userId: 'member-a', requestId: 'claim-a' }),
      claimGuestSession(fixture.db, { token: guest.token!, userId: 'member-b', requestId: 'claim-b' }),
    ])
    const winner = [a, b].find(result => result?.kind === 'claimed')
    expect(winner).toMatchObject({ kind: 'claimed' })
    expect([a, b].filter(result => result?.kind === 'already_claimed_elsewhere')).toHaveLength(1)
    if (winner?.kind !== 'claimed') throw new Error('one claim should win')
    const winningWorld = await fixture.db.select().from(worlds).where(eq(worlds.id, winner.worldId)).get()
    expect(['member-a', 'member-b']).toContain(winningWorld?.userId)
    const loserId = winningWorld?.userId === 'member-a' ? 'member-b' : 'member-a'
    expect(await fixture.db.select().from(worlds).where(eq(worlds.userId, loserId)).all()).toEqual([])
    expect((await fixture.db.select().from(worlds).where(eq(worlds.userId, winningWorld!.userId)).all()).map(world => world.id))
      .toEqual([winner.worldId])
    fixture.close()
  })
})
