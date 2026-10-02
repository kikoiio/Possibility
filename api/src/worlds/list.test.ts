import { afterEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../test/db'
import { persons, sessions, users, worldPersons, worldScenes, worlds } from '../db/schema'
import { worldsRoutes } from './routes'

const NOW = '2026-10-01T00:00:00.000Z'
let fixture: ReturnType<typeof createTestDb> | undefined
afterEach(() => { fixture?.close(); fixture = undefined })

describe('GET /api/worlds', () => {
  it('reports scene presence and associated people for worlds with and without a scene', async () => {
    fixture = createTestDb()
    await fixture.db.insert(users).values({ id: 'u', username: 'u', passwordHash: 'x', createdAt: NOW })
    await fixture.db.insert(sessions).values({ token: 'token', userId: 'u', expiresAt: '2099-01-01T00:00:00.000Z' })
    await fixture.db.insert(persons).values({ id: 'p', userId: 'u', name: '居民', modelJson: '{}', createdAt: NOW })
    await fixture.db.insert(worlds).values([
      { id: 'with-scene', userId: 'u', name: '有场景', description: '', status: 'running', createdAt: NOW },
      { id: 'without-scene', userId: 'u', name: '无场景', description: '', status: 'running', createdAt: NOW },
    ])
    await fixture.db.insert(worldPersons).values({ worldId: 'without-scene', personId: 'p', joinedAt: NOW })
    await fixture.db.insert(worldScenes).values({
      worldId: 'with-scene', currentVersion: 1, themeId: 'mist-manor', updatedAt: NOW,
    })

    const response = await worldsRoutes.request('/', {
      headers: { Authorization: 'Bearer token' },
    }, fixture.env)

    expect(response.status).toBe(200)
    const body = await response.json() as { worlds: Array<{ id: string; hasScene: boolean; personIds: string[] }> }
    expect(body.worlds).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'with-scene', hasScene: true, personIds: [] }),
      expect.objectContaining({ id: 'without-scene', hasScene: false, personIds: ['p'] }),
    ]))
  })
})
