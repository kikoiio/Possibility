import { describe, expect, it } from 'vitest'
import { createTestDb } from '../test/db'
import { guestSessions, sessions, users, worlds } from '../db/schema'
import { AccessCredentialError } from './types'
import { hashGuestToken, resolveAccessContext } from './middleware'

describe('access middleware resolver', () => {
  it('resolves users, guests and anonymous requests without storing a raw guest token', async () => {
    const fixture = createTestDb()
    const now = '2026-09-28T00:00:00.000Z'
    await fixture.db.insert(users).values([
      { id: 'user', username: 'user', passwordHash: 'x', createdAt: now },
      { id: 'guest-owner', username: 'guest-owner', passwordHash: 'disabled:guest', createdAt: now },
    ])
    await fixture.db.insert(sessions).values({ token: 'user-token', userId: 'user', expiresAt: '2099-01-01T00:00:00.000Z' })
    await fixture.db.insert(worlds).values({ id: 'guest-world', userId: 'guest-owner', name: 'guest', description: '', createdAt: now })
    await fixture.db.insert(guestSessions).values({
      id: 'guest-session', tokenHash: await hashGuestToken('raw-secret'), ownerUserId: 'guest-owner', currentSandboxWorldId: 'guest-world',
      generation: 0, status: 'active', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: now, updatedAt: now,
    })
    expect(await resolveAccessContext(fixture.db, {})).toEqual({ kind: 'anonymous' })
    expect(await resolveAccessContext(fixture.db, { authorization: 'Bearer user-token' })).toMatchObject({ kind: 'user', userId: 'user' })
    expect(await resolveAccessContext(fixture.db, { guestToken: 'raw-secret' })).toMatchObject({ kind: 'guest', worldId: 'guest-world' })
    expect((await fixture.db.select().from(guestSessions).get())?.tokenHash).not.toContain('raw-secret')
  })

  it('reports expired and claimed guest credentials explicitly', async () => {
    const fixture = createTestDb(); const now = '2026-09-28T00:00:00.000Z'
    await fixture.db.insert(users).values({ id: 'owner', username: 'owner', passwordHash: 'x', createdAt: now })
    await fixture.db.insert(guestSessions).values({
      id: 's', tokenHash: await hashGuestToken('token'), ownerUserId: 'owner', generation: 0, status: 'claimed',
      expiresAt: '2099-01-01T00:00:00.000Z', createdAt: now, updatedAt: now,
    })
    await expect(resolveAccessContext(fixture.db, { guestToken: 'token' })).rejects.toMatchObject<Partial<AccessCredentialError>>({ code: 'claimed', status: 409 })
  })
})
