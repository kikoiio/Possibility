import { expect, test } from '@playwright/test'

const scene = {
  schemaVersion: 1, themeId: 'contemporary-daily-life', size: { columns: 24, rows: 18 }, version: 0,
  terrain: [], paths: [], lockedObjectIds: [], lockedAreas: [],
  objects: [
    ...['河畔街', '街角咖啡馆', '旧车站', '小花园', '居民住宅'].map((locationName, i) => ({ id: `place-${i}`, assetId: i === 1 ? 'cafe-corner' : 'home-small', position: { x: i * 4, y: 2 }, binding: { kind: 'location', locationName }, label: locationName, purpose: '供人们日常相遇' })),
    { id: 'resident-ada', assetId: 'person-ada', position: { x: 3, y: 9 }, binding: { kind: 'person', personId: 'person-1' }, label: 'Ada', purpose: null },
  ],
}

test('creates a world from a place description and keeps scene editing available', async ({ page }) => {
  let createdScene: typeof scene | null = null
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/api/persons', route => route.fulfill({ json: { persons: [{ id: 'person-1', name: 'Ada', createdAt: '2026-01-01T00:00:00Z' }] } }))
  await page.route('**/api/scene-drafts', route => route.fulfill({ json: { world: { name: '河畔街', description: '河畔的街区', locations: ['河畔街', '街角咖啡馆', '旧车站', '小花园', '居民住宅'].map(name => ({ name, description: '日常生活的地点' })) }, scene, explanation: '已把河畔街道、咖啡馆和住宅放入画布。', warnings: [] } }))
  await page.route('**/api/worlds', async route => {
    if (route.request().method() === 'POST') { createdScene = route.request().postDataJSON().scene; return route.fulfill({ json: { id: 'world-1', timelineId: 'timeline-1' } }) }
    return route.continue()
  })
  await page.route('**/api/worlds/world-1**', route => route.fulfill({ json: route.request().url().includes('/scene') ? { status: 'ready', document: { ...scene, version: 1 }, version: 1, contentHash: 'abc', createdAt: '2026-09-28T00:00:00.000Z' } : { world: { id: 'world-1', name: '河畔街', description: '河畔的街区', status: 'running', pauseReason: null, isDemo: false, callsToday: 0, locations: [] }, timelines: [{ id: 'timeline-1', parentTimelineId: null, simNow: '2026-09-28T12:00:00.000Z' }], currentTimelineId: 'timeline-1', simNow: '2026-09-28T12:00:00.000Z', stateVersion: 1, worldModelVersion: 1, evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [], locationBoard: [], events: [] } }))
  await page.goto('/worlds/new')
  await page.getByTestId('scene-prompt').fill('一条河边的街道，街角有咖啡馆、旧车站和居民住宅。')
  await page.getByRole('button', { name: 'Ada' }).click()
  await page.getByTestId('generate-scene').click()
  await expect(page.getByText('继续调整这方天地')).toBeVisible()
  await expect(page.getByTestId('world-canvas')).toBeVisible()
  await expect(page.getByTestId('world-canvas').locator('canvas')).toBeVisible()
  await expect(page.getByTestId('start-life')).toBeEnabled()
  await page.getByRole('button', { name: '素材', exact: true }).click()
  await page.getByRole('button', { name: '灌木' }).click()
  await page.getByTestId('world-canvas').locator('canvas').click({ position: { x: 900, y: 400 } })
  await page.getByTestId('start-life').click()
  await expect(page).toHaveURL(/\/worlds\/world-1/)
  await expect(page.getByTestId('world-canvas')).toBeVisible()
  expect(createdScene?.objects.some(object => object.assetId === 'shrub')).toBe(true)
})
