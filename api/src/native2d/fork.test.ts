import { expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createWorldFixture } from '../test/world-fixture'
import { forkTimeline } from '../life/fork'
import { native2dLayoutRevisions, timelines } from '../db/schema'
import { createD1Native2dRepository } from './repository'
import type { Native2dLayout } from './schema'

it('forks saved native2d layouts independently and rolls back corrupt source forks', async () => {
  const fixture = await createWorldFixture()
  try {
    const repository = createD1Native2dRepository(fixture.db)
    const scope = { worldId: 'home-world', timelineId: 'home-main', sceneId: 'manor' }
    const layout: Native2dLayout = {
      metadata: { ...scope, schema: 'native2d-layout', schemaVersion: 1, layoutVersion: 1, sceneVersion: 1,
        spaces: [{ spaceId: 'exterior', kind: 'exterior', width: 4, depth: 4,
          walkable: Array.from({ length: 16 }, (_, i) => ({ x: i % 4, z: Math.floor(i / 4) })), connectivityRoot: { x: 0, z: 0 } }],
        buildings: [{ buildingId: 'house', spaceId: 'exterior', footprint: [{ x: 0, z: 0 }], entry: { x: -1, z: 0 }, locationKey: 'Cafe' }] },
      placements: [{ buildingId: 'house', spaceId: 'exterior', origin: { x: 2, z: 2 } }],
    }
    expect(await repository.save({ ...scope, layout, expectedVersion: 0, requestId: 'native2d-root' })).toMatchObject({ ok: true })
    const child = await forkTimeline(fixture.db, 'home-world', 'home-main', null, 'native2d-child')
    const childScope = { ...scope, timelineId: child.id }
    const inherited = await repository.read(childScope)
    expect(inherited?.layout.metadata.timelineId).toBe(child.id)
    expect(inherited?.layout.placements).toEqual(layout.placements)
    const edited = { ...layout, placements: [{ ...layout.placements[0]!, origin: { x: 1, z: 2 } }] }
    expect(await repository.save({ ...scope, layout: edited, expectedVersion: 1, requestId: 'native2d-parent-edit' })).toMatchObject({ ok: true })
    expect((await repository.read(childScope))?.layout.placements).toEqual(layout.placements)
    const before = await fixture.db.select().from(timelines)
    await fixture.db.update(native2dLayoutRevisions).set({ layoutJson: '{broken' })
      .where(eq(native2dLayoutRevisions.timelineId, 'home-main'))
    await expect(forkTimeline(fixture.db, 'home-world', 'home-main', null, 'native2d-corrupt-fork')).rejects.toThrow()
    expect(await fixture.db.select().from(timelines)).toEqual(before)
  } finally { fixture.close() }
})
