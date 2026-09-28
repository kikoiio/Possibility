import { describe, expect, it } from 'vitest'
import { createWorldFixture } from '../test/world-fixture'
import { loadMapBootstrap } from './bootstrap'
import { saveMapResume } from './resume'

describe('map bootstrap', () => {
  it('returns world-backed presentation only to its owner', async () => {
    const fixture = await createWorldFixture()
    const own = await loadMapBootstrap(fixture.db, 'home-world', 'owner')
    expect(own?.world?.world.id).toBe('home-world')
    expect(own?.scene.status).toBe('missing')
    expect(own?.presentation.locations.map(location => location.name)).toEqual(['Cafe', 'Library'])
    expect(await loadMapBootstrap(fixture.db, 'home-world', 'other')).toBeNull()
    expect(await loadMapBootstrap(fixture.db, 'missing-world', 'owner')).toBeNull()
  })

  it('fails closed when the selected timeline does not belong to the world', async () => {
    const fixture = await createWorldFixture()
    expect(await loadMapBootstrap(fixture.db, 'home-world', 'owner', 'other-main')).toBeNull()
  })

  it('persists and restores the last valid map context for its owner', async () => {
    const fixture = await createWorldFixture()
    expect(await saveMapResume(fixture.db, { userId: 'owner', worldId: 'home-world', timelineId: 'home-main', spaceId: 'exterior', mode: 'possibility' })).toBe(true)
    expect(await saveMapResume(fixture.db, { userId: 'other', worldId: 'home-world', timelineId: 'home-main', spaceId: 'exterior', mode: 'life' })).toBe(false)
    const restored = await loadMapBootstrap(fixture.db, 'home-world', 'owner')
    expect(restored?.resume).toMatchObject({ timelineId: 'home-main', spaceId: 'exterior', mode: 'possibility' })
  })
})
