import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

/**
 * S3 保存后继续探索:导览重开/跳步反馈、单空间 owner 路径选中卡、移动端布局。
 * 打桩模式沿用 voxel-guest.spec.ts 与 split-view-stubs.ts。
 */

const exteriorDoc = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))
const interiorDoc = JSON.parse(readFileSync(new URL('./fixtures/voxel-interior.json', import.meta.url), 'utf8'))

const voxelSpaces = {
  format: 'voxel-spaces', version: 1, defaultSpaceId: 'exterior',
  spaces: [
    { id: 'exterior', name: '山间外景', document: exteriorDoc },
    { id: 'main-hall', name: '主楼', document: interiorDoc },
  ],
}

const guestSnapshot = {
  world: { id: 'demo', name: '雾影庄', description: '白雾町的旧宅', status: 'running', pauseReason: null, isDemo: true, callsToday: 0, locations: [{ name: '主楼', description: '主楼' }, { name: '温室', description: '玻璃温室' }, { name: '庭院', description: '庭院' }] },
  timelines: [{ id: 'main', parentTimelineId: null, simNow: '2026-09-28T12:00:00.000Z' }], currentTimelineId: 'main', simNow: '2026-09-28T12:00:00.000Z',
  stateVersion: 1, worldModelVersion: 1, evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [],
  locationBoard: [{ location: '主楼', persons: [{ id: 'person-host', name: '主人', activity: '独自在书房读信' }] }],
  events: [{ id: 'ev-1', title: '玻璃上的手印', description: '温室的玻璃上多了一枚陌生手印', location: '温室' }],
}

const TOUR_KEY = 'possibility:s03-tour:v1:demo'

/** 多空间访客地图打桩(仅导览用例需要的面) */
async function mockGuestMap(page: Page) {
  await page.addInitScript(() => localStorage.setItem('possibility:flag:voxel', '1'))
  await page.route('**/api/demo/session', (route) => route.fulfill({ json: { token: 'guest-token', sessionId: 'session-1', worldId: 'demo', timelineId: 'main', generation: 1, expiresAt: '2026-09-29T12:00:00.000Z' } }))
  await page.route('**/api/worlds/demo/map/bootstrap**', (route) => route.fulfill({ json: {
    access: { observe: true, participate: true, editScene: false, fork: true, compare: true, persist: false, resetDemo: true },
    world: guestSnapshot,
    scene: { status: 'ready', document: voxelSpaces },
    presentation: { timelineId: 'main', stateVersion: 1, simNow: guestSnapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
    theme: { id: 'mist-manor', assetVersion: 'fixture' },
    resume: { worldId: 'demo', timelineId: 'main', spaceId: 'exterior', mode: 'life', updatedAt: guestSnapshot.simNow },
  } }))
  await page.route('**/api/worlds/demo/map/resume', (route) => route.fulfill({ json: { ok: true } }))
}

async function seedTour(page: Page, done: string[]) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [TOUR_KEY, JSON.stringify(done)] as const)
}

async function residentScreen(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const probe = window.__voxelEngine as never as {
      residents: { snapshot(): { personId: string; position: { x: number; y: number; z: number } }[] } | null
      worldToScreen(at: { x: number; y: number; z: number }): { x: number; y: number } | null
    } | undefined
    const resident = probe?.residents?.snapshot().find(item => item.personId === 'person-host')
    if (!probe || !resident) return null
    const at = { x: Math.floor(resident.position.x), y: Math.floor(resident.position.y) + 1, z: Math.floor(resident.position.z) }
    return probe.worldToScreen(at)
  })
}

async function canvasReady(page: Page) {
  await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
  await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible()
}

test.describe('S3 导览重开与跳步反馈(F3)', () => {
  test('导览完成后「重新开启导览」重置到第 1 步并清空持久化进度', async ({ page }) => {
    await mockGuestMap(page)
    await seedTour(page, ['discover-event', 'inspect-person', 'enter-location', 'interact', 'change-condition', 'fork', 'compare', 'return'])
    await page.goto('/')
    await canvasReady(page)
    await expect(page.getByText('导览已完成')).toBeVisible()

    await page.getByRole('button', { name: '关闭导览' }).click()
    // 已完成态:底部按钮为「重新开启导览」(重置语义)
    const restart = page.getByRole('button', { name: '重新开启导览' })
    await expect(restart).toBeVisible()
    await restart.click()
    await expect(page.getByText('体验指引 1/8')).toBeVisible()
    expect(await page.evaluate(key => localStorage.getItem(key), TOUR_KEY)).toBeNull()
  })

  test('导览中途关闭后「继续导览」恢复原进度,不重置', async ({ page }) => {
    await mockGuestMap(page)
    await seedTour(page, ['discover-event'])
    await page.goto('/')
    await canvasReady(page)
    await expect(page.getByText('体验指引 2/8')).toBeVisible()

    await page.getByRole('button', { name: '关闭导览' }).click()
    const resume = page.getByRole('button', { name: '继续导览' })
    await expect(resume).toBeVisible()
    await resume.click()
    await expect(page.getByText('体验指引 2/8')).toBeVisible()
    expect(await page.evaluate(key => localStorage.getItem(key), TOUR_KEY)).toContain('discover-event')
  })

  test('乱序完成后填补缺口:显示跳步并提示此前已完成的步骤', async ({ page }) => {
    await mockGuestMap(page)
    // 已完成 1/3/4 步(显示 2/8);点击居民完成第 2 步 → 显示跳到 5/8
    await seedTour(page, ['discover-event', 'enter-location', 'interact'])
    await page.goto('/')
    await canvasReady(page)
    await expect(page.getByText('体验指引 2/8')).toBeVisible()

    await expect(async () => {
      const at = await residentScreen(page)
      expect(at).not.toBeNull()
      await page.mouse.click(at!.x, at!.y)
      await expect(page.getByText('体验指引 5/8')).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 10000 })
    await expect(page.getByText('第 3–4 步此前已完成')).toBeVisible()
  })
})

test.describe('S3 单空间 owner 路径选中卡(F1/F2)', () => {
  const ownerSnapshot = {
    world: { id: 'world-1', name: '雾影庄', description: '体素世界', status: 'running', pauseReason: null, isDemo: false, callsToday: 0, locations: [{ name: '主楼', description: '庄园主楼' }, { name: '温室', description: '玻璃温室' }] },
    timelines: [{ id: 'timeline-main', parentTimelineId: null, status: 'active', simNow: '2026-09-19T12:00:00.000Z', createdAt: '2026-09-18T09:00:00.000Z', forkScenario: null }],
    currentTimelineId: 'timeline-main', simNow: '2026-09-19T12:00:00.000Z',
    stateVersion: 1, worldModelVersion: 1, evidenceStatus: 'structured', evidence: { level: 'complete', reasonCodes: [] }, currentFacts: [],
    locationBoard: [{ location: '主楼', persons: [{ id: 'person-1', name: '小夜', activity: '读书' }] }],
    events: [],
  }

  async function mockOwnerSingleSpace(page: Page) {
    await page.addInitScript(() => {
      localStorage.setItem('possibility_token', 'e2e-token')
      localStorage.setItem('possibility:flag:voxel', '1')
    })
    await page.route('**/api/worlds', (route) => route.fulfill({ json: { worlds: [{ id: 'world-1', name: '雾影庄' }] } }))
    await page.route('**/api/worlds/world-1/stream**', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' }))
    await page.route('**/api/worlds/world-1/map/bootstrap**', (route) => route.fulfill({ json: {
      access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false },
      world: ownerSnapshot,
      scene: { status: 'ready', document: exteriorDoc },
      presentation: { timelineId: 'timeline-main', stateVersion: 1, simNow: ownerSnapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
      theme: { id: 'mist-manor', assetVersion: 'e2e' },
      resume: { worldId: 'world-1', timelineId: 'timeline-main', spaceId: 'exterior', mode: 'life', updatedAt: ownerSnapshot.simNow },
    } }))
    await page.route(/\/api\/worlds\/world-1(?:\?|$)/, route => route.fulfill({ json: ownerSnapshot }))
    await page.route('**/api/worlds/world-1/map/resume', (route) => route.fulfill({ json: { ok: true } }))
    await page.route('**/api/worlds/world-1/persona?**', (route) => route.fulfill({ json: { persona: { id: 'p-visitor', name: '访客', description: '旅人', location: '主楼' }, unread: 0 } }))
    await page.route('**/api/worlds/world-1/persona/messages**', (route) => route.fulfill({ json: { messages: [], mentions: [] } }))
    await page.route('**/api/worlds/world-1/scene/board**', (route) => route.fulfill({ json: { board: [{ location: '主楼', count: 1, people: [{ id: 'person-1', name: '小夜' }] }] } }))
    await page.route('**/api/worlds/world-1/scene/history**', (route) => route.fulfill({ json: { dialogueId: null, location: null, turns: [] } }))
    await page.route('**/api/worlds/world-1/scene/intent/pending**', (route) => route.fulfill({ json: { proposal: null } }))
    await page.route('**/api/worlds/world-1/state**', (route) => route.fulfill({ json: { version: 1 } }))
    await page.route('**/api/worlds/world-1/timelines/*/history', (route) => route.fulfill({ json: { earliest: null, simNow: ownerSnapshot.simNow } }))
    await page.route('**/voxel-assets/**', (route) => route.fulfill({ status: 404, body: 'not found' }))
  }

  test('owner 单空间路径点击地点得选中卡,「进入此地点」预选该地点', async ({ page }) => {
    await mockOwnerSingleSpace(page)
    await page.goto('/worlds/world-1')
    await canvasReady(page)

    // F4:owner 路径地图行不塌缩(塌缩基线为 min-h 430px)
    const canvasBox = await page.getByTestId('voxel-viewport-canvas').boundingBox()
    expect(canvasBox?.height ?? 0).toBeGreaterThanOrEqual(480)

    // 点击温室(地点绑定物体;fixture 屋顶锚点,沿用 voxel-guest 坐标)
    const roof = await page.evaluate(() => (window.__voxelEngine as never as {
      worldToScreen(at: { x: number; y: number; z: number }): { x: number; y: number } | null
    }).worldToScreen({ x: 8, y: 4, z: 11 })!)
    await page.mouse.click(roof.x, roof.y)
    await expect(page.getByTestId('map-selection-card')).toBeVisible()
    await expect(page.getByRole('heading', { name: '温室' })).toBeVisible()

    // 卡片 → ScenePanel,预选该地点(persona 记忆地点为主楼,传入地点优先)
    await page.getByRole('button', { name: '进入此地点' }).click()
    await expect(page.getByRole('heading', { name: '进入世界' })).toBeVisible()
    await expect(page.getByLabel('进入地点')).toHaveValue('温室')
  })

  test('进入地点已失效:面板明确提示并回退到可选地点', async ({ page }) => {
    await mockOwnerSingleSpace(page)
    // 世界地点列表不含温室 → 从卡片带去的「温室」失效
    await page.route('**/api/worlds/world-1/map/bootstrap**', (route) => route.fulfill({ json: {
      access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false },
      world: { ...ownerSnapshot, world: { ...ownerSnapshot.world, locations: [{ name: '主楼', description: '庄园主楼' }] } },
      scene: { status: 'ready', document: exteriorDoc },
      presentation: { timelineId: 'timeline-main', stateVersion: 1, simNow: ownerSnapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
      theme: { id: 'mist-manor', assetVersion: 'e2e' },
      resume: { worldId: 'world-1', timelineId: 'timeline-main', spaceId: 'exterior', mode: 'life', updatedAt: ownerSnapshot.simNow },
    } }))
    await page.goto('/worlds/world-1')
    await canvasReady(page)

    const roof = await page.evaluate(() => (window.__voxelEngine as never as {
      worldToScreen(at: { x: number; y: number; z: number }): { x: number; y: number } | null
    }).worldToScreen({ x: 8, y: 4, z: 11 })!)
    await page.mouse.click(roof.x, roof.y)
    await expect(page.getByTestId('map-selection-card')).toBeVisible()
    await page.getByRole('button', { name: '进入此地点' }).click()
    await expect(page.getByRole('heading', { name: '进入世界' })).toBeVisible()
    await expect(page.getByText(/「温室」已不在当前地点列表中/)).toBeVisible()
    await expect(page.getByLabel('进入地点')).toHaveValue('主楼')
  })

  test('所有者保存世界时区后即时更新时钟,绝对 instant 不变', async ({ page }) => {
    await mockOwnerSingleSpace(page)
    let updatePayload: Record<string, unknown> | null = null
    await page.route('**/api/worlds/world-1/time-zone', async (route) => {
      if (route.request().method() === 'PUT') {
        updatePayload = route.request().postDataJSON()
        return route.fulfill({ json: { timeZone: 'Asia/Tokyo' } })
      }
      return route.fulfill({ json: { timeZone: 'UTC' } })
    })

    await page.goto('/worlds/world-1')
    await canvasReady(page)
    await expect(page.getByText('世界时间 2026-09-19 12:00 (UTC)')).toBeVisible()
    await page.getByLabel('世界时区').selectOption('Asia/Tokyo')
    await page.getByRole('button', { name: '保存时区' }).click()
    await expect(page.getByText('世界时区已更新。')).toBeVisible()
    await expect(page.getByText('世界时间 2026-09-19 21:00 (Asia/Tokyo)')).toBeVisible()
    expect(updatePayload).toEqual({ timeZone: 'Asia/Tokyo' })
  })


  test('行动确认遇到版本冲突:保留原文、刷新状态且不自动重放', async ({ page }) => {
    await mockOwnerSingleSpace(page)
    let personaReads = 0
    let boardReads = 0
    let stateReads = 0
    let intentCalls = 0
    let positionCalls = 0

    // Later handlers intentionally override the baseline owner fixture for this scenario.
    await page.route('**/api/worlds/world-1/persona?**', (route) => {
      personaReads += 1
      return route.fulfill({ json: {
        persona: { id: 'p-visitor', name: '访客', description: '旅人', location: personaReads > 1 ? '温室' : '主楼' }, unread: 0,
      } })
    })
    await page.route('**/api/worlds/world-1/scene/board**', (route) => {
      boardReads += 1
      return route.fulfill({ json: {
        board: [{ location: '主楼', count: boardReads > 1 ? 0 : 1, people: boardReads > 1 ? [] : [{ id: 'person-1', name: '小夜' }] },
          { location: '温室', count: boardReads > 1 ? 2 : 0, people: boardReads > 1 ? [{ id: 'person-1', name: '小夜' }, { id: 'person-2', name: '阿芙' }] : [] }],
      } })
    })
    await page.route('**/api/worlds/world-1/state**', (route) => {
      stateReads += 1
      return route.fulfill({ json: { version: 2 } })
    })
    await page.route('**/api/worlds/world-1/scene/intent', (route) => {
      intentCalls += 1
      const body = route.request().postDataJSON() as { requestId: string }
      return route.fulfill({ json: {
        requestId: body.requestId, timelineId: 'timeline-main', expectedVersion: 1, currentLocation: '主楼',
        status: 'proposal', confirmationRequired: true, proposal: { type: 'move', to: '温室' },
      } })
    })
    await page.route('**/api/worlds/world-1/actions/*', (route) => route.fulfill({ status: 404, json: { error: '命令不存在' } }))
    await page.route('**/api/worlds/world-1/scene/intent/*/cancel', (route) => route.fulfill({ json: { status: 'cancelled' } }))
    await page.route('**/api/worlds/world-1/scene/position', (route) => {
      positionCalls += 1
      return route.fulfill({ json: { commandId: 'unexpected', version: 3, location: '温室' } })
    })

    await page.goto('/worlds/world-1')
    await canvasReady(page)
    await page.getByRole('button', { name: '在场' }).click()
    await expect(page.getByRole('heading', { name: '进入世界' })).toBeVisible()
    await page.getByText('尝试一个行动').click()

    const action = page.getByLabel('行动描述')
    await action.fill('带我去温室')
    await page.getByRole('button', { name: '生成提议' }).click()
    await expect(page.getByText('提议（世界状态 v1）')).toBeVisible()
    await expect(page.getByText('前往温室')).toBeVisible()

    await page.getByRole('button', { name: '确认执行' }).click()
    await expect(page.getByText('世界状态和地点已刷新。原行动描述已保留；请确认后再重新生成提议。')).toBeVisible()
    await expect(action).toHaveValue('带我去温室')
    await expect(page.getByRole('button', { name: '重新生成提议' })).toBeVisible()
    await expect(page.getByLabel('进入地点')).toHaveValue('温室')
    await expect(page.getByLabel('进入地点').locator('option[value="温室"]')).toContainText('温室（2 人可交谈）')
    await expect(page.getByRole('button', { name: '确认执行' })).toHaveCount(0)

    expect(personaReads).toBeGreaterThanOrEqual(2)
    expect(boardReads).toBeGreaterThanOrEqual(2)
    expect(stateReads).toBeGreaterThanOrEqual(2)
    expect(intentCalls).toBe(1)
    expect(positionCalls).toBe(0)

    await page.getByRole('button', { name: '重新生成提议' }).click()
    await expect(page.getByText('提议（世界状态 v1）')).toBeVisible()
    expect(intentCalls).toBe(2)
    expect(positionCalls).toBe(0)
  })

  test('行动冲突刷新失败:保留原文并提供可理解的恢复路径', async ({ page }) => {
    await mockOwnerSingleSpace(page)
    let intentCalls = 0
    let positionCalls = 0
    let personaReads = 0
    let boardReads = 0
    let failRefresh = false
    await page.route('**/api/worlds/world-1/state**', route => route.fulfill({ json: { version: 2 } }))
    await page.route('**/api/worlds/world-1/scene/intent', route => {
      intentCalls += 1
      const body = route.request().postDataJSON() as { requestId: string }
      return route.fulfill({ json: {
        requestId: body.requestId, timelineId: 'timeline-main', expectedVersion: 1, currentLocation: '主楼',
        status: 'proposal', confirmationRequired: true, proposal: { type: 'move', to: '温室' },
      } })
    })
    await page.route('**/api/worlds/world-1/actions/*', route => route.fulfill({ status: 404, json: { error: '命令不存在' } }))
    await page.route('**/api/worlds/world-1/scene/intent/*/cancel', route => route.fulfill({ json: { status: 'cancelled' } }))
    await page.route('**/api/worlds/world-1/persona?**', route => {
      personaReads += 1
      if (failRefresh) return route.fulfill({ status: 503, json: { error: '暂不可用' } })
      return route.fulfill({ json: { persona: { id: 'p-visitor', name: '访客', description: '旅人', location: '主楼' }, unread: 0 } })
    })
    await page.route('**/api/worlds/world-1/scene/board**', route => {
      boardReads += 1
      if (failRefresh) return route.fulfill({ status: 503, json: { error: '暂不可用' } })
      return route.fulfill({ json: { board: [{ location: '主楼', count: 1, people: [{ id: 'person-1', name: '小夜' }] }] } })
    })
    await page.route('**/api/worlds/world-1/scene/position', route => {
      positionCalls += 1
      return route.fulfill({ json: { commandId: 'unexpected', version: 3, location: '温室' } })
    })

    await page.goto('/worlds/world-1')
    await canvasReady(page)
    await page.getByRole('button', { name: '在场' }).click()
    await expect(page.getByRole('heading', { name: '进入世界' })).toBeVisible()
    await page.getByText('尝试一个行动').click()
    const action = page.getByLabel('行动描述')
    await action.fill('带我去温室')
    await page.getByRole('button', { name: '生成提议' }).click()
    await expect(page.getByText('提议（世界状态 v1）')).toBeVisible()
    failRefresh = true
    await page.getByRole('button', { name: '确认执行' }).click()

    await expect(page.getByText('世界状态可能已变化。原行动描述已保留，请重新打开面板或重试。')).toBeVisible()
    await expect(action).toHaveValue('带我去温室')
    await expect(page.getByText('状态或地点刷新失败；保留原行动描述，可再次尝试刷新或手动重新生成。')).toBeVisible()
    await expect(page.getByRole('button', { name: '重新生成提议' })).toBeVisible()
    await expect(page.getByRole('button', { name: '确认执行' })).toHaveCount(0)
    expect(intentCalls).toBe(1)
    expect(positionCalls).toBe(0)
  })
})

test.describe('S3 移动端布局(F4)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('移动端保存后形态:地图铺开、无横向滚动、控件可见', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('possibility_token', 'e2e-token')
      localStorage.setItem('possibility:flag:voxel', '1')
    })
    await page.route('**/api/worlds', (route) => route.fulfill({ json: { worlds: [{ id: 'world-1', name: '雾影庄' }] } }))
    await page.route('**/api/worlds/world-1/stream**', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' }))
    await page.route('**/api/worlds/world-1/map/bootstrap**', (route) => route.fulfill({ json: {
      access: { observe: true, participate: true, editScene: false, fork: true, compare: true, persist: true, resetDemo: false },
      world: { ...guestSnapshot, world: { ...guestSnapshot.world, id: 'world-1', isDemo: false } },
      scene: { status: 'ready', document: voxelSpaces },
      presentation: { timelineId: 'main', stateVersion: 1, simNow: guestSnapshot.simNow, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
      theme: { id: 'mist-manor', assetVersion: 'e2e' },
      resume: { worldId: 'world-1', timelineId: 'main', spaceId: 'exterior', mode: 'life', updatedAt: guestSnapshot.simNow },
    } }))
    await page.route('**/api/worlds/world-1/map/resume', (route) => route.fulfill({ json: { ok: true } }))
    await page.route('**/voxel-assets/**', (route) => route.fulfill({ status: 404, body: 'not found' }))

    await page.goto('/worlds/world-1')
    await canvasReady(page)

    const box = await page.getByTestId('voxel-viewport-canvas').boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(844 * 0.85)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    // 主要控件不被遮挡:空间切换、设置、导览面板
    await expect(page.getByTestId('voxel-space-main-hall')).toBeVisible()
    await expect(page.getByLabel('设置')).toBeVisible()
    await expect(page.getByText('体验指引 1/8')).toBeVisible()
  })
})
