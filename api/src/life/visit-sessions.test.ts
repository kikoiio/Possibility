import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { timelines, universeEvidence, universeRevisions, users, worldFacts, worldVisitRequests, worldVisitSessions, worldVisits, worlds } from '../db/schema'
import { createTestDb } from '../test/db'
import { enterVisit, leaveVisit } from './visit-sessions'
import { readVisitContext } from './visit-context'

const NOW = '2026-10-01T00:00:00.000Z'
const owner = { kind: 'user' as const, userId: 'owner', username: 'owner', role: 'user' as const, ownerId: 'owner' }

let fixture: ReturnType<typeof createTestDb> | undefined
afterEach(() => { fixture?.close(); fixture = undefined })

async function setup() {
  fixture = createTestDb()
  await fixture.db.insert(users).values({ id: 'owner', username: 'owner', passwordHash: 'x', createdAt: NOW })
  await fixture.db.insert(worlds).values({ id: 'world', userId: 'owner', name: 'World', description: '', status: 'running', timeZone: 'Asia/Tokyo' })
  await fixture.db.insert(timelines).values({ id: 'main', worldId: 'world', simNow: NOW, createdAt: NOW })
  await fixture.db.insert(universeEvidence).values({ timelineId: 'main', level: 'complete', assessedVersion: 0, baselineVersion: 0, reasonCodesJson: '[]', assessedAt: NOW })
  return fixture
}

describe('visit session service', () => {
  it('creates a first visit once, closes it explicitly, and reports returning afterwards', async () => {
    const f = await setup()
    const input = { worldId: 'world', timelineId: 'main', clientSessionId: 'browser-1', requestId: 'enter-1' }
    const first = await enterVisit(f.db, owner, input, new Date('2026-10-01T01:00:00.000Z'))
    expect(first.context.visit).toMatchObject({ phase: 'first_visit', previousExitedSimTime: null, hasValidPreviousWatermark: false })
    expect(first.context.timeZone).toBe('Asia/Tokyo')

    const rowsBeforeRead = await f.db.select().from(worldVisitSessions).all()
    const read = await readVisitContext(f.db, owner, { worldId: 'world', timelineId: 'main' })
    expect(read).toMatchObject({ phase: 'first_visit', sessionId: first.context.visit.sessionId })
    expect(await f.db.select().from(worldVisitSessions).all()).toEqual(rowsBeforeRead)

    const replay = await enterVisit(f.db, owner, input, new Date('2026-10-01T01:01:00.000Z'))
    expect(replay.context.visit.sessionId).toBe(first.context.visit.sessionId)
    expect(await f.db.select().from(worldVisitSessions).all()).toHaveLength(1)

    const left = await leaveVisit(f.db, owner, { ...input, requestId: 'leave-1' }, new Date('2026-10-01T02:00:00.000Z'))
    expect(left.context.visit.phase).toBe('returning')
    expect(left.context.visit.previousExitedSimTime).toBe(NOW)

    const returned = await enterVisit(f.db, owner, { ...input, requestId: 'enter-2' }, new Date('2026-10-01T03:00:00.000Z'))
    expect(returned.context.visit).toMatchObject({ phase: 'returning', previousExitedSimTime: NOW, hasValidPreviousWatermark: true })
    expect(await f.db.select().from(worldVisitSessions).all()).toHaveLength(1)
  })

  it('uses a valid explicit world visit watermark and never creates one during a read', async () => {
    const f = await setup()
    await f.db.insert(worldVisits).values({ userId: 'owner', timelineId: 'main', eventCursor: 2, revisionVersion: 1, seenAt: NOW })
    const context = await readVisitContext(f.db, owner, { worldId: 'world', timelineId: 'main' })
    expect(context).toMatchObject({ phase: 'returning', sessionId: null, hasValidPreviousWatermark: true })
    expect(await f.db.select().from(worldVisitSessions).all()).toHaveLength(0)
  })

  it('rejects cross-world targets without creating a session', async () => {
    const f = await setup()
    const result = await readVisitContext(f.db, owner, { worldId: 'missing', timelineId: 'main' })
    expect(result.phase).toBe('unknown')
    await expect(enterVisit(f.db, owner, { worldId: 'missing', timelineId: 'main', clientSessionId: 'browser-1', requestId: 'x' })).rejects.toMatchObject({ status: 404 })
    expect(await f.db.select().from(worldVisitSessions).all()).toHaveLength(0)
  })

  it('rejects reusing a request id for a different operation or target with 409', async () => {
    const f = await setup()
    const input = { worldId: 'world', timelineId: 'main', clientSessionId: 'browser-1', requestId: 'enter-1' }
    await enterVisit(f.db, owner, input, new Date('2026-10-01T01:00:00.000Z'))

    await expect(leaveVisit(f.db, owner, input, new Date('2026-10-01T01:30:00.000Z'))).rejects.toMatchObject({ status: 409 })
    await expect(enterVisit(f.db, owner, { ...input, clientSessionId: 'browser-2' }, new Date('2026-10-01T01:31:00.000Z'))).rejects.toMatchObject({ status: 409 })

    expect(await f.db.select().from(worldVisitSessions).all()).toMatchObject([{ status: 'open', lastRequestId: 'enter-1' }])
    expect(await f.db.select().from(worldVisitRequests).all()).toMatchObject([{ principalKey: 'user:owner', requestId: 'enter-1', operation: 'enter' }])
  })

  it('records a leave without any session and replays it without side effects', async () => {
    const f = await setup()
    const input = { worldId: 'world', timelineId: 'main', clientSessionId: 'browser-9', requestId: 'late-leave-1' }
    const left = await leaveVisit(f.db, owner, input, new Date('2026-10-01T01:00:00.000Z'))
    expect(left.context.visit.phase).toBe('unknown')
    expect(await f.db.select().from(worldVisitRequests).all()).toMatchObject([{ principalKey: 'user:owner', requestId: 'late-leave-1', kind: 'request', operation: 'leave' }])

    const replay = await leaveVisit(f.db, owner, input, new Date('2026-10-01T01:01:00.000Z'))
    expect(replay.context.visit.phase).toBe('unknown')
    expect(await f.db.select().from(worldVisitRequests).all()).toHaveLength(1)
    expect(await f.db.select().from(worldVisitSessions).all()).toHaveLength(0)
  })

  it('authorizes a foreign-owned world before enter, replay, or leave session lookups', async () => {
    const f = await setup()
    await f.db.insert(users).values({ id: 'other-owner', username: 'other-owner', passwordHash: 'x', createdAt: NOW })
    await f.db.insert(worlds).values({ id: 'foreign-world', userId: 'other-owner', name: 'Foreign', description: '', status: 'running' })
    await f.db.insert(timelines).values({ id: 'foreign-main', worldId: 'foreign-world', simNow: NOW, createdAt: NOW })
    await f.db.insert(worldVisitSessions).values({
      id: 'foreign-session', principalKey: 'user:owner', userId: 'owner', guestSessionId: null,
      worldId: 'foreign-world', timelineId: 'foreign-main', clientSessionId: 'browser-old', status: 'open',
      enteredSimTime: NOW, enteredAt: NOW, exitedSimTime: null, exitedAt: null,
      lastRequestId: 'repeat-enter', createdAt: NOW, updatedAt: NOW,
    })

    const before = {
      sessions: await f.db.select().from(worldVisitSessions).all(),
      visits: await f.db.select().from(worldVisits).all(),
      timelines: await f.db.select().from(timelines).all(),
      revisions: await f.db.select().from(universeRevisions).all(),
      facts: await f.db.select().from(worldFacts).all(),
    }
    const queryStart = f.queryLog.length
    const foreignTarget = { worldId: 'foreign-world', timelineId: 'foreign-main' }

    await expect(enterVisit(f.db, owner, { ...foreignTarget, clientSessionId: 'browser-new', requestId: 'new-enter' })).rejects.toMatchObject({ status: 404 })
    await expect(enterVisit(f.db, owner, { ...foreignTarget, clientSessionId: 'browser-old', requestId: 'repeat-enter' })).rejects.toMatchObject({ status: 404 })
    await expect(leaveVisit(f.db, owner, { ...foreignTarget, clientSessionId: 'browser-old', requestId: 'leave-existing' })).rejects.toMatchObject({ status: 404 })
    await expect(leaveVisit(f.db, owner, { ...foreignTarget, clientSessionId: 'browser-missing', requestId: 'leave-missing' })).rejects.toMatchObject({ status: 404 })
    const rejectedVisitQueries = f.queryLog.slice(queryStart).filter(({ query }) => /world_visit_sessions|world_visits/.test(query))

    expect({
      sessions: await f.db.select().from(worldVisitSessions).all(),
      visits: await f.db.select().from(worldVisits).all(),
      timelines: await f.db.select().from(timelines).all(),
      revisions: await f.db.select().from(universeRevisions).all(),
      facts: await f.db.select().from(worldFacts).all(),
    }).toEqual(before)
    expect(rejectedVisitQueries).toEqual([])
  })
})
