import { expect, test } from '@playwright/test'

const buildingIds = ['home-small', 'home-row', 'cafe-corner', 'grocery-small', 'bookshop-small', 'station-stop', 'park-pavilion', 'clinic-small']
const locations = ['河畔住区', '沿河联排', '街角咖啡馆', '杂货铺', '社区书店', '旧车站', '河边亭子', '社区诊所']
const positions = buildingIds.flatMap((_, i) => [{ x: (i % 4) * 6, y: Math.floor(i / 4) * 9 + 1 }])
const occupied = new Set<string>()
const objects = buildingIds.map((assetId, i) => {
  const width = assetId === 'cafe-corner' || assetId === 'station-stop' || assetId === 'clinic-small' ? 4 : 3
  const height = assetId === 'cafe-corner' ? 4 : 3
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) occupied.add(`${positions[i]!.x + x},${positions[i]!.y + y}`)
  return { id: `building-${i}`, assetId, position: positions[i]!, binding: { kind: 'location', locationName: locations[i]! }, label: locations[i]!, purpose: '居民日常相遇的地点' }
})
const boulderPosition = { x: 10, y: 5 }
for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) occupied.add(`${boulderPosition.x + x},${boulderPosition.y + y}`)
objects.push({ id: 'stone-boulder', assetId: 'stone-boulder', position: boulderPosition, binding: null, label: null, purpose: null })
const smallAssets = ['shrub', 'flower-bed', 'wildflower', 'tree-round', 'planter', 'bench', 'sign-board', 'mailbox']
for (let y = 0; y < 18 && objects.length < 109; y++) for (let x = 0; x < 24 && objects.length < 109; x++) {
  const key = `${x},${y}`
  if (occupied.has(key)) continue
  occupied.add(key)
  const i = objects.length - 8
  objects.push({ id: `nature-${i}`, assetId: smallAssets[i % smallAssets.length]!, position: { x, y }, binding: null, label: null, purpose: null })
}
const avatars = ['person-ada', 'person-bo', 'person-cora', 'person-dan', 'person-eli', 'person-faye'].map((assetId, i) => ({ id: `resident-${i}`, assetId, position: { x: i * 2, y: 16 }, binding: { kind: 'person', personId: `person-${i}` }, label: `居民 ${i + 1}`, purpose: null }))
objects.push(...avatars)
const document = { schemaVersion: 1, themeId: 'contemporary-daily-life', size: { columns: 24, rows: 18 }, version: 1, terrain: [], paths: [{ id: 'river', category: 'water', assetId: 'water-inner', cells: Array.from({ length: 10 }, (_, i) => ({ x: 10 + Math.floor(i / 3), y: 2 + i })) }, { id: 'street', category: 'road', assetId: 'road-straight', cells: Array.from({ length: 12 }, (_, i) => ({ x: i + 5, y: 8 })) }], objects, lockedObjectIds: [], lockedAreas: [] }
const snapshot = { world: { id: 'reference', name: '河畔日常', description: '参考街区', status: 'running', pauseReason: null, isDemo: false, callsToday: 0, locations: locations.map(name => ({ name, description: '社区地点' })) }, timelines: [{ id: 'timeline-main', parentTimelineId: null, simNow: '2026-09-28T19:30:00.000Z' }], currentTimelineId: 'timeline-main', simNow: '2026-09-28T19:30:00.000Z', stateVersion: 1, worldModelVersion: 1, evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [{ factType: 'environment', value: { condition: 'weather', value: 'rain' } }], locationBoard: avatars.map((avatar, i) => ({ location: locations[i]!, persons: [{ id: `person-${i}`, name: `居民 ${i + 1}`, activity: '在附近散步' }] })), events: [] }

test('renders the required reference scale of buildings, nature, residents, road and water', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/api/worlds', route => route.fulfill({ json: { worlds: [{ id: 'reference', name: '参考世界' }] } }))
  await page.route('**/api/worlds/reference/stream**', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' }))
  let simNow = '2026-09-28T21:30:00.000Z'
  await page.route('**/api/worlds/reference?*', route => route.fulfill({ json: { ...snapshot, simNow, timelines: [{ ...snapshot.timelines[0]!, simNow }] } }))
  await page.route('**/api/worlds/reference/scene', route => route.fulfill({ json: { status: 'ready', document, version: 1, contentHash: 'visual-reference', createdAt: snapshot.simNow } }))
  await page.route('**/api/worlds/reference/map/bootstrap**', route => route.fulfill({ json: {
    access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false },
    world: { ...snapshot, simNow, timelines: [{ ...snapshot.timelines[0]!, simNow }] },
    scene: { status: 'ready', document },
    presentation: { timelineId: 'timeline-main', stateVersion: 1, simNow, timeOfDay: new Date(simNow).getUTCHours() >= 20 ? 'night' : 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
    theme: { id: 'contemporary-daily-life', assetVersion: 'fixture' },
    resume: { worldId: 'reference', timelineId: 'timeline-main', spaceId: 'exterior', mode: 'life', updatedAt: simNow },
  } }))
  await page.route('**/api/worlds/reference/map/resume', route => route.fulfill({ json: { ok: true } }))
  await page.goto('/worlds/reference?timeline=timeline-main')
  const canvas = page.getByTestId('world-canvas')
  await expect(canvas).toBeVisible()
  await expect(canvas).toHaveAttribute('data-time-of-day', 'night')
  await expect(canvas.locator('canvas')).toBeVisible()
  await page.waitForTimeout(500)
  const first = await canvas.screenshot()
  const second = await canvas.screenshot()
  expect(second.equals(first), 'two captures of the same fixed scene should be byte-identical').toBe(true)
  await canvas.screenshot({ path: '../spec_docs/s02/visual-reference-candidate.png' })
  simNow = '2026-09-28T12:00:00.000Z'
  await page.reload()
  await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-time-of-day', 'day')
  const daytimeCanvas = page.getByTestId('world-canvas').locator('canvas')
  await expect(daytimeCanvas).toBeVisible()
  await page.waitForTimeout(500)
  const daytime = await page.getByTestId('world-canvas').screenshot()
  expect(daytime.equals(first), 'day and night should render distinct scene states').toBe(false)
})
