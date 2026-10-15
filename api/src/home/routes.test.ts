import { afterEach, describe, expect, it } from 'vitest'
import { sessions, timelines, universeEvidence, universeRevisions, users, worldVisitSessions, worldVisits, worlds } from '../db/schema'
import { createTestDb } from '../test/db'
import { readWorldTimeContext } from '../worlds/time-context'
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
  await fixture.db.insert(users).values([
    { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: NOW },
    { id: 'other', username: 'other', passwordHash: 'x', createdAt: NOW },
  ])
  await fixture.db.insert(sessions).values({ token: 'owner-token', userId: 'owner', expiresAt: '2099-01-01T00:00:00.000Z' })
  await fixture.db.insert(worlds).values([
    { id: 'home-world', userId: 'owner', name: 'Home', description: '', status: 'running', timeZone: 'Asia/Tokyo' },
    { id: 'archived-world', userId: 'owner', name: 'Archived', description: '', status: 'archived' },
    { id: 'empty-world', userId: 'owner', name: 'Empty', description: '', status: 'running' },
    { id: 'foreign-world', userId: 'other', name: 'Foreign', description: '', status: 'running' },
  ])
  await fixture.db.insert(timelines).values([
    { id: 'home-main', worldId: 'home-world', simNow: NOW, createdAt: NOW },
    { id: 'archived-main', worldId: 'archived-world', simNow: NOW, createdAt: NOW, status: 'archived' },
    { id: 'foreign-main', worldId: 'foreign-world', simNow: NOW, createdAt: NOW },
  ])
  await fixture.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 9, simTime: NOW, worldModelVersion: 1, updatedAt: NOW })
  await fixture.db.insert(universeEvidence).values({ timelineId: 'home-main', level: 'complete', assessedVersion: 9, baselineVersion: 0, reasonCodesJson: '[]', assessedAt: NOW })
  await fixture.db.insert(worldVisitSessions).values([
    {
      id: 'open-session', principalKey: 'user:owner', userId: 'owner', guestSessionId: null,
      worldId: 'home-world', timelineId: 'home-main', clientSessionId: 'browser-1', status: 'open',
      enteredSimTime: NOW, enteredAt: NOW, exitedSimTime: null, exitedAt: null,
      lastRequestId: 'enter-1', createdAt: NOW, updatedAt: NOW,
    },
    {
      id: 'cross-world-session', principalKey: 'user:owner', userId: 'owner', guestSessionId: null,
      worldId: 'foreign-world', timelineId: 'home-main', clientSessionId: 'foreign-browser', status: 'open',
      enteredSimTime: '2098-01-01T00:00:00.000Z', enteredAt: '2098-01-01T00:00:00.000Z', exitedSimTime: null, exitedAt: null,
      lastRequestId: 'foreign-enter', createdAt: '2098-01-01T00:00:00.000Z', updatedAt: '2098-01-01T00:00:00.000Z',
    },
  ])
  await fixture.db.insert(worldVisits).values({ userId: 'owner', timelineId: 'archived-main', eventCursor: 4, revisionVersion: 2, seenAt: NOW })
  return fixture
}

function homeRequest() {
  return homeRoutes.request('/', { headers: { Authorization: 'Bearer owner-token' } }, fixture!.env)
}

function contextQueryCount(queryStart: number) {
  return fixture!.queryLog.slice(queryStart).filter(({ query }) =>
    /universe_revisions|universe_evidence|world_visit_sessions|world_visits/.test(query),
  ).length
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
    expect(body.timelines.some(row => row.id === 'foreign-main')).toBe(false)

    const guestContext = await readWorldTimeContext(f.db, {
      kind: 'guest', sessionId: 'guest-session', ownerId: 'owner', worldId: 'home-world',
      generation: 1, expiresAt: '2099-01-01T00:00:00.000Z',
    }, { worldId: 'home-world', timelineId: 'home-main' })
    expect(guestContext?.access.identity).toBe('guest')
    expect(await f.db.select().from(worldVisitSessions).all()).toEqual(sessionsBefore)
    expect(await f.db.select().from(worldVisits).all()).toEqual(visitsBefore)
  })

  it('loads home time contexts in a bounded query count for more timelines than SQLite bind limits', async () => {
    const f = await setup()
    const smallQueryStart = f.queryLog.length
    const smallResponse = await homeRequest()
    expect(smallResponse.status).toBe(200)
    const smallBody = await smallResponse.json() as HomeResponse
    const smallCount = contextQueryCount(smallQueryStart)
    expect(smallBody.timelines).toHaveLength(2)
    expect(smallBody.worlds.find(row => row.id === 'home-world')?.timeContext)
      .toEqual(smallBody.timelines.find(row => row.id === 'home-main')?.timeContext)

    const additionalTimelines = Array.from({ length: 1005 }, (_, index) => ({
      id: `home-fork-${index}`,
      worldId: 'home-world',
      parentTimelineId: 'home-main',
      simNow: NOW,
      createdAt: NOW,
    }))
    const insertTimeline = f.sqlite.prepare(
      'INSERT INTO timelines (id, world_id, parent_timeline_id, sim_now, created_at, status) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const timeline of additionalTimelines) {
      insertTimeline.run(timeline.id, timeline.worldId, timeline.parentTimelineId, timeline.simNow, timeline.createdAt, 'archived')
    }
    const largeQueryStart = f.queryLog.length
    const largeResponse = await homeRequest()
    expect(largeResponse.status).toBe(200)
    const largeBody = await largeResponse.json() as HomeResponse
    const largeCount = contextQueryCount(largeQueryStart)

    console.info('home context query count', JSON.stringify({ smallCount, largeCount, timelines: largeBody.timelines.length }))
    expect(largeBody.timelines).toHaveLength(1007)
    expect(largeBody.timelines.every(row => !!row.timeContext)).toBe(true)
    expect(largeBody.timelines.find(row => row.id === 'archived-main')?.timeContext.timeline.status).toBe('archived')
    expect(largeBody.worlds.find(row => row.id === 'home-world')?.timeContext)
      .toEqual(largeBody.timelines.find(row => row.id === 'home-main')?.timeContext)
    expect(smallCount).toBe(3)
    expect(largeCount).toBe(3)
  })
})
