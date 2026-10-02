import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { comparisonFor } from './split-view-stubs'

/**
 * S4 世界模拟 e2e(AC1/AC3/AC4/AC6/AC7):生产路径事件全链。
 * ① bootstrap 携带 voxelEvents → 披露三态(活跃/留痕/未开始)
 * ② 面板展开:全文 + 参与者实名(personNames);留痕事件「已落幕」徽标
 * ③ SSE 推送 → snapshot 刷新 → 新事件无 reload 上线;同帧快照触发无日程居民环境漫步
 * ④ fork 隔离:分屏左右各自时间线的投影事件互不串线
 * 全程 window.__voxelEngine / __voxelEngines 探针断言 + walkthrough 截图(目检拍板)。
 */

test.setTimeout(120_000)

const voxelDocument = JSON.parse(readFileSync(new URL('./fixtures/voxel-scene.json', import.meta.url), 'utf8'))

const NOW = '2026-10-15T17:00:00.000Z'

const EVT_ACTIVE = {
  id: 'evt-s4-festival', type: 'celebration', importance: 'high',
  at: { x: 24, y: 1, z: 42 },
  timeWindow: { start: '2026-10-15T16:00:00.000Z', end: '2026-10-15T20:00:00.000Z' },
  label: '丰收庆典', teaser: '庭院里摆开了长桌', scene: '小夜把最后一篮果实放上长桌，灯笼逐一点亮。',
  participants: ['person-1'],
}
const EVT_TRACE = {
  id: 'evt-s4-fire', type: 'turning', importance: 'high',
  at: { x: 34, y: 1, z: 40 },
  timeWindow: { start: '2026-10-14T10:00:00.000Z', end: '2026-10-14T12:00:00.000Z' },
  label: '温室火警', teaser: '浓烟从温室升起', scene: '所幸扑救及时，只熏黑了一面玻璃。',
  participants: ['person-1'],
}
const EVT_HIDDEN = {
  id: 'evt-s4-flower', type: 'daily', importance: 'medium',
  at: { x: 24, y: 1, z: 42 },
  timeWindow: { start: '2026-10-16T09:00:00.000Z', end: '2026-10-16T11:00:00.000Z' },
  label: '明日花展', teaser: '花匠在准备展品', scene: '（尚未发生）',
}
const EVT_NEW = {
  id: 'evt-s4-bells', type: 'daily', importance: 'high',
  at: { x: 30, y: 1, z: 20 },
  timeWindow: { start: '2026-10-15T16:30:00.000Z', end: '2026-10-15T19:00:00.000Z' },
  label: '突发的钟声', teaser: '钟楼忽然敲响', scene: '钟声惊起了屋檐下的鸟群。',
  participants: ['person-1'],
}
const EVT_FORK = {
  id: 'evt-s4-fork-only', type: 'celebration', importance: 'high',
  at: { x: 24, y: 1, z: 42 },
  timeWindow: { start: '2026-10-15T16:00:00.000Z', end: '2026-10-15T20:00:00.000Z' },
  label: '分叉的庆典', teaser: '另一种发展里的庆典', scene: '这封信准时送达，庆典如期举行。',
  participants: ['person-1'],
}

const timelines = [
  { id: 'timeline-main', parentTimelineId: null, status: 'active', simNow: NOW, createdAt: '2026-10-14T09:00:00.000Z', forkScenario: null },
  { id: 'timeline-fork', parentTimelineId: 'timeline-main', status: 'active', simNow: NOW, createdAt: '2026-10-14T10:00:00.000Z', forkScenario: { whatIf: '那封信准时送达', changedVariable: '信件是否送达' } },
]

function snapshotFor(timelineId: string, voxelEvents: unknown[], stateVersion = 1) {
  return {
    world: { id: 'world-1', name: '雾影庄', description: '体素世界', status: 'running', pauseReason: null, isDemo: false, callsToday: 0, locations: [{ name: '主楼', description: '庄园主楼' }] },
    timelines,
    currentTimelineId: timelineId,
    simNow: NOW,
    stateVersion,
    worldModelVersion: 1,
    evidenceStatus: 'structured',
    evidence: { level: 'complete', reasonCodes: [] },
    currentFacts: [],
    locationBoard: [{ location: '主楼', persons: [{ id: 'person-1', name: '小夜', activity: '读书' }] }],
    events: [],
    voxelEvents,
  }
}

interface DisclosureState { eventId: string; phase: 'hidden' | 'trace' | 'active'; level: 'none' | 'icon' | 'teaser' }
interface ResidentSnapshot { personId: string; position: { x: number; y: number; z: number }; moving: boolean }
interface EngineProbe {
  getZoomTier(): 'overview' | 'district' | 'close'
  getEventDisclosure(): DisclosureState[]
  flyToEvent(id: string): boolean
  readonly disclosure: { screenAnchors(includeIconOnly: boolean): { eventId: string; x: number; y: number }[] } | null
  readonly residents: { snapshot(): ResidentSnapshot[] } | null
}

declare global {
  interface Window { __voxelEngine?: EngineProbe; __voxelEngines?: Record<string, EngineProbe>; __s4Mark?: number }
}

function engine<T>(page: Page, fn: (e: EngineProbe) => T): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__voxelEngine)`) as Promise<T>
}

function disclosureIds(page: Page, which: 'main' | 'left' | 'right' = 'main'): Promise<string[]> {
  return page.evaluate(`(() => {
    const e = ${which === 'main' ? 'window.__voxelEngine' : `window.__voxelEngines?.${which}`}
    return e ? e.getEventDisclosure().map((s) => s.eventId) : []
  })()`) as Promise<string[]>
}

function stateOf(list: DisclosureState[], id: string): DisclosureState {
  const found = list.find((s) => s.eventId === id)
  if (!found) throw new Error(`event ${id} not in disclosure states`)
  return found
}

/** 逐发滚轮到目标缩放档(生产页画布 testid 与 dev 页不同,勿复用 S3b 的 helper) */
async function wheelToTier(page: Page, tier: 'overview' | 'district' | 'close', deltaY: number) {
  const canvas = page.getByTestId('voxel-viewport-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('canvas not found')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 60; i++) {
    if ((await engine(page, (e) => e.getZoomTier())) === tier) return
    await page.mouse.wheel(0, deltaY)
    await page.waitForTimeout(60)
  }
  throw new Error(`tier ${tier} not reached`)
}

/** 事件图标屏幕坐标(eventId 内联进 evaluate 字符串) */
async function iconScreenPos(page: Page, eventId: string): Promise<{ x: number; y: number }> {
  const pos = await page.evaluate(
    `(() => window.__voxelEngine.disclosure?.screenAnchors(true).find((a) => a.eventId === ${JSON.stringify(eventId)}) ?? null)()`,
  ) as { x: number; y: number } | null
  if (!pos) throw new Error(`event ${eventId} has no screen anchor`)
  return pos
}

/**
 * 生产页 stub。streamPhase 0 = 只有 ping;1 = 重连后下发 sync 帧(stateVersion 2),
 * 同时 snapshot 刷新返回 EVT_NEW(模拟一拍蒸馏上线新事件)。
 */
function stubS4Apis(page: Page, state: { streamPhase: number }) {
  const syncFrame = 'event: sync\ndata: ' + JSON.stringify({
    worldId: 'world-1', timelineId: 'timeline-main', streamId: 's4-stream', sequence: 1, stateVersion: 2, type: 'sync',
  }) + '\n\n'
  return Promise.all([
    page.addInitScript(() => {
      localStorage.setItem('possibility_token', 'e2e-token')
      localStorage.setItem('possibility:flag:voxel', '1')
    }),
    page.route('**/api/worlds', (route) => route.fulfill({ json: { worlds: [{ id: 'world-1', name: '雾影庄' }] } })),
    page.route('**/api/worlds/world-1/stream**', (route) => route.fulfill({
      status: 200, contentType: 'text/event-stream',
      body: state.streamPhase === 0 ? 'event: ping\ndata: {}\n\n' : syncFrame,
    })),
    page.route('**/api/worlds/world-1/map/bootstrap**', (route) => {
      const id = new URL(route.request().url()).searchParams.get('timelineId') ?? 'timeline-main'
      const voxelEvents = id === 'timeline-fork' ? [EVT_FORK] : [EVT_ACTIVE, EVT_TRACE, EVT_HIDDEN]
      return route.fulfill({
        json: {
          access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false },
          world: snapshotFor(id, voxelEvents),
          scene: { status: 'ready', document: voxelDocument },
          presentation: { timelineId: id, stateVersion: 1, simNow: NOW, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
          theme: { id: 'mist-manor', assetVersion: 'e2e' },
          resume: { worldId: 'world-1', timelineId: id, spaceId: 'exterior', mode: 'life', updatedAt: NOW },
        },
      })
    }),
    page.route('**/api/worlds/world-1/map/resume', (route) => route.fulfill({ json: { ok: true } })),
    page.route('**/api/worlds/world-1/persona**', (route) => route.fulfill({ json: { persona: null, unread: 0 } })),
    page.route('**/api/worlds/world-1/state**', (route) => route.fulfill({ json: { timelineId: 'timeline-main', version: 1, worldModelVersion: 1, evidenceStatus: 'structured', current: [], facts: [] } })),
    page.route('**/api/worlds/world-1/return**', (route) => route.fulfill({ json: { timelineId: 'timeline-main', simNow: NOW, firstVisit: false, cursor: 0, events: [], commitments: [], unread: 0 } })),
    page.route('**/api/worlds/world-1/timelines/*/history', (route) => route.fulfill({ json: { earliest: null, simNow: NOW } })),
    page.route('**/api/worlds/world-1/compare?*', (route) => {
      const url = new URL(route.request().url())
      return route.fulfill({ json: comparisonFor(url.searchParams.get('left') ?? 'timeline-main', url.searchParams.get('right') ?? 'timeline-fork') })
    }),
    // SSE 触发的生活快照刷新:分叉线恒定;主线 phase 1 起带新事件 + stateVersion 2
    page.route('**/api/worlds/world-1?*', (route) => {
      const id = new URL(route.request().url()).searchParams.get('timelineId') ?? 'timeline-main'
      if (id === 'timeline-fork') return route.fulfill({ json: snapshotFor(id, [EVT_FORK]) })
      return route.fulfill({ json: state.streamPhase === 0
        ? snapshotFor(id, [EVT_ACTIVE, EVT_TRACE, EVT_HIDDEN])
        : snapshotFor(id, [EVT_ACTIVE, EVT_TRACE, EVT_HIDDEN, EVT_NEW], 2) })
    }),
    page.route('**/voxel-assets/**', (route) => route.fulfill({ status: 404, body: 'not found' })),
  ])
}

async function openWorld(page: Page, url = '/worlds/world-1', split = false) {
  await page.goto(url)
  await expect(page.getByTestId('voxel-viewport-canvas').first()).toBeVisible({ timeout: 15000 })
  if (split) {
    await expect(page.getByTestId('voxel-viewport-canvas')).toHaveCount(2, { timeout: 15000 })
    await expect(page.getByTestId('voxel-viewport-loading')).toHaveCount(0, { timeout: 15000 })
  } else {
    await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
  }
  await page.waitForTimeout(400)
}

test.describe('S4 世界模拟:事件全链(生产路径)', () => {
  test('bootstrap 携带事件 → 披露三态;面板展开含参与者实名;留痕事件已落幕徽标', async ({ page }) => {
    const state = { streamPhase: 0 }
    await stubS4Apis(page, state)
    await openWorld(page)

    // 三态:窗内活跃 / 已结束留痕 / 未开始隐藏(防剧透)
    await expect.poll(() => disclosureIds(page), { timeout: 15000 }).toEqual(expect.arrayContaining(['evt-s4-festival', 'evt-s4-fire', 'evt-s4-flower']))
    const states = await engine(page, (e) => e.getEventDisclosure())
    expect(stateOf(states, 'evt-s4-festival').phase).toBe('active')
    expect(stateOf(states, 'evt-s4-fire').phase).toBe('trace')
    expect(stateOf(states, 'evt-s4-flower').phase).toBe('hidden')

    // 展开:district 档点 teaser = 飞向事件(路由规则);落入 close 档后再点 = 开面板
    await wheelToTier(page, 'district', -120)
    await expect(page.getByTestId('event-teaser-evt-s4-festival')).toBeVisible()
    await page.getByTestId('event-teaser-evt-s4-festival').click()
    await expect.poll(() => engine(page, (e) => e.getZoomTier()), { timeout: 10000 }).toBe('close')
    await page.getByTestId('event-teaser-evt-s4-festival').click()
    await expect(page.getByTestId('event-panel')).toBeVisible()
    await expect(page.getByTestId('event-panel-title')).toHaveText('丰收庆典')
    await expect(page.getByTestId('event-panel-scene')).toContainText('长桌')
    // 参与者实名(personNames 解析;owner 页无选人出口 → 纯文本,guest 页才是可点按钮)
    await expect(page.getByTestId('event-panel-participants')).toContainText('小夜')
    await page.screenshot({ path: 'e2e/snapshots/voxel-s4-event-panel.png' })
    await page.getByLabel('关闭事件详情').click()
    await expect(page.getByTestId('event-panel')).toBeHidden()
  })

  test('guest 观察路径:点残影图标开面板(已落幕徽标 + 参与者实名)', async ({ page }) => {
    // guest/只读路径无编辑 controller,画布观察点击走事件路由(owner 页点击属于编辑器,S3b 起即如此);
    // 参与者点击选人仅 GuestWorldMap 接 onSelectPerson,单测覆盖,这里验证实名文本
    const guestSession = {
      token: 'guest-s4-token', sessionId: 'session-s4', worldId: 'demo', timelineId: 'main',
      generation: 1, expiresAt: '2026-10-16T12:00:00.000Z',
    }
    const guestSnapshot = snapshotFor('main', [EVT_ACTIVE, EVT_TRACE, EVT_HIDDEN])
    guestSnapshot.world = { ...guestSnapshot.world, id: 'demo', isDemo: true } as typeof guestSnapshot.world
    await page.addInitScript(() => localStorage.setItem('possibility:flag:voxel', '1'))
    await page.route('**/api/demo/session', (route) => route.fulfill({ json: guestSession }))
    await page.route('**/api/worlds/demo/map/bootstrap**', (route) => route.fulfill({ json: {
      access: { observe: true, participate: true, editScene: false, fork: true, compare: true, persist: false, resetDemo: true },
      world: guestSnapshot,
      scene: { status: 'ready', document: voxelDocument },
      presentation: { timelineId: 'main', stateVersion: 1, simNow: NOW, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] },
      theme: { id: 'mist-manor', assetVersion: 'fixture' },
      resume: { worldId: 'demo', timelineId: 'main', spaceId: 'exterior', mode: 'life', updatedAt: NOW },
    } }))
    await page.route('**/api/worlds/demo/map/resume', (route) => route.fulfill({ json: { ok: true } }))
    await page.route('**/api/worlds/demo/persona**', (route) => route.fulfill({ json: { persona: null, unread: 0 } }))
    await page.route('**/api/worlds/demo/state**', (route) => route.fulfill({ json: { version: 1 } }))
    await page.route('**/voxel-assets/**', (route) => route.fulfill({ status: 404, body: 'not found' }))

    await page.goto('/')
    await expect(page.getByTestId('voxel-viewport-canvas')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('voxel-viewport-loading')).toBeHidden({ timeout: 15000 })
    await page.waitForTimeout(400)

    // 留痕:任意档点残影图标直接开面板,带「已落幕」徽标
    await expect.poll(() => disclosureIds(page), { timeout: 15000 }).toContain('evt-s4-fire')
    const tracePos = await iconScreenPos(page, 'evt-s4-fire')
    await page.mouse.click(tracePos.x, tracePos.y)
    await expect(page.getByTestId('event-panel')).toBeVisible()
    await expect(page.getByTestId('event-panel-title')).toHaveText('温室火警')
    await expect(page.getByTestId('event-panel-trace')).toBeVisible()

    // 参与者实名(personNames 解析)
    await expect(page.getByTestId('event-panel-participants')).toContainText('小夜')
    await page.screenshot({ path: 'e2e/snapshots/voxel-s4-event-trace.png' })
  })

  test('SSE 推送 → 新事件无 reload 上线;同帧快照触发无日程居民环境漫步', async ({ page }) => {
    const state = { streamPhase: 0 }
    await stubS4Apis(page, state)
    await openWorld(page)
    await expect.poll(() => disclosureIds(page), { timeout: 15000 }).toHaveLength(3)

    // 页面存活标记(验证无 reload)+ 漫步前位置(首次落位在主楼锚点)
    await page.evaluate(() => { window.__s4Mark = 1 })
    const before = await engine(page, (e) => e.residents?.snapshot() ?? [])
    const meBefore = before.find((r) => r.personId === 'person-1')
    expect(meBefore).toBeTruthy()

    // 一拍过后:SSE sync 帧 → snapshot 刷新(stateVersion 2,新增突发钟声事件)
    state.streamPhase = 1
    await expect.poll(() => disclosureIds(page), { timeout: 30000 }).toContain('evt-s4-bells')
    const states = await engine(page, (e) => e.getEventDisclosure())
    expect(stateOf(states, 'evt-s4-bells').phase).toBe('active')
    // 无 reload:标记仍在
    expect(await page.evaluate(() => window.__s4Mark)).toBe(1)

    // 环境漫步:快照刷新带来第二次 overlay 同步,地点未变 → 锚点邻域确定性漫步(日程切换让位,单测覆盖)
    await expect.poll(async () => {
      const now = await engine(page, (e) => e.residents?.snapshot() ?? [])
      const me = now.find((r) => r.personId === 'person-1')
      if (!me) return 0
      return Math.max(Math.abs(me.position.x - meBefore!.position.x), Math.abs(me.position.z - meBefore!.position.z))
    }, { timeout: 20000 }).toBeGreaterThan(0.3)

    // walkthrough 截图:新事件图标 + 面板(目检拍板);flyToEvent 落 close 档,点 teaser 直接开面板
    await engine(page, (e) => e.flyToEvent('evt-s4-bells'))
    await expect.poll(() => engine(page, (e) => e.getZoomTier()), { timeout: 10000 }).toBe('close')
    await page.waitForTimeout(400)
    await page.screenshot({ path: 'e2e/snapshots/voxel-s4-event-active.png' })
    await page.getByTestId('event-teaser-evt-s4-bells').click()
    await expect(page.getByTestId('event-panel-title')).toHaveText('突发的钟声')
    await page.screenshot({ path: 'e2e/snapshots/voxel-s4-wander.png' })
  })

  test('fork 隔离:分屏左右各见本线投影事件,互不串线', async ({ page }) => {
    const state = { streamPhase: 0 }
    await stubS4Apis(page, state)
    await openWorld(page, '/worlds/world-1?mode=possibility&timeline=timeline-main&right=timeline-fork', true)
    await expect.poll(() => page.evaluate(() => Object.keys(window.__voxelEngines ?? {}).sort()), { timeout: 30000 }).toEqual(['left', 'right'])

    await expect.poll(() => disclosureIds(page, 'left'), { timeout: 15000 }).toContain('evt-s4-festival')
    await expect.poll(() => disclosureIds(page, 'right'), { timeout: 15000 }).toContain('evt-s4-fork-only')
    expect(await disclosureIds(page, 'left')).not.toContain('evt-s4-fork-only')
    expect(await disclosureIds(page, 'right')).not.toContain('evt-s4-festival')
  })
})
