import { afterEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { chatRequests, conversations, messages, persons, personStates, timelines, universeEvidence, worldPersons } from '../db/schema'
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

  const modelFetch = vi.fn(async () => new Response(
    'data: {"choices":[{"delta":{"content":"A complete reply."}}]}\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  ))
  vi.stubGlobal('fetch', modelFetch)
  const sent = await app.request(`/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: auth,
    body: JSON.stringify({ content: 'Hello there.', requestId: 'chat-route-request' }) }, f.env)
  expect(sent.status).toBe(200)
  expect(await sent.text()).toContain('A complete reply.')
  const history = await f.db.select().from(messages).where(eq(messages.conversationId, conversation.id)).all()
  expect(history.map(message => [message.role, message.content])).toEqual([
    ['user', 'Hello there.'], ['person', 'A complete reply.'],
  ])
  expect(await f.db.select().from(messages).all()).toHaveLength(2)
  expect(await f.db.select().from(chatRequests).all()).toEqual([
    expect.objectContaining({ requestId: 'chat-route-request', status: 'completed' }),
  ])

  const status = await app.request(`/api/conversations/${conversation.id}/requests/chat-route-request`, { headers: auth }, f.env)
  expect(await status.json()).toMatchObject({ status: 'completed', requestId: 'chat-route-request',
    reply: { id: 'chat:reply:chat-route-request', content: 'A complete reply.' } })
  const replay = await app.request(`/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: auth,
    body: JSON.stringify({ content: 'Hello there.', requestId: 'chat-route-request' }) }, f.env)
  expect(await replay.text()).toContain('"replayed":true')
  expect(modelFetch).toHaveBeenCalledTimes(1)
  expect(await f.db.select().from(messages).all()).toHaveLength(2)
  expect((await app.request(`/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: auth,
    body: JSON.stringify({ content: 'Different.', requestId: 'chat-route-request' }) }, f.env)).status).toBe(409)

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
