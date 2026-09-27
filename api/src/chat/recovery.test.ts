import { afterEach, expect, it, vi } from 'vitest'
import { conversations, chatRequests, messages, persons, personStates, sessions, worldPersons } from '../db/schema'
import app from '../index'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { cancelChatRequest, ChatRequestConflict, ChatRequestTerminalError, completeChatRequest,
  failChatRequest, heartbeatChatRequest, recoverExpiredChatRequests, reserveChatRequest } from './requests'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null; vi.unstubAllGlobals() })

async function setup() {
  fixture = await createWorldFixture()
  const model = { identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [],
    boundaries: [], unknowns: [] }
  await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident',
    modelJson: JSON.stringify(model), createdAt: WORLD_TIME })
  await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await fixture.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })
  await fixture.db.insert(conversations).values(
    { id: 'conversation-a', userId: 'owner', personId: 'resident', timelineId: 'home-main' },
  )
  return fixture
}

const input = {
  requestId: 'stable-request', conversationId: 'conversation-a', userId: 'owner', worldId: 'home-world',
  timelineId: 'home-main', personId: 'resident', content: 'Hello there.', now: new Date(WORLD_TIME),
}

it('atomically reserves one pending request and its preallocated user message', async () => {
  const f = await setup()
  const result = await reserveChatRequest(f.db, input)
  expect(result).toMatchObject({ created: true, request: {
    requestId: 'stable-request', status: 'pending', userMessageId: 'chat:user:stable-request',
    replyMessageId: 'chat:reply:stable-request', heartbeatAt: Date.parse(WORLD_TIME),
  } })
  expect(await f.db.select().from(messages).all()).toEqual([expect.objectContaining({
    id: 'chat:user:stable-request', conversationId: 'conversation-a', role: 'user', content: 'Hello there.',
  })])
  expect(JSON.stringify(await f.db.select().from(chatRequests).all())).not.toContain('Hello there.')
})

it('discovers pending requests by owner and conversation without sharing browser-local storage', async () => {
  const f = await setup()
  await reserveChatRequest(f.db, { ...input, requestId: 'browser-a-pending' })
  await reserveChatRequest(f.db, { ...input, requestId: 'browser-a-completed' })
  await completeChatRequest(f.db, 'browser-a-completed', 'Done.')
  await f.db.insert(sessions).values({ token: 'other-token', userId: 'other', expiresAt: '2099-01-01T00:00:00.000Z' })
  const headers = { Authorization: 'Bearer owner-token' }

  const recovered = await app.request('/api/conversations/conversation-a/requests/pending', { headers }, f.env)
  expect(await recovered.json()).toEqual({ requests: [expect.objectContaining({
    requestId: 'browser-a-pending', status: 'pending', heartbeatAt: Date.parse(WORLD_TIME),
  })] })
  expect((await app.request('/api/conversations/unknown/requests/pending', { headers }, f.env)).status).toBe(404)
  expect((await app.request('/api/conversations/conversation-a/requests/pending', {
    headers: { Authorization: 'Bearer other-token' },
  }, f.env)).status).toBe(404)
})

it('replays the same ownership and payload without inserting another message', async () => {
  const f = await setup()
  const first = await reserveChatRequest(f.db, input)
  const replay = await reserveChatRequest(f.db, input)
  expect(replay).toEqual({ created: false, request: first.request })
  expect(await f.db.select().from(messages).all()).toHaveLength(1)
  expect(await f.db.select().from(chatRequests).all()).toHaveLength(1)
})

it('rejects content, conversation, and ownership reuse of one request id', async () => {
  const f = await setup()
  await reserveChatRequest(f.db, input)
  for (const changed of [
    { content: 'Different payload.' },
    { conversationId: 'conversation-b' },
    { userId: 'other' },
    { worldId: 'other-world' },
    { timelineId: 'other-main' },
    { personId: 'another-person' },
  ]) {
    await expect(reserveChatRequest(f.db, { ...input, ...changed })).rejects.toBeInstanceOf(ChatRequestConflict)
  }
  expect(await f.db.select().from(messages).all()).toHaveLength(1)
})

it('allows exactly one winner under concurrent identical reservations', async () => {
  const f = await setup()
  const results = await Promise.all(Array.from({ length: 8 }, () => reserveChatRequest(f.db, input)))
  expect(results.filter(result => result.created)).toHaveLength(1)
  expect(results.filter(result => !result.created)).toHaveLength(7)
  expect(await f.db.select().from(chatRequests).all()).toHaveLength(1)
  expect(await f.db.select().from(messages).all()).toHaveLength(1)
})

it('rolls back the user message when request persistence fails', async () => {
  const f = await setup()
  f.sqlite.exec("CREATE TRIGGER reject_chat_request BEFORE INSERT ON chat_requests BEGIN SELECT RAISE(ABORT, 'forced request failure'); END")
  await expect(reserveChatRequest(f.db, input)).rejects.toThrow('forced request failure')
  expect(await f.db.select().from(chatRequests).all()).toEqual([])
  expect(await f.db.select().from(messages).all()).toEqual([])
})

it('atomically stores the preallocated reply and completed terminal state', async () => {
  const f = await setup()
  await reserveChatRequest(f.db, input)
  const completedAt = new Date('2026-09-21T08:01:00.000Z')
  await expect(completeChatRequest(f.db, input.requestId, 'A complete reply.', completedAt)).resolves.toMatchObject({
    status: 'completed', replyMessageId: 'chat:reply:stable-request', errorCode: null,
    finishedAt: completedAt.toISOString(), heartbeatAt: completedAt.getTime(),
  })
  expect(await f.db.select().from(messages).all()).toEqual([
    expect.objectContaining({ id: 'chat:user:stable-request', role: 'user' }),
    expect.objectContaining({ id: 'chat:reply:stable-request', role: 'person', content: 'A complete reply.' }),
  ])
})

it('updates heartbeat only while pending and preserves terminal timestamps', async () => {
  const f = await setup()
  await reserveChatRequest(f.db, input)
  const beat = new Date('2026-09-21T08:00:30.000Z')
  expect(await heartbeatChatRequest(f.db, input.requestId, beat)).toBe(true)
  expect((await f.db.select().from(chatRequests).get())?.heartbeatAt).toBe(beat.getTime())
  await failChatRequest(f.db, input.requestId, 'transport_error', new Date('2026-09-21T08:01:00.000Z'))
  expect(await heartbeatChatRequest(f.db, input.requestId, new Date('2026-09-21T08:02:00.000Z'))).toBe(false)
  expect(await f.db.select().from(chatRequests).get()).toMatchObject({ status: 'failed', errorCode: 'transport_error',
    heartbeatAt: Date.parse('2026-09-21T08:01:00.000Z') })
})

it('cancels and expires pending requests without leaving a reply', async () => {
  const f = await setup()
  await reserveChatRequest(f.db, input)
  await cancelChatRequest(f.db, input.requestId, new Date('2026-09-21T08:01:00.000Z'))
  expect(await f.db.select().from(chatRequests).get()).toMatchObject({ status: 'cancelled', errorCode: 'request_cancelled' })
  expect(await f.db.select().from(messages).all()).toHaveLength(1)

  await reserveChatRequest(f.db, { ...input, requestId: 'expired-request', now: new Date('2026-09-21T07:00:00.000Z') })
  await reserveChatRequest(f.db, { ...input, requestId: 'live-request', now: new Date('2026-09-21T08:00:30.000Z') })
  expect(await recoverExpiredChatRequests(f.db, Date.parse('2026-09-21T08:00:00.000Z'),
    new Date('2026-09-21T08:02:00.000Z'))).toEqual(['expired-request'])
  expect((await f.db.select().from(chatRequests).all()).map(row => [row.requestId, row.status])).toEqual([
    ['stable-request', 'cancelled'], ['expired-request', 'failed'], ['live-request', 'pending'],
  ])
})

it('fences a late worker after cancellation and rolls back its reply', async () => {
  const f = await setup()
  await reserveChatRequest(f.db, input)
  await cancelChatRequest(f.db, input.requestId)
  await expect(completeChatRequest(f.db, input.requestId, 'Too late.')).rejects.toBeInstanceOf(ChatRequestTerminalError)
  expect((await f.db.select().from(messages).all()).map(row => row.id)).toEqual(['chat:user:stable-request'])
})

it('rolls back reply insertion when completion state update fails', async () => {
  const f = await setup()
  await reserveChatRequest(f.db, input)
  f.sqlite.exec("CREATE TRIGGER reject_chat_completion BEFORE UPDATE OF status ON chat_requests WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'forced completion failure'); END")
  await expect(completeChatRequest(f.db, input.requestId, 'Must roll back.')).rejects.toThrow('forced completion failure')
  expect((await f.db.select().from(messages).all()).map(row => row.id)).toEqual(['chat:user:stable-request'])
  expect(await f.db.select().from(chatRequests).get()).toMatchObject({ status: 'pending', finishedAt: null })
})

it('lets a second client observe and replay one in-flight API request without another model call', async () => {
  const f = await setup()
  f.sqlite.exec("INSERT OR IGNORE INTO universe_evidence (timeline_id, level, assessed_version, baseline_version, reason_codes_json, assessed_at) VALUES ('home-main', 'complete', 0, 0, '[\"test_complete\"]', '2026-09-21T08:00:00.000Z')")
  const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
  let markStarted!: () => void
  let releaseModel!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const held = new Promise<void>(resolve => { releaseModel = resolve })
  const modelFetch = vi.fn(async () => {
    markStarted()
    await held
    return new Response(
      'data: {"choices":[{"delta":{"content":"One durable reply."}}]}\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
  })
  vi.stubGlobal('fetch', modelFetch)

  // Client A starts consuming the SSE while the provider remains deliberately blocked.
  const clientA = await app.request('/api/conversations/conversation-a/messages', { method: 'POST', headers,
    body: JSON.stringify({ content: 'Cross-device hello.', requestId: 'cross-device-request' }) }, f.env)
  const clientABody = clientA.text()
  await started

  // Client B can see the durable pending row and replaying the request never starts another provider call.
  const pending = await app.request('/api/conversations/conversation-a/requests/cross-device-request',
    { headers }, f.env)
  expect(await pending.json()).toMatchObject({ status: 'pending', userMessageId: 'chat:user:cross-device-request',
    replyMessageId: 'chat:reply:cross-device-request', reply: null })
  const pendingReplay = await app.request('/api/conversations/conversation-a/messages', { method: 'POST', headers,
    body: JSON.stringify({ content: 'Cross-device hello.', requestId: 'cross-device-request' }) }, f.env)
  expect(await pendingReplay.text()).toContain('"type":"pending"')
  expect(modelFetch).toHaveBeenCalledTimes(1)

  releaseModel()
  expect(await clientABody).toContain('One durable reply.')
  const completed = await app.request('/api/conversations/conversation-a/requests/cross-device-request',
    { headers }, f.env)
  expect(await completed.json()).toMatchObject({ status: 'completed',
    reply: { id: 'chat:reply:cross-device-request', content: 'One durable reply.' } })

  const completedReplay = await app.request('/api/conversations/conversation-a/messages', { method: 'POST', headers,
    body: JSON.stringify({ content: 'Cross-device hello.', requestId: 'cross-device-request' }) }, f.env)
  expect(await completedReplay.text()).toContain('"replayed":true')
  expect(modelFetch).toHaveBeenCalledTimes(1)
  expect((await f.db.select().from(messages).all()).map(row => [row.id, row.role])).toEqual([
    ['chat:user:cross-device-request', 'user'], ['chat:reply:cross-device-request', 'person'],
  ])
})
