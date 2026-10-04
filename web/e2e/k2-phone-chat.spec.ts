import { expect, test } from '@playwright/test'

const simNow = '2026-10-04T08:00:00.000Z'
const person = { id: 'resident-1', name: '林晚', createdAt: simNow }
const state = { simTime: simNow, location: '车站街', activity: '读书', mood: '平静', goal: '继续阅读' }
const model = { identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] }

test('人物页电话入口发送普通聊天，并读取 phone 完成回执', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/api/persons/resident-1', route => route.fulfill({ json: {
    person: { ...person, model },
    world: { id: 'world-1', name: '海边小镇', description: '', timeZone: 'UTC' },
    state,
    timelines: [{ id: 'timeline-1', parentTimelineId: null, simNow, createdAt: simNow }],
  } }))
  await page.route('**/api/timelines/timeline-1', route => route.fulfill({ json: {
    timeline: { id: 'timeline-1', worldId: 'world-1', parentTimelineId: null, simNow, createdAt: simNow },
    world: { id: 'world-1', name: '海边小镇', description: '', timeZone: 'UTC' },
    person: { id: person.id, name: person.name }, events: [], state, evidence: { level: 'complete', reasonCodes: [] },
  } }))
  await page.route('**/api/persons/resident-1/conversations', route => route.fulfill({ json: {
    id: 'conversation-1', personId: person.id, timelineId: 'timeline-1',
  } }))
  await page.route('**/api/conversations/conversation-1/catchup', route => route.fulfill({ status: 200,
    contentType: 'text/event-stream', body: 'data: {"type":"skipped"}\n\ndata: {"type":"done"}\n\n' }))
  let posted: Record<string, unknown> | null = null
  await page.route('**/api/conversations/conversation-1/messages', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { messages: posted ? [
      { id: 'user-message', conversationId: 'conversation-1', role: 'user', content: posted.content, createdAt: simNow },
      { id: 'reply-message', conversationId: 'conversation-1', role: 'person', content: '我在电话里听见你了。', createdAt: simNow },
    ] : [] } })
    posted = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 200, contentType: 'text/event-stream',
      body: 'data: {"type":"text","delta":"我在电话里听见你了。"}\n\ndata: {"type":"done"}\n\n' })
  })
  await page.route('**/api/conversations/conversation-1/requests/pending', route => route.fulfill({ json: { requests: [] } }))
  await page.route('**/api/conversations/conversation-1/requests/*', async route => {
    const requestId = new URL(route.request().url()).pathname.split('/').at(-1)!
    if (requestId === 'pending') return route.fulfill({ json: { requests: [] } })
    if (route.request().method() === 'GET') return route.fulfill({ json: {
      requestId, conversationId: 'conversation-1', worldId: 'world-1', timelineId: 'timeline-1', personId: person.id,
      channel: 'phone', userMessageId: `chat:user:${requestId}`, replyMessageId: `chat:reply:${requestId}`, status: 'completed',
      heartbeatAt: Date.now(), createdAt: simNow, updatedAt: simNow, finishedAt: simNow, errorCode: null,
      reply: { id: `chat:reply:${requestId}`, role: 'person', content: '我在电话里听见你了。', createdAt: simNow },
    } })
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"done"}\n\n' })
  })

  await page.goto('/people/resident-1')
  await expect(page.getByRole('heading', { name: '林晚' })).toBeVisible()
  const input = page.getByPlaceholder('说点什么…')
  await input.fill('我还在别处，通过电话联系你。')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('我在电话里听见你了。')).toBeVisible()
  await expect.poll(() => posted).toMatchObject({ content: '我还在别处，通过电话联系你。' })
  // The API enforces phone on its side; the browser sends no channel, location, or participant assertions.
  expect(posted).not.toHaveProperty('channel')
  expect(posted).not.toHaveProperty('location')
  expect(posted).not.toHaveProperty('participants')
})
