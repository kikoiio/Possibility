import { sessions, timelines, users, worlds } from '../db/schema'
import { createTestDb } from './db'

export const WORLD_TIME = '2026-09-21T08:00:00.000Z'

/** Stable, model-free world seed for route and state-transition tests. */
export async function createWorldFixture() {
  const fixture = createTestDb()
  await fixture.db.insert(users).values([
    { id: 'owner', username: 'owner', passwordHash: 'unused', createdAt: WORLD_TIME },
    { id: 'other', username: 'other', passwordHash: 'unused', createdAt: WORLD_TIME },
  ])
  await fixture.db.insert(sessions).values({ token: 'owner-token', userId: 'owner', expiresAt: '2099-01-01T00:00:00.000Z' })
  await fixture.db.insert(worlds).values([
    { id: 'home-world', userId: 'owner', name: 'Home world', description: 'A small town', status: 'running', locationsJson: JSON.stringify([{ name: 'Cafe', description: '' }, { name: 'Library', description: '' }]) },
    { id: 'other-world', userId: 'other', name: 'Other world', description: 'Private', status: 'running' },
  ])
  await fixture.db.insert(timelines).values([
    { id: 'home-main', worldId: 'home-world', simNow: WORLD_TIME, createdAt: WORLD_TIME },
    { id: 'other-main', worldId: 'other-world', simNow: WORLD_TIME, createdAt: WORLD_TIME },
  ])
  return fixture
}
