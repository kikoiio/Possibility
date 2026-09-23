import { afterEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { conversations, messages, persons, personStates, timelines, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'

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

  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    'data: {"choices":[{"delta":{"content":"A complete reply."}}]}\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  )))
  const sent = await app.request(`/api/conversations/${conversation.id}/messages`, { method: 'POST', headers: auth,
    body: JSON.stringify({ content: 'Hello there.' }) }, f.env)
  expect(sent.status).toBe(200)
  expect(await sent.text()).toContain('A complete reply.')
  const history = await f.db.select().from(messages).where(eq(messages.conversationId, conversation.id)).all()
  expect(history.map(message => [message.role, message.content])).toEqual([
    ['user', 'Hello there.'], ['person', 'A complete reply.'],
  ])
  expect(await f.db.select().from(messages).all()).toHaveLength(2)
})
