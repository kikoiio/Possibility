import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { sessions, timelines, universeEvidence, universeRevisions, users, worldVisitSessions, worldVisits, worlds } from '../db/schema'
import { createTestDb } from '../test/db'
import { readWorldTimeContext } from '../worlds/time-context'
import { readVisitContext } from '../life/visit-sessions'
import type { WorldTimeContext } from '@possibility/world-contract'
import { homeRoutes } from './routes'

const NOW = '2026-10-01T00:00:00.000Z'
let fixture: ReturnType<typeof createTestDb> | undefined
afterEach(() => { fixture?.close(); fixture = undefined })

type HomeResponse = {
  timelines: Array<{ id: string; timeContext: WorldTimeContext }>
  worlds: Array<{ id: string; simNow: string | null; timeContext?: WorldTimeContext }>
}

async function setup() {
  fixture = createTestDb()
  await fixture.db.insert(users).values({ id: 'owner', username: 'owner', passwordHash: 'x', createdAt: NOW })
  await fixture.db.insert(sessions).values({ token: 'owner-token', userId: 'owner', expiresAt: '2099-01-01T00:00:00.000Z' })
  await fixture.db.insert(worlds).values([
    { id: 'home-world', userId: 'owner', name: 'Home', description: '', status: 'running', timeZone: 'Asia/Tokyo' },
    { id: 'archived-world', userId: 'owner', name: 'Archived', description: '', status: 'archived' },
    { id: 'empty-world', userId: 'owner', name: 'Empty', description: '', status: 'running' },
  ])
  await fixture.db.insert(timelines).values([
    { id: 'home-main', worldId: 'home-world', simNow: NOW, createdAt: NOW },
    { id: 'archived-main', worldId: 'archived-world', simNow: NOW, createdAt: NOW, status: 'archived' },
  ])
  await fixture.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 9, simTime: NOW, worldModelVersion: 1, updatedAt: NOW })
  await fixture.db.insert(universeEvidence).values({ timelineId: 'home-main', level: 'complete', assessedVersion: 9, baselineVersion: 0, reasonCodesJson: '[]', assessedAt: NOW })
  await fixture.db.insert(worldVisitSessions).values({
    id: 'open-session', principalKey: 'user:owner', userId: 'owner', guestSessionId: null,
    worldId: 'home-world', timelineId: 'home-main', clientSessionId: 'browser-1', status: 'open',
    enteredSimTime: NOW, enteredAt: NOW, exitedSimTime: null, exitedAt: null,
    lastRequestId: 'enter-1', createdAt: NOW, updatedAt: NOW,
  })
  await fixture.db.insert(worldVisits).values({ userId: 'owner', timelineId: 'archived-main', eventCursor: 4, revisionVersion: 2, seenAt: NOW })
  return fixture
}

function homeRequest() {
  return homeRoutes.request('/', { headers: { Authorization: 'Bearer owner-token' } }, fixture!.env)
}

describe('home time contexts', () => {
  it('keeps owner, guest, archived, visit, and no-timeline context behavior', async () => {
    const f = await setup()
    const sessionsBefore = await f.db.select().from(worldVisitSessions).all()
    const visitsBefore = await f.db.select().from(worldVisits).all()
    const response = await homeRequest()
    expect(response.status).toBe(200)
    const body = await response.json() as HomeResponse

    expect(body.timelines.find(row => row.id === 'home-main')?.timeContext).toMatchObject({
      stateVersion: 9,
      revisionVersion: 9,
      access: { identity: 'owner' },
      visit: { phase: 'first_visit', sessionId: 'open-session' },
    })
    expect(body.timelines.find(row => row.id === 'archived-main')?.timeContext).toMatchObject({
      world: { status: 'archived' },
      timeline: { status: 'archived' },
      visit: { phase: 'returning', hasValidPreviousWatermark: true },
    })
    expect(body.worlds.find(row => row.id === 'empty-world')).toMatchObject({ simNow: null })
    expect(body.worlds.find(row => row.id === 'empty-world')).not.toHaveProperty('timeContext')

    const guestContext = await readWorldTimeContext(f.db, {
      kind: 'guest', sessionId: 'guest-session', ownerId: 'owner', worldId: 'home-world',
      generation: 1, expiresAt: '2099-01-01T00:00:00.000Z',
    }, { worldId: 'home-world', timelineId: 'home-main' })
    expect(guestContext?.access.identity).toBe('guest')
    expect(await f.db.select().from(worldVisitSessions).all()).toEqual(sessionsBefore)
    expect(await f.db.select().from(worldVisits).all()).toEqual(visitsBefore)
  })

  it('records the current per-timeline context-query growth for an owner home', async () => {
    const f = await setup()
    const readContextsLikeCurrentHome = async () => {
      const rows = await f.db.select({ world: worlds, timeline: timelines })
        .from(timelines)
        .innerJoin(worlds, eq(timelines.worldId, worlds.id))
        .where(eq(worlds.userId, 'owner'))
        .all()
      const queryStart = f.queryLog.length
      await Promise.all(rows.map(async ({ world, timeline }) => readWorldTimeContext(f.db, ownerAccess, {
        worldId: world.id,
        timelineId: timeline.id,
        visit: await readVisitContext(f.db, ownerAccess, { worldId: world.id, timelineId: timeline.id }),
      })))
      const main = rows.find(row => row.timeline.parentTimelineId === null) ?? rows[0]
      if (main) await readWorldTimeContext(f.db, ownerAccess, {
        worldId: main.world.id,
        timelineId: main.timeline.id,
        visit: await readVisitContext(f.db, ownerAccess, { worldId: main.world.id, timelineId: main.timeline.id }),
      })
      const count = f.queryLog.slice(queryStart).filter(({ query }) =>
        /universe_revisions|universe_evidence|world_visit_sessions|world_visits/.test(query),
      ).length
      return count
    }

    const ownerAccess = { kind: 'user' as const, userId: 'owner', username: 'owner', role: 'user' as const, ownerId: 'owner' }
    const smallCount = await readContextsLikeCurrentHome()
    const additionalTimelines = Array.from({ length: 1005 }, (_, index) => ({
      id: `home-fork-${index}`,
      worldId: 'home-world',
      parentTimelineId: 'home-main',
      simNow: NOW,
      createdAt: NOW,
    }))
    const insertTimeline = f.sqlite.prepare(
      'INSERT INTO timelines (id, world_id, parent_timeline_id, sim_now, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    for (const timeline of additionalTimelines) {
      insertTimeline.run(timeline.id, timeline.worldId, timeline.parentTimelineId, timeline.simNow, timeline.createdAt)
    }
    const largeCount = await readContextsLikeCurrentHome()

    console.info('home context query baseline', JSON.stringify({ smallCount, largeCount }))
    expect(smallCount).toBe(12)
    expect(largeCount).toBe(4032)
  })
})
