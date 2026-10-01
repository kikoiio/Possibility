import { describe, expect, it } from 'vitest'
import { demoBaselines } from '../db/schema'
import { createWorldFixture } from '../test/world-fixture'
import { capabilitiesFor } from './policy'
import { resolveWorldScope } from './world-scope'

describe('world access policy', () => {
  it('keeps public baseline read-only and guest sandboxes scoped to their exact world', async () => {
    const fixture = await createWorldFixture()
    await fixture.db.insert(demoBaselines).values({ id: 'baseline', worldId: 'home-world', sceneVersion: 1, contentHash: 'hash', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' })
    const baseline = await resolveWorldScope(fixture.db, { kind: 'anonymous' }, 'home-world')
    expect(baseline?.capabilities).toMatchObject({ observe: true, participate: false, editScene: false })
    // 登录用户（含非物主）同样可观察公共基线，但不可写
    const loggedIn = await resolveWorldScope(fixture.db, { kind: 'user', userId: 'other', username: 'other', role: 'user', ownerId: 'other' }, 'home-world')
    expect(loggedIn?.capabilities).toMatchObject({ observe: true, participate: false, editScene: false, fork: false })
    expect(capabilitiesFor({ kind: 'guest', sessionId: 's', ownerId: 'owner', worldId: 'home-world', generation: 0, expiresAt: '2099' }, { isPublicBaseline: false, ownsWorld: true }))
      .toMatchObject({ participate: true, editScene: false, fork: true, resetDemo: true })
    // 访客同样可观察基线；私有世界仍严格限定归属
    const guestAtBaseline = await resolveWorldScope(fixture.db, { kind: 'guest', sessionId: 's', ownerId: 'owner', worldId: 'other-world', generation: 0, expiresAt: '2099' }, 'home-world')
    expect(guestAtBaseline?.capabilities).toMatchObject({ observe: true, participate: false })
    expect(await resolveWorldScope(fixture.db, { kind: 'guest', sessionId: 's', ownerId: 'owner', worldId: 'other-world', generation: 0, expiresAt: '2099' }, 'other-world')).toBeNull()
  })
})
