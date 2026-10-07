import { expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyEdits, createEmptyWorld, serialize, type SerializedVoxelDocument } from '@possibility/voxel-contract'
import { createWorldFixture } from '../test/world-fixture'
import { createDb } from '../db/client'
import { sessions, timelineSceneHeads, timelineSceneRevisions, worldSceneRevisions, worlds } from '../db/schema'
import { commitTimelineScene } from './repository'

it.each(['session', 'owner', 'archive'] as const)('rolls back scoped and legacy main rows when %s changes before the final batch', async change => {
  const fixture = await createWorldFixture()
  try {
    const document = JSON.parse(serialize(applyEdits(createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'proof'), [
      { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
    ]).document)) as SerializedVoxelDocument
    let changed = false
    const dbWithRace = new Proxy(fixture.env.DB, {
      get(target, property, receiver) {
        if (property === 'batch') return async (statements: Parameters<typeof fixture.env.DB.batch>[0]) => {
          if (!changed) {
            changed = true
            if (change === 'session') await fixture.db.delete(sessions).where(eq(sessions.token, 'owner-token'))
            else if (change === 'owner') await fixture.db.update(worlds).set({ userId: 'other' }).where(eq(worlds.id, 'home-world'))
            else fixture.sqlite.prepare("UPDATE timelines SET status = 'archived' WHERE id = 'home-main'").run()
          }
          return target.batch(statements)
        }
        return Reflect.get(target, property, receiver)
      },
    }) as typeof fixture.env.DB
    await expect(commitTimelineScene(createDb(dbWithRace), {
      scope: { worldId: 'home-world', timelineId: 'home-main', representation: 'voxel' },
      document, expectedVersion: 0, requestId: `proof-race-${change}`, summary: '', kind: 'initial',
      authority: { sessionToken: 'owner-token', ownerUserId: 'owner' },
    })).rejects.toThrow()
    expect(await fixture.db.select().from(timelineSceneHeads)).toHaveLength(0)
    expect(await fixture.db.select().from(timelineSceneRevisions)).toHaveLength(0)
    expect(await fixture.db.select().from(worldSceneRevisions)).toHaveLength(0)
  } finally { fixture.close() }
})
