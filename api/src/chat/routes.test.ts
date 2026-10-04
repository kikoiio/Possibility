import { afterEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { chatRequests, conversations, events, memories, messages, persons, personStates, timelines,
  universeEvidence, worldCommands, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { reserveChatRequest } from './requests'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null; vi.unstubAllGlobals() })

const auth = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }

it('binds a normal conversation and its completed reply to the selected timeline', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  const model = { identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] }
  await f.db.insert(persons).values({ id: 'chat-resident', userId: 'owner', name: 'Resident',
    modelJson: JSON.stringify(model), createdAt: WORLD_TIME })
  await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'chat-resident', joinedAt: WORLD_TIME })
  await f.db.insert(timelines).values({ id: 'home-child', worldId: 'home-world', parentTimelineId: 'home-main',
    simNow: WORLD_TIME, createdAt: WORLD_TIME })
  await f.db.insert(universeEvidence).values({ timelineId: 'home-child', level: 'complete', assessedVersion: 0,
    baselineVersion: 0, reasonCodesJson: '["test_complete"]', assessedAt: WORLD_TIME })
  await f.db.insert(personStates).values(['home-main', 'home-child'].map(timelineId => ({ personId: 'chat-resident',
    timelineId, simTime: WORLD_TIME, location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })))

  const invalid = await app.request('/api/persons/chat-resident/conversations', { method: 'POST', headers: auth,
    body: JSON.stringify({ timelineId: 'other-main' }) }, f.env)
  expect(invalid.status).toBe(404)
  expect(await f.db.select().from(conversations).all()).toHaveLength(0)

  const created = await app.request('/api/persons/chat-resident/conversations', { method: 'POST', headers: auth,
    body: JSON.stringify({ timelineId: 'home-child' }) }, f.env)
  expect(created.status).toBe(200)
  const conversation = await created.json() as { id: string; timelineId: string; personId: string }
  expect(conversation).toMatchObject({ timelineId: 'home-child', personId: 'chat-resident' })

  let modelCall = 0
  const toolCalls = [
    { index: 0, id: 'act-1', type: 'function', function: { name: 'act', arguments: JSON.stringify({
      title: '接起电话', description: '我在咖啡馆和用户谈了 secret-phone-canary-9fd1。',
    }) } },
    { index: 1, id: 'state-1', type: 'function', function: { name: 'update_state', arguments: JSON.stringify({
      location: 'Library',
    }) } },
    { index: 2, id: 'memory-1', type: 'function', function: { name: 'remember', arguments: JSON.stringify({
      content: '用户说自己仍在别处，并通过电话澄清。', type: 'relationship', importance: 6,
    }) } },
    { index: 3, id: 'state-2', type: 'function', function: { name: 'update_state', arguments: JSON.stringify({
      mood: 'Glad to hear from the user',
    }) } },
  ]
  const modelFetch = vi.fn(async () => {
    modelCall++
    const frame = modelCall === 1
      ? `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`
      : 'data: {"choices":[{"delta":{"content":"A complete reply."}}]}\n\ndata: [DONE]\n\n'
    return new Response(frame, { headers: { 'Content-Type': 'text/event-stream' } })
  })
  vi.stubGlobal('fetch', modelFetch)
  const sent = await app.request(`/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: auth,
    body: JSON.stringify({ content: '我还在别处，没来现场。', requestId: 'chat-route-request', channel: 'in_person',
      location: 'Library', participants: ['chat-resident', 'owner'] }) }, f.env)
  expect(sent.status).toBe(200)
  const phoneStream = await sent.text()
  expect(phoneStream).toContain('A complete reply.')
  expect(phoneStream).toContain('"activity":"通过电话与用户交谈"')
  const history = await f.db.select().from(messages).where(eq(messages.conversationId, conversation.id)).all()
  expect(history.map(message => [message.role, message.content])).toEqual([
    ['user', '我还在别处，没来现场。'], ['person', 'A complete reply.'],
  ])
  expect(await f.db.select().from(messages).all()).toHaveLength(2)
  expect(await f.db.select().from(chatRequests).all()).toEqual([
    expect.objectContaining({ requestId: 'chat-route-request', channel: 'phone', status: 'completed' }),
  ])
  const phoneState = await f.db.select().from(personStates).where(eq(personStates.timelineId, 'home-child')).get()
  expect(phoneState).toMatchObject({ location: 'Cafe', activity: '通过电话与用户交谈', mood: 'Glad to hear from the user' })
  const commands = await f.db.select().from(worldCommands).all()
  expect(commands).toHaveLength(1)
  expect(commands[0]?.type).toBe('resident_state')
  expect(commands[0]?.payloadJson).toContain('"communicationChannel":"phone"')
  expect(commands[0]?.payloadJson).toContain('"communicationRequestId":"chat-route-request"')
  const savedEvents = await f.db.select().from(events).all()
  expect(savedEvents).toHaveLength(2)
  expect(JSON.stringify(savedEvents)).not.toContain('secret-phone-canary-9fd1')
  expect((await f.db.select().from(memories).all()).some(memory => memory.content === '用户说自己仍在别处，并通过电话澄清。')).toBe(true)

  const status = await app.request(`/api/conversations/${conversation.id}/requests/chat-route-request`, { headers: auth }, f.env)
  expect(await status.json()).toMatchObject({ status: 'completed', requestId: 'chat-route-request',
    reply: { id: 'chat:reply:chat-route-request', content: 'A complete reply.' } })
  const replay = await app.request(`/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: auth,
    body: JSON.stringify({ content: '我还在别处，没来现场。', requestId: 'chat-route-request' }) }, f.env)
  expect(await replay.text()).toContain('"replayed":true')
  expect(modelFetch).toHaveBeenCalledTimes(2)
  expect(await f.db.select().from(messages).all()).toHaveLength(2)
  expect((await app.request(`/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: auth,
    body: JSON.stringify({ content: 'Different.', requestId: 'chat-route-request' }) }, f.env)).status).toBe(409)

  f.sqlite.exec(`CREATE TRIGGER reject_phone_command BEFORE INSERT ON world_commands
    WHEN instr(NEW.payload_json, '"communicationChannel":"phone"') > 0
    BEGIN SELECT RAISE(ABORT, 'forced phone command failure'); END`)
  const failed = await app.request(`/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: auth,
    body: JSON.stringify({ content: 'Another call.', requestId: 'chat-failed-atomic' }) }, f.env)
  expect((await failed.text())).toContain('电话回合提交失败，请重试。')
  expect(await f.db.select().from(chatRequests).where(eq(chatRequests.requestId, 'chat-failed-atomic')).get())
    .toMatchObject({ channel: 'phone', status: 'failed' })
  expect(await f.db.select().from(messages).all()).toHaveLength(3) // failed request retains only its user input
  expect(await f.db.select().from(worldCommands).all()).toHaveLength(1)

  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('injected provider interruption') }))
  const interrupted = await app.request(`/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: auth,
    body: JSON.stringify({ content: 'Interrupted call.', requestId: 'chat-failed-provider' }) }, f.env)
  expect(await interrupted.text()).toContain('injected provider interruption')
  expect(await f.db.select().from(chatRequests).where(eq(chatRequests.requestId, 'chat-failed-provider')).get())
    .toMatchObject({ channel: 'phone', status: 'failed' })
  expect(await f.db.select().from(messages).all()).toHaveLength(4)
  expect(await f.db.select().from(worldCommands).all()).toHaveLength(1)

  await reserveChatRequest(f.db, { requestId: 'cancel-pending', conversationId: conversation.id, userId: 'owner',
    worldId: 'home-world', timelineId: 'home-child', personId: 'chat-resident', content: 'Cancel me.' })
  const cancelled = await app.request(`/api/conversations/${conversation.id}/requests/cancel-pending/cancel`,
    { method: 'POST', headers: auth }, f.env)
  expect(await cancelled.json()).toMatchObject({ status: 'cancelled', errorCode: 'request_cancelled' })

  await reserveChatRequest(f.db, { requestId: 'stale-pending', conversationId: conversation.id, userId: 'owner',
    worldId: 'home-world', timelineId: 'home-child', personId: 'chat-resident', content: 'Recover me.',
    now: new Date(Date.now() - 60_000) })
  await f.db.update(universeEvidence).set({ level: 'incomplete', baselineVersion: null,
    reasonCodesJson: '["missing_checkpoint"]' }).where(eq(universeEvidence.timelineId, 'home-child'))
  const blockedRecovery = await app.request(`/api/conversations/${conversation.id}/requests/stale-pending/recover`,
    { method: 'POST', headers: auth }, f.env)
  expect(blockedRecovery.status).toBe(409)
  expect(await f.db.select().from(chatRequests).where(eq(chatRequests.requestId, 'stale-pending')).get())
    .toMatchObject({ status: 'pending', errorCode: null })
  await f.db.update(universeEvidence).set({ level: 'complete', baselineVersion: 0,
    reasonCodesJson: '["test_complete"]' }).where(eq(universeEvidence.timelineId, 'home-child'))
  const recovered = await app.request(`/api/conversations/${conversation.id}/requests/stale-pending/recover`,
    { method: 'POST', headers: auth }, f.env)
  expect(await recovered.json()).toMatchObject({ status: 'failed', errorCode: 'worker_lost' })
})
