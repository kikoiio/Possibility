import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { sessions, timelines } from '../db/schema'
import app from '../index'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import type { Native2dLayout } from './schema'

const cells = Array.from({ length: 16 }, (_, index) => ({ x: index % 4, z: Math.floor(index / 4) }))
function makeLayout(): Native2dLayout {
  return {
    metadata: {
      schema: 'native2d-layout', schemaVersion: 1, layoutVersion: 1, sceneVersion: 3,
      worldId: 'home-world', timelineId: 'home-main', sceneId: 'mist-manor',
      spaces: [{ spaceId: 'exterior', kind: 'exterior', width: 4, depth: 4, walkable: cells, connectivityRoot: { x: 0, z: 0 } }],
      buildings: [{ buildingId: 'house', spaceId: 'exterior', footprint: [{ x: 0, z: 0 }], entry: { x: -1, z: 0 } }],
    },
    placements: [{ buildingId: 'house', spaceId: 'exterior', origin: { x: 2, z: 2 } }],
  }
}

describe('native2d account layout routes', () => {
  it('persists an owner layout, replays idempotently, and rejects stale heads', async () => {
    const fixture = await createWorldFixture()
    try {
      const path = '/api/worlds/home-world/native2d/layout?timelineId=home-main&sceneId=mist-manor'
      const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
      const get = () => app.request(path, { headers }, fixture.env)
      const put = (requestId: string, expectedVersion: number) => app.request(path, {
        method: 'PUT', headers, body: JSON.stringify({ requestId, expectedVersion, layout: makeLayout() }),
      }, fixture.env)

      expect(await (await get()).json()).toEqual({ layout: null })
      const created = await put('layout-r1', 0)
      expect(created.status).toBe(200)
      expect(await created.json()).toMatchObject({ replayed: false, layout: { version: 1, sceneId: 'mist-manor' } })
      expect(await (await put('layout-r1', 0)).json()).toMatchObject({ replayed: true, layout: { version: 1 } })
      const stale = await put('layout-r2', 0)
      expect(stale.status).toBe(409)
      expect(await stale.json()).toMatchObject({ errorCode: 'version_conflict' })
      expect(await (await get()).json()).toMatchObject({ layout: { version: 1, placements: makeLayout().placements } })
      expect((await fixture.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())?.simNow).toBe(WORLD_TIME)
    } finally { fixture.close() }
  })

  it('keeps layouts owner/timeline scoped and blocks writes to archived timelines', async () => {
    const fixture = await createWorldFixture()
    try {
      const path = '/api/worlds/home-world/native2d/layout?timelineId=home-main&sceneId=mist-manor'
      const body = JSON.stringify({ requestId: 'layout-r1', expectedVersion: 0, layout: makeLayout() })
      await fixture.db.insert(sessions).values({ token: 'other-token', userId: 'other', expiresAt: '2099-01-01T00:00:00.000Z' })
      const nonOwner = await app.request(path, { method: 'PUT', headers: { Authorization: 'Bearer other-token', 'Content-Type': 'application/json' }, body }, fixture.env)
      expect(nonOwner.status).toBe(404)
      const anonymous = await app.request(path, { method: 'GET' }, fixture.env)
      expect(anonymous.status).toBe(401)

      await fixture.db.insert(timelines).values({ id: 'home-archived', worldId: 'home-world', simNow: WORLD_TIME, createdAt: WORLD_TIME, status: 'archived' })
      const archivedPath = '/api/worlds/home-world/native2d/layout?timelineId=home-archived&sceneId=mist-manor'
      const archivedBody = JSON.stringify({ requestId: 'archived-layout', expectedVersion: 0,
        layout: { ...makeLayout(), metadata: { ...makeLayout().metadata, timelineId: 'home-archived' } } })
      const archived = await app.request(archivedPath, { method: 'PUT', headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }, body: archivedBody }, fixture.env)
      expect(archived.status).toBe(409)
      expect(await archived.json()).toMatchObject({ errorCode: 'archived_read_only' })
    } finally { fixture.close() }
  })
})
