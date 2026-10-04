import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const document = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))
const locations = [{ name: '主楼', description: '主楼' }, { name: '温室', description: '温室' }, { name: '旧楼', description: '旧楼' }]

type Options = { status?: 'running' | 'paused'; emptyLocations?: boolean; conflict?: 'single' | 'double' | 'confirmation' | 'readOnly'; failRefresh?: boolean; unavailable?: boolean; informProposal?: boolean; failure?: 'auth' | 'provider' }
async function fixture(page: Page, options: Options = {}) {
  const counters = { intents: 0, commands: 0, effects: 0, snapshots: 0, requests: [] as { requestId: string; content: string }[] }
  let version = 1
  let refreshed = false
  let failRefresh = false
  let readOnly = false
  const snapshot = () => ({
    world: { id: 'world-1', name: '行动世界', description: '行动体验', status: options.status ?? 'running', pauseReason: null, isDemo: false, callsToday: 0,
      locations: options.emptyLocations ? [] : refreshed ? [locations[0], locations[1], { name: '庭院', description: '庭院' }] : locations },
    timelines: [{ id: 'timeline-main', parentTimelineId: null, status: 'active', simNow: '2026-09-19T12:00:00.000Z', createdAt: '2026-09-18T09:00:00.000Z', forkScenario: null }],
    currentTimelineId: 'timeline-main', simNow: '2026-09-19T12:00:00.000Z', stateVersion: version, worldModelVersion: 1,
    evidenceStatus: 'structured', evidence: { level: readOnly ? 'incomplete' : 'complete', reasonCodes: [] }, currentFacts: [], locationBoard: [], events: [],
  })
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }))
  await page.addInitScript(() => { localStorage.setItem('possibility_token', 'e2e-token'); localStorage.setItem('possibility:flag:voxel', '1') })
  await page.route('**/api/worlds', route => route.fulfill({ json: { worlds: [{ id: 'world-1', name: '行动世界' }] } }))
  await page.route('**/api/worlds/world-1?**', route => {
    counters.snapshots++
    if (failRefresh) return route.fulfill({ status: 503, json: { error: '暂不可用' } })
    refreshed = counters.intents > 0
    return route.fulfill({ json: snapshot() })
  })
  await page.route('**/api/worlds/world-1/stream**', route => route.fulfill({ contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' }))
  await page.route('**/api/worlds/world-1/map/bootstrap**', route => route.fulfill({ json: {
    access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false }, world: snapshot(),
    scene: { status: 'ready', document }, presentation: { timelineId: 'timeline-main', stateVersion: version, simNow: snapshot().simNow,
      timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
    theme: { id: 'mist-manor', assetVersion: 'e2e' }, resume: { worldId: 'world-1', timelineId: 'timeline-main', spaceId: 'exterior', mode: 'life', updatedAt: snapshot().simNow },
  } }))
  await page.route('**/api/worlds/world-1/map/resume', route => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/worlds/world-1/persona?**', route => {
    if (failRefresh) return route.fulfill({ status: 503, json: { error: '暂不可用' } })
    return route.fulfill({ json: { persona: { id: 'visitor', name: '访客', description: '旅人', location: counters.intents > 0 && version > 1 ? '庭院' : '主楼' }, unread: 0 } })
  })
  await page.route('**/api/worlds/world-1/persona/messages**', route => route.fulfill({ json: { messages: [], mentions: [] } }))
  await page.route('**/api/worlds/world-1/scene/board**', route => {
    if (failRefresh) return route.fulfill({ status: 503, json: { error: '暂不可用' } })
    return route.fulfill({ json: { board: [{ location: '主楼', count: 1, people: [{ id: 'resident', name: '小夜' }] },
      { location: '温室', count: 0, people: [] }, { location: '庭院', count: version > 1 ? 1 : 0, people: version > 1 ? [{ id: 'resident-2', name: '阿芙' }] : [] }] } })
  })
  await page.route('**/api/worlds/world-1/scene/history**', route => route.fulfill({ json: { dialogueId: null, location: null, turns: [] } }))
  await page.route('**/api/worlds/world-1/scene/intent/pending**', route => route.fulfill({ json: { proposal: null } }))
  await page.route('**/api/worlds/world-1/scene/intent/*/cancel', route => route.fulfill({ json: { status: 'cancelled' } }))
  await page.route('**/api/worlds/world-1/actions/*', route => route.fulfill({ status: 404, json: { error: '命令不存在' } }))
  await page.route('**/api/worlds/world-1/state**', route => {
    if (failRefresh) return route.fulfill({ status: 503, json: { error: '暂不可用' } })
    return route.fulfill({ json: { timelineId: 'timeline-main', version, current: [], facts: [] } })
  })
  await page.route('**/api/worlds/world-1/scene/intent', route => {
    counters.intents++
    const { requestId, content } = route.request().postDataJSON() as { requestId: string; content: string }
    counters.requests.push({ requestId, content })
    const conflictLimit = options.conflict === 'double' ? 2 : ['single', 'readOnly'].includes(options.conflict ?? '') ? 1 : 0
    if (counters.intents <= conflictLimit) {
      version++
      failRefresh = options.failRefresh ?? false
      readOnly = options.conflict === 'readOnly'
      if (readOnly) return route.fulfill({ status: 409, json: { error: '这个世界当前只读' } })
      return route.fulfill({ json: { requestId, timelineId: 'timeline-main', expectedVersion: version - 1,
        currentLocation: version === 2 ? '主楼' : '庭院', status: 'clarification', question: '世界状态已变化', recovery: 'refresh_state' } })
    }
    if (options.failure === 'auth') return route.fulfill({ status: 401, json: { error: 'Unauthorized' } })
    if (options.failure === 'provider') return route.fulfill({ status: 502, json: { error: '暂时无法解析行动，世界状态未改变' } })
    if (options.unavailable) return route.fulfill({ json: { requestId, timelineId: 'timeline-main', expectedVersion: version,
      currentLocation: '庭院', status: 'clarification', question: '“花园”不是当前有效地点。',
      alternatives: { locations: ['温室', '庭院'], residents: [{ id: 'resident-2', name: '阿芙' }] } } })
    if (options.informProposal) return route.fulfill({ json: { requestId, timelineId: 'timeline-main', expectedVersion: version,
      currentLocation: '主楼', status: 'proposal', confirmationRequired: true,
      proposal: { type: 'inform', recipientId: 'resident', recipientName: '小夜', topic: '天气', content: '暴雨开始了' } } })
    return route.fulfill({ json: { requestId, timelineId: 'timeline-main', expectedVersion: version, currentLocation: version > 1 ? '庭院' : '主楼', status: 'proposal', confirmationRequired: true, proposal: { type: 'move', to: '温室' } } })
  })
  await page.route('**/api/worlds/world-1/scene/inform', route => {
    counters.commands++
    counters.effects++
    const { commandId } = route.request().postDataJSON() as { commandId: string }
    return route.fulfill({ json: { commandId, version: ++version, replayed: false } })
  })
  await page.route('**/api/worlds/world-1/scene/position', route => {
    counters.commands++
    if (options.conflict === 'confirmation' && counters.commands === 1) { version = 2; return route.fulfill({ status: 409, json: { error: '状态已变化' } }) }
    counters.effects++
    const { commandId } = route.request().postDataJSON() as { commandId: string }
    return route.fulfill({ json: { commandId, version: ++version, location: '温室' } })
  })
  await page.route('**/api/worlds/world-1/timelines/*/history', route => route.fulfill({ json: { earliest: null, simNow: snapshot().simNow } }))
  await page.route('**/voxel-assets/**', route => route.fulfill({ status: 404, body: 'not found' }))
  return { counters, allowRefresh: () => { failRefresh = false } }
}

async function openAction(page: Page) {
  // Wait for the route's initial data, rather than racing React's first effects
  // while the mobile browser is still loading the viewport modules.
  const bootstrap = page.waitForResponse(response => response.url().includes('/api/worlds/world-1/map/bootstrap') && response.ok(), { timeout: 15000 })
  await page.goto('/worlds/world-1', { waitUntil: 'domcontentloaded' })
  await bootstrap
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByRole('button', { name: '在场', exact: true }).click()
  await expect(page.getByRole('heading', { name: '进入世界' })).toBeVisible()
  await page.getByText('尝试一个行动', { exact: true }).click()
}

export function actionJourneys(viewport: { width: number; height: number }) {
  test.describe('S4B 当前行动与显式恢复', () => {
    test.use({ viewport, deviceScaleFactor: 1 })
    test('状态冲突后自动刷新并重提，确认后只提交一个效果', async ({ page }) => {
      const { counters } = await fixture(page, { conflict: 'single' })
      await openAction(page)
      await expect(page.getByText('示例：带我去温室', { exact: true })).toBeVisible()
      await expect(page.getByText('当前有效地点：主楼、温室、旧楼', { exact: true })).toBeVisible()
      await expect(page.getByText(/可以前往当前有效地点，或告诉现场居民一条消息/)).toBeVisible()
      expect(await page.getByRole('heading', { name: '进入世界' }).locator('..').locator('..').innerText()).not.toMatch(/\b(move|inform)\b/)
      const action = page.getByLabel('行动描述')
      await action.fill('  带我去温室  ')
      await page.getByRole('button', { name: '生成提议', exact: true }).click()
      await expect(page.getByRole('button', { name: '确认执行' })).toBeVisible()
      await expect(action).toHaveValue('  带我去温室  ')
      await expect(page.getByLabel('进入地点')).toHaveValue('庭院')
      await expect(page.getByLabel('进入地点').locator('option[value="旧楼"]')).toHaveCount(0)
      await expect(page.getByLabel('进入地点').locator('option[value="庭院"]')).toContainText('1 人可交谈')
      await expect(page.getByLabel('消息接收者').locator('option[value="resident-2"]')).toContainText('阿芙')
      expect(counters.intents).toBe(2)
      expect(counters.requests.map(request => request.requestId)).toHaveLength(2)
      expect(counters.requests[0].requestId).not.toBe(counters.requests[1].requestId)
      expect(counters.requests.map(request => request.content)).toEqual(['带我去温室', '带我去温室'])
      expect(counters.commands).toBe(0)
      await page.getByRole('button', { name: '确认执行' }).click()
      await expect(page.getByText('已确认并前往温室。', { exact: true })).toBeVisible()
      expect(counters.commands).toBe(1)
      expect(counters.effects).toBe(1)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
      expect(overflow).toBe(false)
    })
    test('刷新失败保留原文，恢复按钮不调用提供方', async ({ page }) => {
      const { counters, allowRefresh } = await fixture(page, { conflict: 'single', failRefresh: true })
      await openAction(page)
      await page.getByLabel('行动描述').fill('带我去温室')
      await page.getByRole('button', { name: '生成提议', exact: true }).click()
      await expect(page.getByRole('alert').filter({ hasText: '状态或地点刷新失败' })).toBeVisible()
      await expect(page.getByLabel('行动描述')).toHaveValue('带我去温室')
      await expect(page.getByRole('button', { name: '重新生成提议' })).toBeDisabled()
      allowRefresh()
      await page.getByRole('button', { name: '刷新行动状态' }).click()
      await expect(page.getByText('世界状态和地点已刷新。请检查最新情况，再显式生成提议。', { exact: true })).toBeVisible()
      expect(counters.intents).toBe(1)
      expect(counters.commands).toBe(0)
      await page.getByRole('button', { name: '重新生成提议' }).click()
      await expect(page.getByRole('button', { name: '确认执行' })).toBeVisible()
      expect(counters.intents).toBe(2)
    })
    test('第二次状态冲突停止自动重试并保留原文', async ({ page }) => {
      const { counters } = await fixture(page, { conflict: 'double' })
      await openAction(page)
      const action = page.getByLabel('行动描述')
      await action.fill('带我去温室')
      await page.getByRole('button', { name: '生成提议', exact: true }).click()
      await expect(page.getByText('自动重试期间世界状态再次变化。已刷新最新情况，请检查后再手动重新生成提议。', { exact: true })).toBeVisible()
      await expect(action).toHaveValue('带我去温室')
      await expect(page.getByRole('button', { name: '重新生成提议' })).toBeEnabled()
      expect(counters.intents).toBe(2)
      expect(counters.requests.map(request => request.requestId)).toHaveLength(2)
      expect(counters.requests[0].requestId).not.toBe(counters.requests[1].requestId)
      expect(counters.commands).toBe(0)
      expect(counters.effects).toBe(0)
    })
    test('传话提议只有确认后才提交', async ({ page }) => {
      const { counters } = await fixture(page, { informProposal: true })
      await openAction(page)
      await page.getByLabel('行动描述').fill('告诉小夜：暴雨开始了')
      await page.getByRole('button', { name: '生成提议', exact: true }).click()
      await expect(page.getByText('告诉小夜：「暴雨开始了」', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '确认执行' })).toBeVisible()
      expect(counters.commands).toBe(0)
      expect(counters.effects).toBe(0)
      await page.getByRole('button', { name: '确认执行' }).click()
      await expect(page.getByText(/已确认并告诉小夜/)).toBeVisible()
      expect(counters.commands).toBe(1)
      expect(counters.effects).toBe(1)
    })
    test('解析返回可用目标时展示原因和替代项', async ({ page }) => {
      const { counters } = await fixture(page, { unavailable: true })
      await openAction(page)
      await page.getByLabel('行动描述').fill('带我去花园')
      await page.getByRole('button', { name: '生成提议', exact: true }).click()
      await expect(page.getByText('“花园”不是当前有效地点。', { exact: true })).toBeVisible()
      await expect(page.getByText('当前可前往：温室、庭院。 当前可传话给：阿芙。', { exact: true })).toBeVisible()
      await expect(page.getByLabel('行动描述')).toHaveValue('带我去花园')
      expect(counters.intents).toBe(1)
      expect(counters.commands).toBe(0)
    })
    test('确认提交发生冲突只刷新，等待重新生成和再次确认', async ({ page }) => {
      const { counters } = await fixture(page, { conflict: 'confirmation' })
      await openAction(page)
      await page.getByLabel('行动描述').fill('带我去温室')
      await page.getByRole('button', { name: '生成提议', exact: true }).click()
      await page.getByRole('button', { name: '确认执行' }).click()
      await expect(page.getByText('世界状态和地点已刷新；这项命令没有自动重放。确认最新情况后，可重新生成提议。', { exact: true })).toBeVisible()
      expect(counters.intents).toBe(1)
      expect(counters.commands).toBe(1)
      expect(counters.effects).toBe(0)
      await expect(page.getByRole('button', { name: '确认执行' })).toHaveCount(0)
      await page.getByRole('button', { name: '重新生成提议' }).click()
      await page.getByRole('button', { name: '确认执行' }).click()
      await expect(page.getByText('已确认并前往温室。', { exact: true })).toBeVisible()
      expect(counters.effects).toBe(1)
    })
    for (const failure of ['auth', 'provider'] as const) {
      test(`${failure}:失败不触发自动重试并保留行动描述`, async ({ page }) => {
        const { counters } = await fixture(page, { failure })
        await openAction(page)
        const action = page.getByLabel('行动描述')
        await action.fill('带我去温室')
        await page.getByRole('button', { name: '生成提议', exact: true }).click()
        await expect(page.getByText(failure === 'auth' ? '登录状态已失效；请在新标签页重新登录，返回后可继续当前行动。' : '暂时无法解析行动；世界状态未改变，请稍后重试。', { exact: true })).toBeVisible()
        await expect(action).toHaveValue('带我去温室')
        if (failure === 'auth') {
          await expect(page).toHaveURL(/\/worlds\/world-1$/)
          await expect(page.getByRole('link', { name: '在新标签页重新登录' })).toHaveAttribute('target', '_blank')
        }
        expect(counters.intents).toBe(1)
        expect(counters.commands).toBe(0)
        expect(counters.effects).toBe(0)
      })
    }
    test('只读冲突显示可恢复说明并阻止再次生成', async ({ page }) => {
      const { counters } = await fixture(page, { conflict: 'readOnly' })
      await openAction(page)
      await page.getByLabel('行动描述').fill('带我去温室')
      await page.getByRole('button', { name: '生成提议', exact: true }).click()
      await expect(page.getByText(/这个世界当前只读/)).toBeVisible()
      await expect(page.getByRole('button', { name: '生成提议', exact: true })).toBeDisabled()
      expect(counters.intents).toBe(1)
    })
    for (const options of [{ status: 'paused' as const }, { emptyLocations: true }]) {
      test(options.status ? '暂停世界先说明恢复方式' : '没有有效地点先说明恢复方式', async ({ page }) => {
        const { counters } = await fixture(page, options)
        await openAction(page)
        await expect(page.getByText(options.status ? /世界已暂停。请关闭面板/ : /当前没有可用地点。请先完善世界地点/)).toBeVisible()
        await page.getByLabel('行动描述').fill('带我去温室')
        await expect(page.getByRole('button', { name: '生成提议', exact: true })).toBeDisabled()
        expect(counters.intents).toBe(0)
      })
    }
  })
}
