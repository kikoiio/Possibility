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
    expect(capabilitiesFor({ kind: 'guest', sessionId: 's', ownerId: 'owner', worldId: 'home-world', generation: 0, expiresAt: '2099' }, { isPublicBaseline: false, ownsWorld: true }))
      .toMatchObject({ participate: true, editScene: false, fork: true, resetDemo: true })
    expect(await resolveWorldScope(fixture.db, { kind: 'guest', sessionId: 's', ownerId: 'owner', worldId: 'other-world', generation: 0, expiresAt: '2099' }, 'home-world')).toBeNull()
  })
})
