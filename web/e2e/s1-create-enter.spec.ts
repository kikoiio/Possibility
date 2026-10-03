import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const voxelDoc = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))
const prompt = '海边旧车站旁的小街，有咖啡馆、花园和安静的住宅。'
const person = { id: 'person-1', name: '林晚', createdAt: '2026-01-01T00:00:00.000Z' }
const world = {
  name: '海边小镇',
  description: '旧车站旁的一段安静街道。',
  locations: [{ name: '车站街', description: '沿海旧车站旁的街道' }],
}
const personDraft = {
  name: person.name,
  model: {
    identity: [{ text: '经营一家独立书店', provenance: 'known' }],
    behavior: [{ text: '温和而有主见', provenance: 'inferred' }],
    speech: [{ text: '说话平静', provenance: 'inferred' }],
    skills: [], memories: [], relationships: [],
    boundaries: [{ text: '不会假装知道未知的事', provenance: 'known' }],
    unknowns: ['未来会发生什么'],
  },
  worldName: '', worldDescription: '',
  initialState: { location: '', activity: '', mood: '', goal: '' },
}
const snapshot = {
  world: { id: 'new-world', ...world, status: 'running', pauseReason: null, isDemo: false, callsToday: 0 },
  timelines: [{ id: 'timeline-1', parentTimelineId: null, simNow: '2026-10-02T12:00:00.000Z' }],
  currentTimelineId: 'timeline-1', simNow: '2026-10-02T12:00:00.000Z',
  stateVersion: 1, worldModelVersion: 1, evidenceStatus: 'structured',
  evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [],
  locationBoard: [{ location: world.locations[0].name, persons: [{ ...person, activity: '正在安顿' }] }], events: [],
}

async function authenticate(page: Page) {
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
}

async function stubPersons(page: Page, initial: typeof person[] = []) {
  const persons = [...initial]
  await page.route('**/api/persons', async route => {
    if (route.request().method() === 'POST') {
      const created = { id: 'person-new', name: '林晚', createdAt: '2026-10-02T12:00:00.000Z' }
      persons.push(created)
      return route.fulfill({ json: { id: created.id } })
    }
    return route.fulfill({ json: { persons } })
  })
}

async function readSavedContext(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('possibility:world-create:v1')
    if (!raw) return null
    return (JSON.parse(raw) as { context?: Record<string, unknown> }).context ?? null
  })
}

async function readSavedDraft(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('possibility-world-create', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts')
    request.onerror = () => resolve(null)
    request.onsuccess = () => {
      const database = request.result
      const get = database.transaction('drafts', 'readonly').objectStore('drafts').get('current')
      get.onsuccess = () => { database.close(); resolve((get.result as Record<string, unknown> | undefined) ?? null) }
      get.onerror = () => { database.close(); resolve(null) }
    }
  }))
}

async function stubSuccessfulWorldCreate(page: Page) {
  let generationCalls = 0
  let createPayload: Record<string, unknown> | null = null
  let archivePayload: Record<string, unknown> | null = null
  await page.route('**/api/scene-drafts/voxel', route => {
    generationCalls += 1
    return route.fulfill({ json: {
      world, document: voxelDoc, explanation: '车站街、咖啡馆和花园已就位。', warnings: [], callsUsed: 2,
    } })
  })
  await page.route('**/api/worlds', async route => {
    if (route.request().method() === 'POST') {
      createPayload = route.request().postDataJSON()
      return route.fulfill({ json: { id: 'new-world', timelineId: 'timeline-1' } })
    }
    return route.fulfill({ json: { worlds: [] } })
  })
  await page.route('**/api/worlds/old-world/archive', async route => {
    archivePayload = route.request().postDataJSON()
    return route.fulfill({ json: { ok: true, status: 'archived' } })
  })
  await page.route('**/api/worlds/new-world**', route => {
    if (route.request().url().includes('/map/bootstrap')) return route.fulfill({ json: {
      access: { observe: true, participate: true, editScene: false, fork: true, compare: true, persist: true, resetDemo: false },
      world: snapshot,
      scene: { status: 'ready', document: voxelDoc },
      presentation: { timelineId: 'timeline-1', stateVersion: 1, simNow: snapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
      theme: { id: 'mist-manor', assetVersion: 'fixture' },
      resume: { worldId: 'new-world', timelineId: 'timeline-1', spaceId: 'exterior', mode: 'life', updatedAt: snapshot.simNow },
    } })
    return route.fulfill({ json: { ok: true } })
  })
  return {
    getGenerationCalls: () => generationCalls,
    getCreatePayload: () => createPayload,
    getArchivePayload: () => archivePayload,
  }
}

test('no-person creation link returns with prompt and new resident selected', async ({ page }) => {
  await authenticate(page)
  await stubPersons(page)
  await page.route('**/api/persons/distill', route => route.fulfill({ json: personDraft }))

  await page.goto('/worlds/new')
  await page.getByTestId('scene-prompt').fill(prompt)
  await page.getByRole('link', { name: '创建一位人物' }).click()
  await expect(page).toHaveURL(/\/people\/new\?returnTo=\/worlds\/new$/)

  await page.getByPlaceholder(/林晚，32岁/).fill('林晚，经营一家独立书店。')
  await page.getByRole('button', { name: '生成人物卡' }).click()
  await page.getByRole('button', { name: '确认创建这个 Version' }).click()

  await expect(page).toHaveURL(/\/worlds\/new\?person=person-new$/)
  await expect(page.getByTestId('scene-prompt')).toHaveValue(prompt)
  await expect(page.getByRole('button', { name: '林晚' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('generate-scene')).toBeEnabled()
})

test('failed generation restores prompt, resident selection, and actionable error after refresh', async ({ page }) => {
  await authenticate(page)
  await stubPersons(page, [person])
  let generationCalls = 0
  await page.route('**/api/scene-drafts/voxel', async route => {
    generationCalls += 1
    return route.fulfill({ status: 422, json: {
      error: '场景暂时未能通过检查。', kind: 'content', callsUsed: 2,
      issues: [{ code: 'layout', message: '布局需要调整。', summary: '通道安排得比较紧密。', suggestion: '试试减少隔断，再重新生成。' }],
    } })
  })

  await page.goto('/worlds/new')
  await page.getByTestId('scene-prompt').fill(prompt)
  await page.getByRole('button', { name: person.name }).click()
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('possibility:world-create:v1') ?? 'null')?.context?.selectedPersonIds)).toEqual(['person-1'])
  await page.getByTestId('generate-scene').click()
  await expect(page.getByTestId('create-error')).toContainText('通道安排得比较紧密。')
  await expect(page.getByTestId('create-error')).toContainText('本次已使用 2 次模型调用。')
  await expect(page.getByTestId('error-goto-settings')).toHaveCount(0)
  await expect.poll(() => readSavedContext(page)).toMatchObject({
    prompt,
    selectedPersonIds: ['person-1'],
    error: { message: '场景暂时未能通过检查。', kind: 'content', callsUsed: 2 },
  })

  await page.reload()
  await expect(page.getByTestId('scene-prompt')).toHaveValue(prompt)
  await expect(page.getByRole('button', { name: person.name })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('create-error')).toContainText('试试减少隔断，再重新生成。')
  await expect(page.getByTestId('error-goto-settings')).toHaveCount(0)
  expect(generationCalls).toBe(1)
})

test('saved voxel draft restores after refresh and creates a world without regenerating', async ({ page }) => {
  await authenticate(page)
  await stubPersons(page, [person])
  const routes = await stubSuccessfulWorldCreate(page)

  await page.goto('/worlds/new?person=person-1&fromWorld=old-world')
  await page.getByTestId('scene-prompt').fill(prompt)
  await expect(page.getByRole('button', { name: person.name })).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('generate-scene').click()
  await expect(page.getByTestId('voxel-create-workspace')).toBeVisible()
  await expect.poll(() => readSavedContext(page)).toMatchObject({ prompt, selectedPersonIds: ['person-1'] })
  await expect.poll(() => readSavedDraft(page)).toMatchObject({
    draft: { draft: { world: { name: world.name } } },
  })

  await page.reload()
  await expect(page.getByTestId('voxel-create-workspace')).toBeVisible()
  await expect(page.getByTestId('start-life')).toBeEnabled()
  await expect(page.getByTestId('scene-prompt')).toHaveCount(0)
  await page.getByTestId('start-life').click()

  await expect(page.getByTestId('create-live-banner')).toBeVisible()
  await expect(page).toHaveURL(/\/worlds\/new-world$/)
  expect(routes.getGenerationCalls()).toBe(1)
  expect(routes.getCreatePayload()).toMatchObject({ personIds: ['person-1'], name: world.name })
  expect((routes.getCreatePayload()?.scene as { format?: string } | undefined)?.format).toBe('voxel-document')
  expect(routes.getArchivePayload()).toEqual({ pauseReason: '已在新世界中安家' })
  expect(await page.evaluate(() => localStorage.getItem('possibility:world-create:v1'))).toBeNull()
})

test('person without a world has a creation guide and disabled world-dependent actions', async ({ page }) => {
  await authenticate(page)
  await page.route('**/api/persons/person-1', route => route.fulfill({ json: {
    person: { ...person, model: personDraft.model }, world: null, state: null, timelines: [],
  } }))
  await stubPersons(page, [person])

  await page.goto('/people/person-1')
  await expect(page.getByText('TA 还没有生活的地方')).toBeVisible()
  await expect(page.getByRole('button', { name: '打电话' })).toBeDisabled()
  await page.getByRole('button', { name: '时间线' }).click()
  await expect(page.getByRole('button', { name: /创建一个 What-if 分叉/ })).toBeDisabled()
  await expect(page.getByText('证据只读保护')).toHaveCount(0)
  await page.getByRole('link', { name: '为 TA 创造地方' }).click()

  await expect(page).toHaveURL(/\/worlds\/new\?person=person-1$/)
  await expect(page.getByRole('button', { name: person.name })).toHaveAttribute('aria-pressed', 'true')
})

test.describe('S4B 世界时区创建旅程', () => {
  test.use({ timezoneId: 'Asia/Tokyo' })

  test('创建请求携带浏览器 IANA zone,创建后世界时钟按该 zone 显示', async ({ page }) => {
    await authenticate(page)
    await stubPersons(page, [person])
    const routes = await stubSuccessfulWorldCreate(page)
    await page.route('**/api/worlds/new-world/map/bootstrap**', route => route.fulfill({ json: {
      access: { observe: true, participate: true, editScene: false, fork: true, compare: true, persist: true, resetDemo: false },
      world: { ...snapshot, world: { ...snapshot.world, timeZone: 'Asia/Tokyo' }, timelines: snapshot.timelines.map(timeline => ({ ...timeline, timeZone: 'Asia/Tokyo' })) },
      scene: { status: 'ready', document: voxelDoc },
      presentation: { timelineId: 'timeline-1', stateVersion: 1, simNow: snapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
      theme: { id: 'mist-manor', assetVersion: 'fixture' },
      resume: { worldId: 'new-world', timelineId: 'timeline-1', spaceId: 'exterior', mode: 'life', updatedAt: snapshot.simNow },
    } }))

    await page.goto('/worlds/new?person=person-1')
    await page.getByTestId('scene-prompt').fill(prompt)
    await expect(page.getByRole('button', { name: person.name })).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('generate-scene').click()
    await expect(page.getByTestId('voxel-create-workspace')).toBeVisible()
    await page.getByTestId('start-life').click()

    await expect(page.getByTestId('create-live-banner')).toBeVisible()
    expect(routes.getCreatePayload()).toMatchObject({ timeZone: 'Asia/Tokyo' })
    await expect(page.getByTestId('create-live-banner')).toContainText('2026-10-02 21:00 (Asia/Tokyo)')
  })
})
