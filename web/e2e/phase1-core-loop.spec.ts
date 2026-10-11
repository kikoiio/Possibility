import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const voxelDoc = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))

const person = { id: 'person-1', name: 'Ada', createdAt: '2026-01-01T00:00:00.000Z' }
const world = {
  name: '阶段一雾影庄',
  description: '白雾町的一座旧宅、温室和石灯庭院。',
  locations: [
    { name: '主楼', description: '旧宅主楼' },
    { name: '温室', description: '玻璃温室' },
    { name: '庭院', description: '石灯庭院' },
  ],
}
const snapshot = {
  world: { id: 'phase1-core-world', ...world, status: 'running', pauseReason: null, isDemo: false, callsToday: 0 },
  timelines: [{ id: 'phase1-core-timeline', parentTimelineId: null, simNow: '2026-10-02T12:00:00.000Z' }],
  currentTimelineId: 'phase1-core-timeline',
  simNow: '2026-10-02T12:00:00.000Z',
  stateVersion: 1,
  worldModelVersion: 1,
  evidenceStatus: 'structured',
  evidence: { level: 'complete', reasonCodes: [] },
  currentFacts: [],
  locationBoard: [{ location: '主楼', persons: [{ ...person, activity: '正在安顿' }] }],
  events: [],
}

type DraftResponse = { status?: number; json: Record<string, unknown> }
type CreateResponse = { status?: number; json: Record<string, unknown> }

function draftResponse(overrides: Record<string, unknown> = {}): DraftResponse {
  return {
    json: {
      world,
      document: voxelDoc,
      explanation: '旧宅、温室与庭院已就位。',
      warnings: [],
      callsUsed: 2,
      source: 'generated',
      fallback: false,
      contentHash: 'phase1-generated-hash',
      ...overrides,
    },
  }
}

function mapBootstrap() {
  return {
    access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false },
    world: snapshot,
    scene: { status: 'ready', document: voxelDoc },
    presentation: {
      timelineId: snapshot.currentTimelineId,
      stateVersion: 1,
      simNow: snapshot.simNow,
      timeOfDay: 'day',
      weather: { kind: null, label: null },
      residents: [],
      locations: [],
      signals: [],
    },
    theme: { id: 'mist-manor', assetVersion: 'phase1-fixture' },
    resume: { worldId: snapshot.world.id, timelineId: snapshot.currentTimelineId, spaceId: 'exterior', mode: 'life', updatedAt: snapshot.simNow },
  }
}

async function installCoreRoutes(page: Page, options: {
  drafts: DraftResponse[]
  onCreate?: (body: Record<string, unknown>, attempt: number) => CreateResponse
}) {
  const draftBodies: Record<string, unknown>[] = []
  const createBodies: Record<string, unknown>[] = []

  await page.addInitScript(() => localStorage.setItem('possibility_token', 'phase1-e2e-token'))
  await page.route('**/api/persons', route => route.fulfill({ json: { persons: [person] } }))
  await page.route('**/api/scene-drafts/voxel', async route => {
    draftBodies.push(route.request().postDataJSON() as Record<string, unknown>)
    const response = options.drafts[Math.min(draftBodies.length - 1, options.drafts.length - 1)]!
    return route.fulfill({ status: response.status ?? 200, json: response.json })
  })
  await page.route('**/api/worlds', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { worlds: [] } })
    const body = route.request().postDataJSON() as Record<string, unknown>
    createBodies.push(body)
    const response = options.onCreate?.(body, createBodies.length) ?? { json: { id: snapshot.world.id, timelineId: snapshot.currentTimelineId } }
    return route.fulfill({ status: response.status ?? 200, json: response.json })
  })
  await page.route('**/api/worlds/phase1-core-world**', async route => {
    const url = route.request().url()
    if (url.includes('/map/bootstrap')) return route.fulfill({ json: mapBootstrap() })
    if (url.includes('/map/resume')) return route.fulfill({ json: { ok: true } })
    if (url.includes('/stream')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' })
    return route.fulfill({ json: snapshot })
  })

  return { draftBodies, createBodies }
}

async function fillAndGenerate(page: Page, prompt = '白雾缭绕的山间旧宅，有温室和石灯庭院。') {
  await page.goto('/worlds/new?person=person-1')
  await page.getByTestId('scene-prompt').fill(prompt)
  await expect(page.getByRole('button', { name: person.name })).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('generate-scene').click()
}

test('phase 1A creates a valid scene, enters the world, and restores it after refresh', async ({ page }) => {
  const routes = await installCoreRoutes(page, { drafts: [draftResponse()] })

  await fillAndGenerate(page)
  await expect(page.getByTestId('voxel-create-workspace')).toBeVisible()
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible()
  await page.getByTestId('start-life').click()

  await expect(page.getByTestId('create-live-banner')).toBeVisible()
  await expect(page).toHaveURL(/\/worlds\/phase1-core-world$/)
  expect(routes.createBodies).toHaveLength(1)
  expect(routes.createBodies[0]).toMatchObject({
    name: world.name,
    description: world.description,
    locations: world.locations,
    personIds: [person.id],
    sceneRequestId: expect.any(String),
    scene: { format: 'voxel-document' },
  })

  await page.reload()
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15_000 })
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 15_000 })
  expect(routes.draftBodies).toHaveLength(1)
})

test('an invalid deterministic candidate keeps the draft context and can be retried into a valid scene', async ({ page }) => {
  const routes = await installCoreRoutes(page, {
    drafts: [
      { status: 502, json: {
        error: '场景暂时没有生成成功，请按建议调整描述后重试。',
        kind: 'content',
        callsUsed: 2,
        issues: [{ code: 'invalid-entry', message: '入口需要调整。', summary: '入口目前无法顺利到达。', suggestion: '请减少隔断，再重新生成。' }],
      } },
      draftResponse({ explanation: '入口已经修整，主楼、温室与庭院可以连通。', contentHash: 'phase1-repaired-hash' }),
    ],
  })

  await fillAndGenerate(page, '一个有温室和庭院的山间旧宅。')
  await expect(page.getByTestId('create-error')).toContainText('入口目前无法顺利到达')
  await expect(page.getByTestId('create-error')).toContainText('请减少隔断，再重新生成')
  await expect(page.getByTestId('scene-prompt')).toHaveValue('一个有温室和庭院的山间旧宅。')

  await page.getByTestId('generate-scene').click()
  await expect(page.getByTestId('voxel-create-workspace')).toBeVisible()
  await expect(page.getByText('入口已经修整，主楼、温室与庭院可以连通。')).toBeVisible()
  await page.getByTestId('start-life').click()
  await expect(page.getByTestId('create-live-banner')).toBeVisible()
  expect(routes.draftBodies).toHaveLength(2)
  expect(routes.draftBodies[1]!.requestId).toBe(routes.draftBodies[0]!.requestId)
})

test('a deterministic fallback draft is explicitly marked and remains enterable', async ({ page }) => {
  const routes = await installCoreRoutes(page, {
    drafts: [draftResponse({
      source: 'fallback',
      fallback: true,
      callsUsed: 3,
      contentHash: 'phase1-fallback-hash',
      explanation: '生成多次未通过检查，已准备确定性保底场景。',
      warnings: ['已保留后续修复入口。'],
      actions: ['enter', 'repair'],
    })],
  })

  await fillAndGenerate(page, '一座有小路、主楼和花园的旧宅。')
  await expect(page.getByTestId('fallback-ready')).toContainText('确定性保底场景')
  await expect(page.getByTestId('fallback-ready')).toContainText('保存后仍可继续修复')
  await page.getByTestId('start-life').click()
  await expect(page.getByTestId('create-live-banner')).toBeVisible()
  expect(routes.createBodies[0]).toMatchObject({ sceneRequestId: expect.any(String), scene: { format: 'voxel-document' } })
})

test('a lost create response is recovered with the same request id and payload', async ({ page }) => {
  const routes = await installCoreRoutes(page, {
    drafts: [draftResponse()],
    onCreate: (_body, attempt) => attempt === 1
      ? { status: 503, json: { error: '创建结果暂时无法确认' } }
      : { json: { id: snapshot.world.id, timelineId: snapshot.currentTimelineId } },
  })

  await fillAndGenerate(page)
  await expect(page.getByTestId('voxel-create-workspace')).toBeVisible()
  await page.getByTestId('start-life').click()
  await expect(page.getByRole('alert')).toContainText('创建结果暂时无法确认')
  await expect(page.getByTestId('start-life')).toBeEnabled()
  await expect.poll(async () => page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('possibility:world-create:v1') ?? 'null') as { context?: { createRequest?: { requestId?: string } } } | null
    return stored?.context?.createRequest?.requestId ?? null
  })).toBeTruthy()

  await page.reload()
  await expect(page.getByTestId('voxel-create-workspace')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('start-life').click()
  await expect(page).toHaveURL(/\/worlds\/phase1-core-world$/)

  expect(routes.createBodies).toHaveLength(2)
  expect(routes.createBodies[1]!.sceneRequestId).toBe(routes.createBodies[0]!.sceneRequestId)
  expect(routes.createBodies[1]).toEqual(routes.createBodies[0])
})

