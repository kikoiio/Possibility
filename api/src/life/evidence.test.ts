import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { commitWorldCommand } from '../world-state/commit'
import { createRootProjectionBaseline } from '../world-state/model'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { events, persons, sessions, timelines, universeRevisions, worldCommands, worldFacts, worldModelVersions, worldPersons, worldVisits } from '../db/schema'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })
const owner = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }

async function seedEvidenceWorld() {
  fixture = await createWorldFixture()
  const f = fixture
  await f.db.insert(persons).values([
    { id: 'ada', userId: 'owner', name: 'Ada', modelJson: '{}', createdAt: WORLD_TIME },
    { id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME },
  ])
  await f.db.insert(worldPersons).values(['ada', 'visitor'].map(personId => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
  await f.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
    modelJson: JSON.stringify({ name: 'Home world', description: 'test', locations: [{ name: 'Cafe', description: '' }],
      residents: [{ id: 'ada', name: 'Ada', model: {} }, { id: 'visitor', name: 'Visitor', model: {} }],
      projectionBaseline: createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, []) }) })
  await f.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME,
    worldModelVersion: 1, updatedAt: WORLD_TIME })
  return f
}

describe('E1 change review evidence', () => {
  it('returns source-backed state and private knowledge without putting message content in public event text', async () => {
    const f = await seedEvidenceWorld()
    const weather = await commitWorldCommand(f.db, { id: 'cmd-weather', worldId: 'home-world', timelineId: 'home-main',
      userId: 'owner', expectedVersion: 0, action: { type: 'environment', location: 'Cafe', condition: 'weather', value: '雾' } })
    const message = await commitWorldCommand(f.db, { id: 'cmd-message', worldId: 'home-world', timelineId: 'home-main',
      userId: 'owner', expectedVersion: weather.version,
      action: { type: 'inform', recipientId: 'ada', topic: '包裹', content: '包裹已经送到' } })
    const beforeReads = {
      commands: await f.db.select().from(worldCommands).all(),
      facts: await f.db.select().from(worldFacts).all(),
      events: await f.db.select().from(events).all(),
      visits: await f.db.select().from(worldVisits).all(),
    }

    const response = await app.request('/api/worlds/home-world/return?timelineId=home-main', { headers: owner }, f.env)
    expect(response.status).toBe(200)
    const brief = await response.json() as {
      summary: string; changes: { title: string; highlight: string | null; eventId: string | null; revisionVersion: number | null }[];
      nextRevisionVersion: number; nextEventCursor: number
    }
    expect(brief.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Cafe · weather已变化', highlight: 'state_change', sourceCommandId: 'cmd-weather' }),
      expect.objectContaining({ title: '一条消息被转告', highlight: null, sourceCommandId: 'cmd-message' }),
    ]))
    expect(brief.nextRevisionVersion).toBe(message.version)
    expect(brief.summary).toContain('状态或约定变化')

    const evidenceResponse = await app.request('/api/worlds/home-world/events/command:cmd-message/evidence?timelineId=home-main',
      { headers: owner }, f.env)
    expect(evidenceResponse.status).toBe(200)
    const detail = await evidenceResponse.json() as {
      event: { description: string }; facts: { value: { content?: string } }[];
      visibleKnowledge: { recipientName: string | null; topic: string; content: string; certainty: string }[];
      reconstruction: { status: string }; forkAvailable: boolean
    }
    expect(detail.event.description).not.toContain('包裹已经送到')
    expect(detail.facts[0]?.value.content).toBe('包裹已经送到')
    expect(detail.visibleKnowledge).toContainEqual(expect.objectContaining({ recipientName: 'Ada', topic: '包裹', content: '包裹已经送到', certainty: 'rumor' }))
    expect(detail.reconstruction.status).toBe('complete')
    expect(detail.forkAvailable).toBe(true)
    expect({
      commands: await f.db.select().from(worldCommands).all(),
      facts: await f.db.select().from(worldFacts).all(),
      events: await f.db.select().from(events).all(),
      visits: await f.db.select().from(worldVisits).all(),
    }).toEqual(beforeReads)

    const seen = await app.request('/api/worlds/home-world/return/seen', { method: 'POST', headers: owner,
      body: JSON.stringify({ timelineId: 'home-main', eventCursor: brief.nextEventCursor, revisionVersion: brief.nextRevisionVersion }) }, f.env)
    expect(seen.status).toBe(200)
    expect(await f.db.select().from(worldVisits).where(eq(worldVisits.timelineId, 'home-main')).get())
      .toMatchObject({ eventCursor: brief.nextEventCursor, revisionVersion: brief.nextRevisionVersion })
    const second = await app.request('/api/worlds/home-world/return?timelineId=home-main', { headers: owner }, f.env)
    expect((await second.json() as { changes: unknown[] }).changes).toEqual([])
  })

  it('rejects invalid or cross-timeline watermarks and hides another owner’s world', async () => {
    const f = await seedEvidenceWorld()
    await f.db.insert(sessions).values({ token: 'other-token', userId: 'other', expiresAt: '2099-01-01T00:00:00.000Z' })
    const hidden = await app.request('/api/worlds/home-world/return?timelineId=home-main', {
      headers: { Authorization: 'Bearer other-token' },
    }, f.env)
    expect(hidden.status).toBe(404)
    const invalid = await app.request('/api/worlds/home-world/return/seen', { method: 'POST', headers: owner,
      body: JSON.stringify({ timelineId: 'home-main', eventCursor: 999, revisionVersion: 0 }) }, f.env)
    expect(invalid.status).toBe(400)
    const badRevision = await app.request('/api/worlds/home-world/return/seen', { method: 'POST', headers: owner,
      body: JSON.stringify({ timelineId: 'home-main', eventCursor: 0, revisionVersion: 999 }) }, f.env)
    expect(badRevision.status).toBe(400)
    expect(await f.db.select().from(worldFacts).all()).toEqual([])
  })

  it('pages visible events without leaking future or sibling-timeline records and keeps source gaps explicit', async () => {
    const f = await seedEvidenceWorld()
    await f.db.insert(timelines).values({ id: 'home-branch', worldId: 'home-world', parentTimelineId: 'home-main',
      simNow: WORLD_TIME, createdAt: WORLD_TIME })
    await f.db.insert(events).values([
      { id: 'past-one', timelineId: 'home-main', simTime: '2026-09-21T07:00:00.000Z', title: '较早记录', description: '原始事件一', kind: 'injected' },
      { id: 'past-two', timelineId: 'home-main', simTime: '2026-09-21T07:30:00.000Z', title: '较晚记录', description: '原始事件二', kind: 'injected' },
      { id: 'future', timelineId: 'home-main', simTime: '2026-09-21T09:00:00.000Z', title: '未来记录', description: '不可见', kind: 'injected' },
      { id: 'sibling-event', timelineId: 'home-branch', simTime: '2026-09-21T07:15:00.000Z', title: '兄弟线记录', description: '不可见', kind: 'injected' },
    ])

    const first = await app.request('/api/worlds/home-world/return?timelineId=home-main&limit=1', { headers: owner }, f.env)
    expect(first.status).toBe(200)
    const firstPage = await first.json() as { changes: { id: string; title: string }[]; nextEventCursor: number; hasMore: boolean }
    expect(firstPage.changes.map(change => change.title)).toEqual(['较早记录'])
    expect(firstPage.hasMore).toBe(true)

    const second = await app.request(`/api/worlds/home-world/return?timelineId=home-main&limit=1&eventCursor=${firstPage.nextEventCursor}`,
      { headers: owner }, f.env)
    const secondPage = await second.json() as { changes: { id: string; title: string }[]; hasMore: boolean }
    expect(secondPage.changes.map(change => change.title)).toEqual(['较晚记录'])
    expect(secondPage.hasMore).toBe(false)

    const hidden = await app.request('/api/worlds/home-world/events/sibling-event/evidence?timelineId=home-main', { headers: owner }, f.env)
    expect(hidden.status).toBe(404)
    const detailResponse = await app.request('/api/worlds/home-world/events/past-one/evidence?timelineId=home-main', { headers: owner }, f.env)
    expect(detailResponse.status).toBe(200)
    const detail = await detailResponse.json() as { event: { title: string; description: string }; command: unknown; facts: unknown[]; gaps: string[];
      reconstruction: { status: string }; forkAvailable: boolean }
    expect(detail.event).toMatchObject({ title: '较早记录', description: '原始事件一' })
    expect(detail.command).toBeNull()
    expect(detail.facts).toEqual([])
    expect(detail.gaps).toContain('没有可核实的来源命令。')
    expect(detail.gaps).toContain('没有与事件直接关联的版本化事实。')
    expect(detail.reconstruction.status).toBe('unsupported')
    expect(detail.forkAvailable).toBe(false)
  })

  it('leaves events added after the displayed page unread and isolates the watermark by timeline', async () => {
    const f = await seedEvidenceWorld()
    await f.db.insert(timelines).values({ id: 'home-branch', worldId: 'home-world', parentTimelineId: 'home-main',
      simNow: WORLD_TIME, createdAt: WORLD_TIME })
    await f.db.insert(events).values({ id: 'main-before', timelineId: 'home-main', simTime: '2026-09-21T07:00:00.000Z',
      title: '页面已展示', description: '先读到的记录', kind: 'injected' })

    const initial = await app.request('/api/worlds/home-world/return?timelineId=home-main', { headers: owner }, f.env)
    const shown = await initial.json() as { nextEventCursor: number; changes: { id: string }[] }
    expect(shown.changes).toHaveLength(1)
    await f.db.insert(events).values([
      { id: 'main-after', timelineId: 'home-main', simTime: '2026-09-21T07:30:00.000Z', title: '读取后新增', description: '下次再读', kind: 'injected' },
      { id: 'branch-unread', timelineId: 'home-branch', simTime: '2026-09-21T07:15:00.000Z', title: '分支待读', description: '独立水位', kind: 'injected' },
    ])
    const marked = await app.request('/api/worlds/home-world/return/seen', { method: 'POST', headers: owner,
      body: JSON.stringify({ timelineId: 'home-main', eventCursor: shown.nextEventCursor, revisionVersion: 0 }) }, f.env)
    expect(marked.status).toBe(200)

    const mainAgain = await app.request('/api/worlds/home-world/return?timelineId=home-main', { headers: owner }, f.env)
    expect((await mainAgain.json() as { changes: { id: string }[] }).changes.map(change => change.id)).toEqual(['event:main-after'])
    const branch = await app.request('/api/worlds/home-world/return?timelineId=home-branch', { headers: owner }, f.env)
    expect((await branch.json() as { changes: { id: string }[] }).changes.map(change => change.id)).toEqual(['event:branch-unread'])
    expect(await f.db.select().from(worldVisits).all()).toEqual([
      expect.objectContaining({ userId: 'owner', timelineId: 'home-main', eventCursor: shown.nextEventCursor }),
    ])
  })
})
