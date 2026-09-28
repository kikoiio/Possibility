import { expect, test, type Page } from '@playwright/test'

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

function snapshot(worldId: string, timelineId: string, timelines: { id: string; parentTimelineId: string | null }[]) {
  return {
    world: { id: worldId, name: '雾影庄', description: '白雾町的旧宅', status: 'running', pauseReason: null, isDemo: true, callsToday: 0, locations: [{ name: '雾影庄主楼', description: '主楼' }] },
    timelines: timelines.map(item => ({ ...item, simNow: '2026-09-28T12:00:00.000Z' })), currentTimelineId: timelineId, simNow: '2026-09-28T12:00:00.000Z',
    stateVersion: 1, worldModelVersion: 1, evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [],
    locationBoard: [{ location: '雾影庄主楼', persons: [{ id: 'resident-1', name: '主人', activity: '独自在书房读信' }] }], events: [],
  }
}

/** 为单个访客页面挂载独立的沙盒接口；forked 状态只记录在该访客自己的闭包里。 */
async function mockGuestSandbox(page: Page, worldId: string, sessionId: string) {
  const state = { forked: false, generation: 1 }
  await page.route('**/api/demo/session', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { sessionId, worldId, timelineId: 'main', generation: state.generation, expiresAt: '2026-09-29T12:00:00.000Z' } })
    return route.fulfill({ json: { token: `guest-${sessionId}`, sessionId, worldId, timelineId: 'main', generation: state.generation, expiresAt: '2026-09-29T12:00:00.000Z' } })
  })
  await page.route('**/api/demo/session/reset', route => {
    state.forked = false; state.generation += 1
    return route.fulfill({ json: { sessionId, worldId, timelineId: 'main', generation: state.generation, expiresAt: '2026-09-29T12:00:00.000Z' } })
  })
  await page.route(`**/api/demo/worlds/${worldId}/fork`, route => {
    state.forked = true
    return route.fulfill({ json: { id: 'fork-a', simNow: '2026-09-28T12:00:00.000Z' } })
  })
  await page.route(`**/api/demo/worlds/${worldId}/compare**`, route => route.fulfill({ json: { differences: { facts: [{ key: 'letter-found-at' }], states: [{ personId: 'resident-1' }], events: { leftOnly: [], rightOnly: [{ id: 'event-fork' }] } }, limitations: [] } }))
  await page.route(`**/api/worlds/${worldId}/map/bootstrap**`, route => {
    const requested = new URL(route.request().url()).searchParams.get('timelineId')
    const timelines = state.forked ? [{ id: 'main', parentTimelineId: null }, { id: 'fork-a', parentTimelineId: 'main' }] : [{ id: 'main', parentTimelineId: null }]
    const current = requested === 'fork-a' && state.forked ? 'fork-a' : 'main'
    return route.fulfill({ json: {
      access: { observe: true, participate: true, editScene: false, fork: true, compare: true, persist: false, resetDemo: true },
      world: snapshot(worldId, current, timelines),
      scene: { status: 'ready', document: sceneV2 },
      presentation: { timelineId: current, stateVersion: 1, simNow: '2026-09-28T12:00:00.000Z', timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
      theme: { id: 'mist-manor', assetVersion: 'fixture' },
      resume: { worldId, timelineId: current, spaceId: 'exterior', mode: 'life', updatedAt: '2026-09-28T12:00:00.000Z' },
    } })
  })
  await page.route(`**/api/worlds/${worldId}/map/resume`, route => route.fulfill({ json: { ok: true } }))
}

test('two guests explore isolated sandboxes; fork and reset stay scoped to each guest', async ({ browser }) => {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  await mockGuestSandbox(pageA, 'sandbox-a', 'session-a')
  await mockGuestSandbox(pageB, 'sandbox-b', 'session-b')

  // 两位访客从同一公共基线进入各自的沙盒副本
  await pageA.goto('/')
  await pageB.goto('/')
  await expect(pageA.getByTestId('guest-world-map')).toBeVisible()
  await expect(pageB.getByTestId('guest-world-map')).toBeVisible()

  // 访客 A 创建平行宇宙并对照
  await pageA.getByRole('button', { name: '可能' }).click()
  await pageA.getByRole('button', { name: '创建并对照' }).click()
  await expect(pageA.getByText('已创建平行宇宙')).toBeVisible()
  await expect(pageA.getByText(/1 项事实差异/)).toBeVisible()

  // 访客 B 看不到 A 的分叉，也没有时间线切换器
  await pageB.getByRole('button', { name: '可能' }).click()
  await expect(pageB.getByRole('button', { name: '创建并对照' })).toBeVisible()
  await expect(pageB.getByText('已创建平行宇宙')).toHaveCount(0)
  await expect(pageB.getByTestId('timeline-switcher')).toHaveCount(0)

  // A 刷新后可以从切换器进入自己的分支宇宙
  await pageA.reload()
  await expect(pageA.getByTestId('guest-world-map')).toBeVisible()
  await pageA.getByTestId('timeline-switcher').selectOption('fork-a')
  await expect(pageA.getByTestId('timeline-switcher')).toHaveValue('fork-a')

  // A 重置沙盒：回到基线，切换器消失；B 的沙盒不受影响
  await pageA.getByRole('button', { name: '重新开始' }).click()
  await expect(pageA.getByTestId('guest-world-map')).toBeVisible()
  await expect(pageA.getByTestId('timeline-switcher')).toHaveCount(0)
  await pageB.reload()
  await expect(pageB.getByTestId('guest-world-map')).toBeVisible()
  await pageB.getByRole('button', { name: '可能' }).click()
  await expect(pageB.getByRole('button', { name: '创建并对照' })).toBeVisible()

  await contextA.close()
  await contextB.close()
})
