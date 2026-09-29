import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const exteriorDoc = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))
const interiorDoc = JSON.parse(readFileSync(new URL('./fixtures/voxel-interior.json', import.meta.url), 'utf8'))

/** 多空间体素包：外景（fixture 雾影庄）+ 主楼 */
const voxelSpaces = {
  format: 'voxel-spaces', version: 1, defaultSpaceId: 'exterior',
  spaces: [
    { id: 'exterior', name: '山间外景', document: exteriorDoc },
    { id: 'main-hall', name: '主楼', document: interiorDoc },
  ],
}

const snapshot = {
  world: { id: 'demo', name: '雾影庄', description: '白雾町的旧宅', status: 'running', pauseReason: null, isDemo: true, callsToday: 0, locations: [{ name: '主楼', description: '主楼' }, { name: '温室', description: '玻璃温室' }, { name: '庭院', description: '庭院' }] },
  timelines: [{ id: 'main', parentTimelineId: null, simNow: '2026-09-28T12:00:00.000Z' }], currentTimelineId: 'main', simNow: '2026-09-28T12:00:00.000Z',
  stateVersion: 1, worldModelVersion: 1, evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [],
  locationBoard: [{ location: '主楼', persons: [{ id: 'resident-1', name: '主人', activity: '独自在书房读信' }] }],
  events: [{ id: 'ev-1', title: '玻璃上的手印', description: '温室的玻璃上多了一枚陌生手印', location: '温室' }],
}

const guestSession = {
  token: 'guest-voxel-token', sessionId: 'session-voxel', worldId: 'demo', timelineId: 'main',
  generation: 1, expiresAt: '2026-09-29T12:00:00.000Z',
}

async function mockGuestVoxel(page: Page) {
  await page.addInitScript(() => localStorage.setItem('possibility:flag:voxel', '1'))
  await page.route('**/api/demo/session', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { sessionId: guestSession.sessionId, worldId: 'demo', timelineId: 'main', generation: 1, expiresAt: guestSession.expiresAt } })
    return route.fulfill({ json: guestSession })
  })
  await page.route('**/api/worlds/demo/map/bootstrap**', (route) => route.fulfill({ json: {
    access: { observe: true, participate: true, editScene: false, fork: true, compare: true, persist: false, resetDemo: true },
    world: snapshot,
    scene: { status: 'ready', document: voxelSpaces },
    presentation: { timelineId: 'main', stateVersion: 1, simNow: snapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
    theme: { id: 'mist-manor', assetVersion: 'fixture' },
    resume: { worldId: 'demo', timelineId: 'main', spaceId: 'exterior', mode: 'life', updatedAt: snapshot.simNow },
  } }))
  await page.route('**/api/worlds/demo/map/resume', (route) => route.fulfill({ json: { ok: true } }))
  // ScenePanel（到场 / 交谈 / 传话）与分叉对照
  await page.route('**/api/worlds/demo/persona?**', (route) => route.fulfill({ json: { persona: { id: 'visitor-1', name: '阿透', description: '旅人', location: null }, unread: 0 } }))
  await page.route('**/api/worlds/demo/persona/messages**', (route) => route.fulfill({ json: { messages: [], mentions: [] } }))
  await page.route('**/api/worlds/demo/state**', (route) => route.fulfill({ json: { version: 1 } }))
  await page.route('**/api/worlds/demo/scene/board**', (route) => route.fulfill({ json: { board: [{ location: '主楼', count: 1, people: [{ id: 'resident-1', name: '主人' }] }] } }))
  await page.route('**/api/worlds/demo/scene/history**', (route) => route.fulfill({ json: { dialogueId: null, location: null, turns: [] } }))
  await page.route('**/api/worlds/demo/scene/intent/pending**', (route) => route.fulfill({ json: { proposal: null } }))
  await page.route('**/api/worlds/demo/scene/position', (route) => route.fulfill({ json: { commandId: 'cmd-1', version: 2, location: '主楼' } }))
  await page.route('**/api/worlds/demo/scene/inform', (route) => route.fulfill({ json: { commandId: 'cmd-2', version: 3, certainty: 'rumor' } }))
  await page.route('**/api/worlds/demo/scene', (route) => route.fulfill({
    status: 200, contentType: 'text/event-stream',
    body: 'data: {"type":"turn","personId":"resident-1","name":"主人","utterance":"欢迎。"}\n\ndata: {"type":"done"}\n\n',
  }))
  await page.route('**/api/demo/worlds/demo/fork', (route) => route.fulfill({ json: { id: 'fork-a', simNow: snapshot.simNow } }))
  await page.route('**/api/demo/worlds/demo/compare**', (route) => route.fulfill({ json: { differences: { facts: [{ key: 'letter' }], states: [{ personId: 'resident-1' }], events: { leftOnly: [], rightOnly: [{ id: 'ev-fork' }] } }, limitations: [] } }))
}

async function toScreen(page: Page, at: { x: number; y: number; z: number }) {
  return page.evaluate((cell) => (window.__voxelEngine as never as {
    worldToScreen(at: { x: number; y: number; z: number }): { x: number; y: number } | null
  }).worldToScreen(cell)!, at)
}

async function residentScreen(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const engine = window.__voxelEngine as never as {
      residents: { snapshot(): { personId: string; position: { x: number; y: number; z: number } }[] }
      worldToScreen(at: { x: number; y: number; z: number }): { x: number; y: number } | null
    }
    const resident = engine.residents.snapshot()[0]!
    const at = { x: Math.floor(resident.position.x), y: Math.floor(resident.position.y) + 1, z: Math.floor(resident.position.z) }
    return engine.worldToScreen(at)!
  })
}

test('guest voxel sandbox: multi-space navigation and full onboarding tour (AC16/AC17)', async ({ page }) => {
  await mockGuestVoxel(page)
  await page.goto('/')
  await expect(page.getByTestId('guest-world-map')).toBeVisible()
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible()
  await expect(page.getByText('体验指引 1/8')).toBeVisible()

  // 步骤 1 发现事件：点击温室（地点绑定 + 该地点有事件）
  const greenhouseRoof = await toScreen(page, { x: 8, y: 4, z: 11 })
  await page.mouse.click(greenhouseRoof.x, greenhouseRoof.y)
  await expect(page.getByText('体验指引 2/8')).toBeVisible()
  await expect(page.getByRole('heading', { name: '温室' })).toBeVisible()
  await page.getByRole('button', { name: '关闭信息' }).click()

  // 步骤 2 认识居民：点击行走的居民
  await expect(async () => {
    const at = await residentScreen(page)
    await page.mouse.click(at.x, at.y)
    await expect(page.getByText('体验指引 3/8')).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 10000 })
  await expect(page.getByRole('heading', { name: '主人' })).toBeVisible()

  // 步骤 3 进入地点：以访客身份进入 → 到场
  await page.getByRole('button', { name: '以访客身份进入' }).click()
  await page.getByRole('button', { name: '进入', exact: true }).click()
  await expect(page.getByText('体验指引 4/8')).toBeVisible()

  // 步骤 4 真实交谈：发送一句对话（SSE 完成）
  await page.getByPlaceholder('开口说话…（Enter 发送，Shift+Enter 换行）').fill('你好，这里真安静。')
  await page.getByPlaceholder('开口说话…（Enter 发送，Shift+Enter 换行）').press('Enter')
  await expect(page.getByText('体验指引 5/8')).toBeVisible()

  // 步骤 5 改变条件：当面传话
  await page.getByText('明确告诉现场某人一条消息').click()
  await page.getByLabel('消息接收者').selectOption('resident-1')
  await page.getByLabel('消息主题').fill('温室的手印')
  await page.getByLabel('消息内容').fill('温室玻璃上有一枚陌生手印。')
  await page.getByRole('button', { name: '告诉 TA' }).click()
  await expect(page.getByText('体验指引 6/8')).toBeVisible()
  await page.getByRole('button', { name: '关闭', exact: true }).click()

  // 步骤 6/7 创建分支并查看对照
  await page.getByRole('button', { name: '可能' }).click()
  await page.getByRole('button', { name: '创建并对照' }).click()
  await expect(page.getByText('已创建平行宇宙')).toBeVisible()
  await expect(page.getByText(/1 项事实差异/)).toBeVisible()
  await expect(page.getByText('体验指引 8/8')).toBeVisible()

  // 步骤 8 返回地图 → 导览完成
  await page.getByRole('button', { name: '返回地图' }).click()
  await expect(page.getByText('导览已完成')).toBeVisible()

  // AC16：点击空间入口（主楼门前的触发点）→ 进入主楼；按钮返回外景
  const entry = await toScreen(page, { x: 23, y: 0, z: 24 })
  await page.mouse.click(entry.x, entry.y)
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
  await expect(page.getByText(/主楼 · 正在生活/)).toBeVisible()
  await page.getByTestId('voxel-space-exterior').click()
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
  await expect(page.getByText(/山间外景 · 正在生活/)).toBeVisible()
})
