import { expect, test, type APIRequestContext } from '@playwright/test'
import { readFileSync } from 'node:fs'

const sceneFixture = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8')) as Record<string, any>
const personModel = {
  identity: [{ text: '经营雾影庄', provenance: 'known' }],
  behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [],
}

interface ApiPayload { status: number; body: any }

async function requestJson(request: APIRequestContext, path: string, init?: Parameters<APIRequestContext['fetch']>[1]): Promise<ApiPayload> {
  const response = await request.fetch(path, init)
  return { status: response.status(), body: await response.json().catch(() => null) }
}

async function authorized(request: APIRequestContext, token: string, path: string, init: Record<string, unknown> = {}): Promise<ApiPayload> {
  const headers = { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` }
  return requestJson(request, path, { ...init, headers } as Parameters<APIRequestContext['fetch']>[1])
}

function editMarker(document: Record<string, any>, marker: string): Record<string, any> {
  const next = structuredClone(document)
  const manor = next.objects.find((object: { id: string }) => object.id === 'house')
  if (!manor) throw new Error('scene fixture has no manor object to mark')
  manor.label = marker
  return next
}

async function sceneAt(request: APIRequestContext, token: string, worldId: string, timelineId: string): Promise<any> {
  const result = await authorized(request, token,
    `/api/worlds/${encodeURIComponent(worldId)}/scene?timelineId=${encodeURIComponent(timelineId)}&representation=voxel`)
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  expect(result.body.scope).toMatchObject({ worldId, timelineId, representation: 'voxel' })
  return result.body
}

async function saveScene(request: APIRequestContext, token: string, worldId: string, timelineId: string, current: any, document: unknown, requestId: string): Promise<any> {
  const result = await authorized(request, token, `/api/worlds/${encodeURIComponent(worldId)}/scene/voxel-revision`, {
    method: 'POST',
    data: { timelineId, representation: 'voxel', spaceId: 'exterior', expectedVersion: current.version, requestId, document },
  })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  return result.body
}

/**
 * This uses Playwright's configured isolated API Worker and D1 database. The browser and
 * request assertions hit the real Worker; only fixture geometry is supplied at world creation.
 */
test('timeline scene revisions fork independently, restore visible ancestry, and stay read-only after archive', async ({ page }) => {
  test.setTimeout(150_000)
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const username = `x1-scene-${suffix}`
  const password = 'x1-scene-integration-password'
  const registration = await page.request.post('/api/auth/register', { data: { username, password } })
  expect(registration.status()).toBe(200)
  const { token } = await registration.json() as { token: string }
  const headers = { authorization: `Bearer ${token}` }

  const person = await page.request.post('/api/persons', { headers, data: { name: 'Ada', model: personModel } })
  expect(person.status()).toBe(200)
  const { id: personId } = await person.json() as { id: string }
  const locationNames = sceneFixture.locations.map(location => location.name) as string[]
  const created = await page.request.post('/api/worlds', { headers, data: {
    name: `X1 场景历史 ${suffix}`,
    description: 'Isolated world for the timeline scene geometry browser journey.',
    locations: locationNames.map(name => ({ name, description: `${name} for X1 verification` })),
    personIds: [personId],
    scene: sceneFixture,
    sceneRequestId: `x1-scene-create-${suffix}`,
  } })
  const createdBody = await created.json() as { id?: string; timelineId?: string; error?: string }
  expect(created.status(), JSON.stringify(createdBody)).toBe(200)
  const worldId = createdBody.id!
  const parentTimelineId = createdBody.timelineId!
  const activated = await page.request.post(`/api/worlds/${worldId}/resume`, { headers })
  expect(activated.status(), await activated.text()).toBe(200)

  const root = await sceneAt(page.request, token, worldId, parentTimelineId)
  expect(root.status).toBe('ready')
  const baselineDocument = root.document
  const parentEdit = await saveScene(page.request, token, worldId, parentTimelineId, root,
    editMarker(baselineDocument, `父线分叉前 ${suffix}`), `x1-parent-before-${suffix}`)

  const fork = await authorized(page.request, token, `/api/worlds/${worldId}/timelines/${parentTimelineId}/fork`, {
    method: 'POST',
    data: { requestId: `x1-child-${suffix}`, scenario: {
      name: `子线 ${suffix}`, whatIf: '场景修改留在各自时间线', changedVariable: '庄主楼摆设标签',
      participants: [], invariants: ['模拟状态保持不变'],
    } },
  })
  expect(fork.status, JSON.stringify(fork.body)).toBe(200)
  const childTimelineId = fork.body.id as string
  expect(childTimelineId).toBeTruthy()

  const parentCurrent = await sceneAt(page.request, token, worldId, parentTimelineId)
  const parentAfterFork = await saveScene(page.request, token, worldId, parentTimelineId, parentCurrent,
    editMarker(parentCurrent.document, `父线分叉后 ${suffix}`), `x1-parent-after-${suffix}`)
  const childRoot = await sceneAt(page.request, token, worldId, childTimelineId)
  expect(childRoot.document.objects.find((object: { id: string }) => object.id === 'house')?.label).toBe(`父线分叉前 ${suffix}`)
  const childEdit = await saveScene(page.request, token, worldId, childTimelineId, childRoot,
    editMarker(childRoot.document, `子线独立修改 ${suffix}`), `x1-child-edit-${suffix}`)

  const history = await authorized(page.request, token,
    `/api/worlds/${encodeURIComponent(worldId)}/scene/revisions?timelineId=${encodeURIComponent(childTimelineId)}&representation=voxel`)
  expect(history.status, JSON.stringify(history.body)).toBe(200)
  expect(history.body.scope).toMatchObject({ worldId, timelineId: childTimelineId, representation: 'voxel' })
  const visibleAncestor = history.body.revisions.find((revision: any) => revision.origin === 'ancestor'
    && revision.timelineId === parentTimelineId && revision.originTimelineId === parentTimelineId
    && revision.revisionId === root.revisionId)
  expect(visibleAncestor, 'child history must include the ancestor revision visible at fork').toBeTruthy()
  expect(history.body.revisions.some((revision: any) => revision.revisionId === parentAfterFork.revisionId),
    'post-fork parent edits must not leak into child history').toBe(false)
  expect(childEdit.version).toBeGreaterThan(childRoot.version)

  await page.addInitScript((authToken: string) => localStorage.setItem('possibility_token', authToken), token)
  const browserSceneReads: { method: string; timelineId: string | null; representation: string | null }[] = []
  page.on('requestfinished', request => {
    const url = new URL(request.url())
    if (url.pathname.endsWith('/scene')) browserSceneReads.push({
      method: request.method(), timelineId: url.searchParams.get('timelineId'),
      representation: url.searchParams.get('representation'),
    })
  })
  await page.goto(`/worlds/${encodeURIComponent(worldId)}?timeline=${encodeURIComponent(childTimelineId)}`)
  await expect(page.getByTestId('voxel-viewport')).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId('timeline-switcher')).toHaveValue(childTimelineId)
  await expect.poll(() => browserSceneReads.some(read => read.method === 'GET'
    && read.timelineId === childTimelineId && read.representation === 'voxel')).toBe(true)
  await page.getByRole('button', { name: '历史', exact: true }).click()
  const historyDialog = page.getByRole('dialog', { name: '场景历史' })
  await expect(historyDialog).toBeVisible()
  const ancestorRow = historyDialog.locator('li').filter({ hasText: `祖先时间线 ${parentTimelineId}` })
    .filter({ hasText: `v${root.version}` })
  await expect(ancestorRow).toBeVisible()
  await ancestorRow.getByRole('button', { name: '恢复到此版本' }).click()
  await expect(historyDialog).toHaveCount(0)

  const restoredChild = await sceneAt(page.request, token, worldId, childTimelineId)
  expect(restoredChild.revisionId).not.toBe(childEdit.revisionId)
  expect(restoredChild.version).toBe(childEdit.version + 1)
  expect(restoredChild.document).toEqual(baselineDocument)
  const unchangedParent = await sceneAt(page.request, token, worldId, parentTimelineId)
  expect(unchangedParent.revisionId).toBe(parentAfterFork.revisionId)
  expect(unchangedParent.document.objects.find((object: { id: string }) => object.id === 'house')?.label).toBe(`父线分叉后 ${suffix}`)

  const archived = await page.request.post(`/api/timelines/${childTimelineId}/archive`, { headers })
  expect(archived.status()).toBe(200)
  await page.reload()
  await expect(page.getByTestId('world-status')).toContainText('已归档')
  await page.getByRole('button', { name: '历史', exact: true }).click()
  const archivedHistory = page.getByRole('dialog', { name: '场景历史' })
  await expect(archivedHistory.getByText('此时间线只读；可以查看场景历史。')).toBeVisible()
  const restoreButton = archivedHistory.getByRole('button', { name: '恢复到此版本' }).first()
  if (await restoreButton.count()) await expect(restoreButton).toBeDisabled()

  const archivedScene = await sceneAt(page.request, token, worldId, childTimelineId)
  expect(archivedScene.revisionId).toBe(restoredChild.revisionId)
  expect(parentEdit.version).toBeLessThan(parentAfterFork.version)
})
