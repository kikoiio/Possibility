import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { buildAgentContext } from '../agent/context'
import { ensureUniverseRevision } from '../world-state/model'
import { auditUniverse } from '../world-state/invariants'
import { chapters, commitments, conversations, dialogueTurns, dialogues, events, memories, messages, persons, personStates, sessions, timelines, universeRevisions, worldFacts, worldModelVersions, worldPersons, worlds } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from './world-fixture'

type Fixture = Awaited<ReturnType<typeof createWorldFixture>>
let fixture: Fixture | null = null
afterEach(() => { fixture?.close(); fixture = null; vi.unstubAllGlobals() })

const auth = { Authorization: 'Bearer owner-token' }

describe('legacy reads and exact timeline scope', () => {
  it('keeps old structured rows readable without inventing missing fork history', async () => {
    fixture = await createWorldFixture()
    await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
    await fixture.db.insert(persons).values({ id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: '{}', isUser: true, createdAt: WORLD_TIME })
    await fixture.db.insert(worldPersons).values(['resident', 'visitor'].map(personId => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
    await fixture.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME, location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Learn', updatedRealAt: WORLD_TIME })
    await fixture.db.insert(memories).values({ id: 'old-memory', personId: 'resident', timelineId: null, type: 'world', content: 'A remembered visit', createdAt: WORLD_TIME })
    await fixture.db.insert(events).values({ id: 'old-event', timelineId: 'home-main', simTime: WORLD_TIME, title: 'A visit', description: 'A visit happened' })
    await fixture.db.insert(dialogues).values({ id: 'old-dialogue', timelineId: 'home-main', location: 'Cafe',
      participantIdsJson: JSON.stringify(['visitor', 'resident']), status: 'ended', turnLimit: 8, simStart: WORLD_TIME,
      simEnd: WORLD_TIME, kind: 'scene', visitorId: 'visitor' })
    await fixture.db.insert(dialogueTurns).values({ id: 'old-turn', dialogueId: 'old-dialogue', turnIndex: 0, personId: 'visitor',
      utterance: 'Is anyone here?', thought: '', simTime: WORLD_TIME, createdAt: WORLD_TIME })
    await fixture.db.insert(conversations).values({ id: 'old-conversation', userId: 'owner', personId: 'resident', timelineId: 'home-main' })
    await fixture.db.insert(messages).values({ id: 'old-message', conversationId: 'old-conversation', role: 'person',
      content: 'An old reply', createdAt: WORLD_TIME })
    await fixture.db.insert(commitments).values({ id: 'old-commitment', worldId: 'home-world', timelineId: 'home-main',
      personId: 'resident', visitorId: 'visitor', title: 'Meet again', kind: 'meeting', location: 'Cafe',
      dueSim: '2026-09-21T09:00:00.000Z', status: 'proposed', createdSim: WORLD_TIME, updatedSim: WORLD_TIME, createdAt: WORLD_TIME })
    await fixture.db.insert(timelines).values({ id: 'old-fork', worldId: 'home-world', parentTimelineId: 'home-main', simNow: WORLD_TIME, createdAt: '2026-09-21T09:00:00.000Z', forkSnapshotJson: null })

    const world = await app.request('/api/worlds/home-world?timelineId=home-main', { headers: auth }, fixture.env)
    expect(world.status).toBe(200)
    const body = await world.json() as { locationBoard: { persons: { id: string }[] }[]; events: { id: string }[] }
    expect(body.locationBoard.flatMap((x) => x.persons.map((p) => p.id))).toContain('resident')
    expect(body.events.map((e) => e.id)).toContain('old-event')
    const defaultWorld = await app.request('/api/worlds/home-world', { headers: auth }, fixture.env)
    expect(defaultWorld.status).toBe(200)
    expect(await defaultWorld.json()).toMatchObject({ currentTimelineId: 'home-main' })
    const selectedFork = await app.request('/api/worlds/home-world?timelineId=old-fork', { headers: auth }, fixture.env)
    expect(selectedFork.status).toBe(200)
    expect(await selectedFork.json()).toMatchObject({ currentTimelineId: 'old-fork' })
    const compare = await app.request('/api/worlds/home-world/compare?left=home-main&right=old-fork', { headers: auth }, fixture.env)
    expect(compare.status).toBe(200)
    const evidence = await compare.json() as { right: { historyComplete: boolean } }
    expect(evidence.right.historyComplete).toBe(false)

    const legacyState = await app.request('/api/worlds/home-world/state?timelineId=home-main', { headers: auth }, fixture.env)
    expect(await legacyState.json()).toMatchObject({ evidenceStatus: 'legacy', facts: [], current: [] })
    const history = await app.request('/api/worlds/home-world/scene/history?timelineId=home-main&location=Cafe', { headers: auth }, fixture.env)
    expect(await history.json()).toMatchObject({ dialogueId: 'old-dialogue', turns: [expect.objectContaining({ utterance: 'Is anyone here?' })] })
    const oldChat = await app.request('/api/conversations/old-conversation/messages', { headers: auth }, fixture.env)
    expect(await oldChat.json()).toMatchObject({ messages: [expect.objectContaining({ content: 'An old reply' })] })
    const focus = await app.request('/api/worlds/home-world/persons/resident?timelineId=home-main', { headers: auth }, fixture.env)
    expect(await focus.json()).toMatchObject({ memories: [expect.objectContaining({ id: 'old-memory', content: 'A remembered visit' })] })
    const returned = await app.request('/api/worlds/home-world/return?timelineId=home-main', { headers: auth }, fixture.env)
    expect(await returned.json()).toMatchObject({ commitments: [expect.objectContaining({ id: 'old-commitment', status: 'proposed' })] })
    expect((await app.request('/api/worlds/dialogues/old-dialogue?timelineId=', { headers: auth }, fixture.env)).status).toBe(404)
    expect(await fixture.db.select().from(commitments).where(eq(commitments.id, 'old-commitment')).get()).toMatchObject({ status: 'proposed' })
  })

  it('rejects an explicitly invalid or foreign timeline instead of falling back to the main line', async () => {
    fixture = await createWorldFixture()
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No model/network call expected') }))
    const before = fixture.sqlite.prepare('SELECT count(*) AS n FROM events').get()!.n
    for (const timelineId of ['missing', 'other-main']) {
      const read = await app.request(`/api/worlds/home-world?timelineId=${timelineId}`, { headers: auth }, fixture.env)
      expect(read.status).toBe(404)
      const inject = await app.request('/api/worlds/home-world/inject', {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'A storm begins', timelineId }),
      }, fixture.env)
      expect(inject.status).toBe(404)
      const chapter = await app.request('/api/worlds/home-world/chapters', {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timelineId }),
      }, fixture.env)
      expect(chapter.status).toBe(404)
      const chapterList = await app.request(`/api/worlds/home-world/chapters?timelineId=${timelineId}`,
        { headers: auth }, fixture.env)
      expect(chapterList.status).toBe(404)
    }
    const emptyChapterTimeline = await app.request('/api/worlds/home-world/chapters', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timelineId: '' }),
    }, fixture.env)
    expect(emptyChapterTimeline.status).toBe(400)
    for (const path of ['/api/worlds/home-world?timelineId=', '/api/worlds/home-world/chapters?timelineId=',
      '/api/worlds/home-world/scene/board?timelineId=', '/api/worlds/home-world/persona?timelineId=',
      '/api/worlds/home-world/return?timelineId=']) {
      expect((await app.request(path, { headers: auth }, fixture.env)).status).toBe(404)
    }
    expect((await app.request('/api/worlds/home-world/scene', { method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timelineId: '', content: 'Hello' }) }, fixture.env)).status).toBe(404)
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM events').get()!.n).toBe(before)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not fall back to mutable assets when a structured world loses its pinned model', async () => {
    fixture = await createWorldFixture()
    await fixture.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0,
      simTime: WORLD_TIME, worldModelVersion: 99, updatedAt: WORLD_TIME })
    const read = await app.request('/api/worlds/home-world?timelineId=home-main', { headers: auth }, fixture.env)
    expect(read.status).toBe(409)
    expect(await read.json()).toMatchObject({ error: expect.stringContaining('固定设定版本缺失') })
    await fixture.db.update(worlds).set({ isDemo: true }).where(eq(worlds.id, 'home-world'))
    expect((await app.request('/api/public/worlds/home-world?timelineId=home-main', {}, fixture.env)).status).toBe(409)
    const action = await app.request('/api/worlds/home-world/actions', { method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'missing-model-action', timelineId: 'home-main', expectedVersion: 0,
        action: { type: 'environment', location: null, condition: 'weather', value: 'rain' } }) }, fixture.env)
    expect(action.status).toBe(409)
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(0)
  })

  it('rejects a corrupt pinned model and exposes it in the audit', async () => {
    fixture = await createWorldFixture()
    await fixture.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1,
      modelJson: 'null', createdAt: WORLD_TIME })
    await fixture.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0,
      simTime: WORLD_TIME, worldModelVersion: 1, updatedAt: WORLD_TIME })
    const read = await app.request('/api/worlds/home-world?timelineId=home-main', { headers: auth }, fixture.env)
    expect(read.status).toBe(409)
    expect(await read.json()).toMatchObject({ error: expect.stringContaining('固定设定内容损坏') })
    expect(await auditUniverse(fixture.db, 'home-world', 'home-main')).toContainEqual(expect.objectContaining({
      code: 'world_model_version_invalid', timelineId: 'home-main',
    }))
  })

  it('does not expose another owner world and keeps anonymous writes blocked', async () => {
    fixture = await createWorldFixture()
    await fixture.db.insert(sessions).values({ token: 'other-token', userId: 'other', expiresAt: '2099-01-01T00:00:00.000Z' })
    expect((await app.request('/api/worlds/other-world', { headers: auth }, fixture.env)).status).toBe(404)
    expect((await app.request('/api/worlds/home-world/state?timelineId=home-main', { headers: { Authorization: 'Bearer other-token' } }, fixture.env)).status).toBe(404)
    expect((await app.request('/api/worlds/home-world/scene/history?timelineId=home-main', { headers: { Authorization: 'Bearer other-token' } }, fixture.env)).status).toBe(404)
    const foreignWrite = await app.request('/api/worlds/home-world/actions', { method: 'POST',
      headers: { Authorization: 'Bearer other-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'other-action', timelineId: 'home-main', expectedVersion: 0,
        action: { type: 'environment', location: null, condition: 'weather', value: 'rain' } }) }, fixture.env)
    expect(foreignWrite.status).toBe(404)
    expect(await fixture.db.select().from(worldFacts).all()).toHaveLength(0)
    expect((await app.request('/api/worlds/home-world/inject', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'A storm begins' }),
    }, fixture.env)).status).toBe(401)
  })

  it('keeps legacy chat readable but does not save rejected messages in paused or archived worlds', async () => {
    fixture = await createWorldFixture()
    const f = fixture
    await f.db.insert(persons).values({ id: 'chat-resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
    await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'chat-resident', joinedAt: WORLD_TIME })
    await f.db.insert(personStates).values({ personId: 'chat-resident', timelineId: 'home-main', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })
    await f.db.insert(conversations).values({ id: 'chat-conversation', userId: 'owner', personId: 'chat-resident', timelineId: 'home-main' })
    const send = () => app.request('/api/conversations/chat-conversation/messages', { method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Hello' }) }, f.env)
    await f.db.update(worlds).set({ status: 'paused' }).where(eq(worlds.id, 'home-world'))
    expect((await app.request('/api/persons/chat-resident/conversations', { method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ timelineId: 'home-main' }) }, f.env)).status).toBe(200)
    expect((await send()).status).toBe(409)
    await f.db.update(worlds).set({ status: 'running' }).where(eq(worlds.id, 'home-world'))
    await f.db.update(timelines).set({ status: 'archived' }).where(eq(timelines.id, 'home-main'))
    expect((await send()).status).toBe(409)
    expect(await f.db.select().from(messages).where(eq(messages.conversationId, 'chat-conversation')).all()).toHaveLength(0)
  })

  it('uses an explicit timeline to enter the right world for a shared resident', async () => {
    fixture = await createWorldFixture()
    const f = fixture
    await f.db.insert(worlds).values({ id: 'second-world', userId: 'owner', name: 'Second world', description: '', status: 'running' })
    await f.db.insert(timelines).values({ id: 'second-main', worldId: 'second-world', simNow: WORLD_TIME, createdAt: WORLD_TIME })
    await f.db.insert(persons).values({ id: 'shared-resident', userId: 'owner', name: 'Resident',
      modelJson: JSON.stringify({ identity: [{ text: 'First world profile', provenance: 'known' }] }), createdAt: WORLD_TIME })
    await f.db.insert(worldPersons).values([
      { worldId: 'home-world', personId: 'shared-resident', joinedAt: WORLD_TIME },
      { worldId: 'second-world', personId: 'shared-resident', joinedAt: '2026-09-21T09:00:00.000Z' },
    ])
    await f.db.insert(personStates).values([
      { personId: 'shared-resident', timelineId: 'home-main', simTime: WORLD_TIME, location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Rest', updatedRealAt: WORLD_TIME },
      { personId: 'shared-resident', timelineId: 'second-main', simTime: WORLD_TIME, location: 'Harbor', activity: 'Walking', mood: 'Curious', goal: 'Explore', updatedRealAt: WORLD_TIME },
    ])
    await f.db.insert(memories).values([
      { id: 'shared-memory-home', personId: 'shared-resident', timelineId: 'home-main', type: 'world', content: 'An old memory from the first world', createdAt: WORLD_TIME },
      { id: 'shared-memory-second', personId: 'shared-resident', timelineId: 'second-main', type: 'world', content: 'An old memory from the second world', createdAt: WORLD_TIME },
    ])
    await f.db.insert(conversations).values([
      { id: 'shared-conversation-home', userId: 'owner', personId: 'shared-resident', timelineId: 'home-main' },
      { id: 'shared-conversation-second', userId: 'owner', personId: 'shared-resident', timelineId: 'second-main' },
    ])
    await f.db.insert(messages).values([
      { id: 'shared-message-home', conversationId: 'shared-conversation-home', role: 'person', content: 'A reply from the first world', createdAt: WORLD_TIME },
      { id: 'shared-message-second', conversationId: 'shared-conversation-second', role: 'person', content: 'A reply from the second world', createdAt: WORLD_TIME },
    ])
    await ensureUniverseRevision(f.db, 'home-world', 'home-main')
    await f.db.update(persons).set({ modelJson: JSON.stringify({ identity: [{ text: 'Second world profile', provenance: 'known' }] }) })
      .where(eq(persons.id, 'shared-resident'))
    await ensureUniverseRevision(f.db, 'second-world', 'second-main')
    await f.db.update(persons).set({ name: 'Edited resident', modelJson: JSON.stringify({ identity: [{ text: 'Latest editable profile', provenance: 'known' }] }) })
      .where(eq(persons.id, 'shared-resident'))
    await f.db.update(worlds).set({ name: 'Edited world', description: 'Changed later' }).where(eq(worlds.id, 'second-world'))
    const firstContext = await buildAgentContext(f.db, { userId: 'owner', personId: 'shared-resident', timelineId: 'home-main', mode: 'chat' })
    const ctx = await buildAgentContext(f.db, { userId: 'owner', personId: 'shared-resident', timelineId: 'second-main', mode: 'chat' })
    expect(firstContext?.model.identity[0]?.text).toBe('First world profile')
    expect(ctx?.world.id).toBe('second-world')
    expect(ctx?.world.name).toBe('Second world')
    expect(ctx?.world.description).toBe('')
    expect(ctx?.person.name).toBe('Resident')
    expect(ctx?.state.location).toBe('Harbor')
    expect(ctx?.model.identity[0]?.text).toBe('Second world profile')
    expect(firstContext?.memories.map(memory => memory.id)).toEqual(['shared-memory-home'])
    expect(ctx?.memories.map(memory => memory.id)).toEqual(['shared-memory-second'])
    const homeHistory = await app.request('/api/conversations/shared-conversation-home/messages', { headers: auth }, f.env)
    const secondHistory = await app.request('/api/conversations/shared-conversation-second/messages', { headers: auth }, f.env)
    expect(await homeHistory.json()).toMatchObject({ messages: [expect.objectContaining({ id: 'shared-message-home', content: 'A reply from the first world' })] })
    expect(await secondHistory.json()).toMatchObject({ messages: [expect.objectContaining({ id: 'shared-message-second', content: 'A reply from the second world' })] })
    const response = await app.request('/api/persons/shared-resident/conversations', { method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ timelineId: 'second-main' }) }, f.env)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ timelineId: 'second-main' })
  })

  it('does not save a partial legacy reply as a completed message when its model stream breaks', async () => {
    fixture = await createWorldFixture()
    const f = fixture
    const model = { identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] }
    await f.db.insert(persons).values({ id: 'stream-resident', userId: 'owner', name: 'Resident', modelJson: JSON.stringify(model), createdAt: WORLD_TIME })
    await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'stream-resident', joinedAt: WORLD_TIME })
    await f.db.insert(personStates).values({ personId: 'stream-resident', timelineId: 'home-main', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })
    await f.db.insert(conversations).values({ id: 'stream-conversation', userId: 'owner', personId: 'stream-resident', timelineId: 'home-main' })
    const encoder = new TextEncoder()
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Half a reply"}}]}\n\n'))
        else controller.error(new Error('model stream lost'))
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } })))
    const response = await app.request('/api/conversations/stream-conversation/messages', { method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Hello' }) }, f.env)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('model stream lost')
    expect((await f.db.select().from(messages).where(eq(messages.conversationId, 'stream-conversation')).all())
      .map(message => message.role)).toEqual(['user'])

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"Complete reply"}}]}\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    )))
    const completed = await app.request('/api/conversations/stream-conversation/messages', { method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Try again' }) }, f.env)
    expect(completed.status).toBe(200)
    await completed.text()
    expect((await f.db.select().from(messages).where(eq(messages.conversationId, 'stream-conversation')).all())
      .filter(message => message.role === 'person').map(message => message.content)).toEqual(['Complete reply'])
  })

  it('denies cross-account access to conversations, memories, chapters, and timelines without side effects', async () => {
    fixture = await createWorldFixture()
    const f = fixture
    await f.db.insert(sessions).values({ token: 'other-token', userId: 'other', expiresAt: '2099-01-01T00:00:00.000Z' })
    await f.db.insert(persons).values({ id: 'owner-person', userId: 'owner', name: 'Owner person', modelJson: '{}', createdAt: WORLD_TIME })
    await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'owner-person', joinedAt: WORLD_TIME })
    await f.db.insert(personStates).values({ personId: 'owner-person', timelineId: 'home-main', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })
    await f.db.insert(conversations).values({ id: 'owner-conversation', userId: 'owner', personId: 'owner-person', timelineId: 'home-main' })
    await f.db.insert(messages).values({ id: 'owner-message', conversationId: 'owner-conversation', role: 'person', content: 'Private conversation', createdAt: WORLD_TIME })
    await f.db.insert(memories).values({ id: 'owner-memory', personId: 'owner-person', timelineId: 'home-main', type: 'world', content: 'Private memory', createdAt: WORLD_TIME })
    await f.db.insert(chapters).values({ id: 'owner-chapter', worldId: 'home-world', timelineId: 'home-main', title: 'Private', content: 'Private chapter', fromSim: WORLD_TIME, toSim: WORLD_TIME, eventCount: 0, createdAt: WORLD_TIME })

    const otherAuth = { Authorization: 'Bearer other-token', 'Content-Type': 'application/json' }
    expect((await app.request('/api/conversations/owner-conversation/messages', { headers: otherAuth }, f.env)).status).toBe(404)
    expect((await app.request('/api/conversations/owner-conversation/messages', { method: 'POST', headers: otherAuth,
      body: JSON.stringify({ content: 'Should not run' }) }, f.env)).status).toBe(404)
    expect((await app.request('/api/memories/owner-memory', { method: 'PATCH', headers: otherAuth,
      body: JSON.stringify({ content: 'Stolen' }) }, f.env)).status).toBe(404)
    expect((await app.request('/api/memories/owner-memory', { method: 'DELETE', headers: otherAuth }, f.env)).status).toBe(404)
    expect((await app.request('/api/chapters/owner-chapter', { headers: otherAuth }, f.env)).status).toBe(404)
    expect((await app.request('/api/worlds/home-world/chapters', { headers: { Authorization: 'Bearer other-token' } }, f.env)).status).toBe(404)
    expect((await app.request('/api/timelines/home-main', { headers: { Authorization: 'Bearer other-token' } }, f.env)).status).toBe(404)
    expect((await app.request('/api/timelines/home-main/archive', { method: 'POST', headers: { Authorization: 'Bearer other-token' } }, f.env)).status).toBe(404)
    expect(await f.db.select().from(messages).all()).toHaveLength(1)
    expect(await f.db.select().from(memories).where(eq(memories.id, 'owner-memory')).get()).toMatchObject({ content: 'Private memory' })
  })
})
