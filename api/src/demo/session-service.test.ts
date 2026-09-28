import { describe, expect, it } from 'vitest'
import { createTestDb } from '../test/db'
import { and, eq } from 'drizzle-orm'
import { demoBaselines, demoSandboxes, guestSessions, users, worlds } from '../db/schema'
import { seedDemoWorld } from '../dev/seed-demo'
import { claimGuestSession, createGuestSession, resetGuestSession, resumeGuestSession } from './session-service'
import { cleanupExpiredGuestData } from './cleanup'

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
    expect(second).toEqual(first)
    expect((await fixture.db.select().from(worlds).all()).some(world => world.id === first?.worldId && world.userId === 'member')).toBe(true)
    expect((await fixture.db.select().from(guestSessions).get())?.tokenHash).not.toContain(guest.token!)
  })

  it('purges expired sandbox graphs while keeping the public baseline', async () => {
    const fixture = await demoFixture()
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
})
