import { expect, test } from '@playwright/test'

const scene = {
  schemaVersion: 1, themeId: 'contemporary-daily-life', size: { columns: 12, rows: 10 }, version: 1,
  terrain: [], paths: [], lockedObjectIds: [], lockedAreas: [],
  objects: [{ id: 'manor', assetId: 'home-small', position: { x: 4, y: 2 }, binding: { kind: 'location', locationName: '雾影庄' }, label: '雾影庄', purpose: null }],
}

/** 最小多空间 v2 场景：一个外景空间 + 地点建筑 + 一位居民，资产 ID 来自 mist-manor 主题。 */
const sceneV2 = {
  schemaVersion: 2, themeId: 'mist-manor', version: 1, defaultSpaceId: 'exterior',
  spaces: [{
    id: 'exterior', name: '山间外景', kind: 'exterior', size: { columns: 24, rows: 18 },
    surface: [{ x: 0, y: 0, assetId: 'mist-grass' }], paths: [], structures: [],
    objects: [
      { id: 'manor', assetId: 'manor-main', position: { x: 4, y: 2 }, binding: { kind: 'location', locationName: '雾影庄主楼' }, label: '雾影庄主楼', purpose: null },
      { id: 'resident-1-object', assetId: 'mist-resident-1', position: { x: 12, y: 10 }, binding: { kind: 'person', personId: 'resident-1' }, label: '主人', purpose: null },
    ],
    regions: [], navigation: { walkableCells: [], blockedCells: [], entrances: [] },
  }],
  portals: [], lockedObjectIds: [], lockedAreas: [],
}

const snapshot = {
  world: { id: 'demo', name: '雾影庄', description: '白雾町的旧宅', status: 'running', pauseReason: null, isDemo: true, callsToday: 0, locations: [{ name: '雾影庄主楼', description: '主楼' }] },
  timelines: [{ id: 'main', parentTimelineId: null, simNow: '2026-09-28T12:00:00.000Z' }], currentTimelineId: 'main', simNow: '2026-09-28T12:00:00.000Z',
  stateVersion: 1, worldModelVersion: 1, evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [],
  locationBoard: [{ location: '雾影庄主楼', persons: [{ id: 'resident-1', name: '主人', activity: '独自在书房读信' }] }], events: [],
}

const guestSession = {
  token: 'guest-e2e-token', sessionId: 'session-e2e', worldId: 'demo', timelineId: 'main',
  generation: 1, expiresAt: '2026-09-29T12:00:00.000Z',
}

function mockGuestBootstrap(page: import('@playwright/test').Page, document: unknown) {
  return page.route('**/api/worlds/demo/map/bootstrap**', route => route.fulfill({ json: {
    access: { observe: true, participate: true, editScene: false, fork: true, compare: true, persist: false, resetDemo: true },
    world: snapshot,
    scene: { status: 'ready', document },
    presentation: { timelineId: 'main', stateVersion: 1, simNow: snapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
    theme: { id: 'mist-manor', assetVersion: 'fixture' },
    resume: { worldId: 'demo', timelineId: 'main', spaceId: 'exterior', mode: 'life', updatedAt: snapshot.simNow },
  } }))
}

test('anonymous landing creates a guest sandbox and opens the multi-space map without mutating the world', async ({ page }) => {
  const writes: string[] = []
  page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(`${request.method()} ${new URL(request.url()).pathname}`) })
  await page.route('**/api/demo/session', route => route.fulfill({ json: guestSession }))
  await mockGuestBootstrap(page, sceneV2)
  await page.route('**/api/worlds/demo/map/resume', route => route.fulfill({ json: { ok: true } }))
  await page.goto('/')
  await expect(page.getByTestId('guest-world-map')).toBeVisible()
  await expect(page.getByTestId('world-canvas').locator('canvas')).toBeVisible()
  await expect(page.getByRole('link', { name: '登录并保存' })).toBeVisible()
  // 访客落地只应创建沙盒会话和保存恢复偏好，不能写世界、场景或时间线
  expect([...new Set(writes)].sort()).toEqual(['POST /api/demo/session', 'PUT /api/worlds/demo/map/resume'])
})

test('anonymous landing on a legacy single-space scene shows the readonly map index', async ({ page }) => {
  await page.route('**/api/demo/session', route => route.fulfill({ json: guestSession }))
  await mockGuestBootstrap(page, scene)
  await page.route('**/api/worlds/demo/map/resume', route => route.fulfill({ json: { ok: true } }))
  await page.goto('/')
  await expect(page.getByTestId('world-canvas')).toBeVisible()
  await expect(page.getByRole('link', { name: '登录，创建你的世界' })).toBeVisible()
})

test('signed-in landing resumes the last world directly on its map', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/api/map/resume/recent', route => route.fulfill({ json: { worldId: 'user-world', updatedAt: snapshot.simNow } }))
  await page.route('**/api/worlds/user-world/map/bootstrap**', route => route.fulfill({ json: {
    access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false },
    world: { ...snapshot, world: { ...snapshot.world, id: 'user-world', name: '最近的世界', isDemo: false } },
    scene: { status: 'ready', document: scene },
    presentation: { timelineId: 'main', stateVersion: 1, simNow: snapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
    theme: { id: 'contemporary-daily-life', assetVersion: 'fixture' },
    resume: { worldId: 'user-world', timelineId: 'main', spaceId: 'exterior', mode: 'life', updatedAt: snapshot.simNow },
  } }))
  await page.route('**/api/worlds/user-world/map/resume', route => route.fulfill({ json: { ok: true } }))
  // 文字视图挂载期请求(未 stub 会打到真实后端 401 → 竞态跳 /login)
  await page.route('**/api/worlds/user-world/persona**', route => route.fulfill({ json: { persona: null, unread: 0 } }))
  await page.route('**/api/worlds/user-world/state**', route => route.fulfill({ json: { timelineId: 'main', version: 1, worldModelVersion: 1, evidenceStatus: 'structured', current: [], facts: [] } }))
  await page.route('**/api/worlds/user-world/return**', route => route.fulfill({ json: { timelineId: 'main', simNow: snapshot.simNow, firstVisit: false, cursor: 0, events: [], commitments: [], unread: 0 } }))
  await page.goto('/')
  await expect(page).toHaveURL(/\/worlds\/user-world$/)
  await expect(page.getByTestId('world-canvas')).toBeVisible()
})
