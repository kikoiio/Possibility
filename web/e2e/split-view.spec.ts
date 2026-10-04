import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { comparisonFor, events, FORK_AT, snapshotFor, stubSplitApis, watchErrors } from './split-view-stubs'

/**
 * S1 分屏平行视口与对齐时间轴 e2e(T7,AC1/AC2/AC4/AC5/AC7)。
 * 截图输出 /tmp/possibility-walkthrough/s01-split-view/(本地临时目录,随 Playwright outputDir 惯例放 /tmp,不入库)。
 */

const SHOTS = '/tmp/possibility-walkthrough/s01-split-view'
mkdirSync(SHOTS, { recursive: true })

// 双 SwiftShader WebGL 上下文 + 并行负载,整体放宽;文件内串行,避免两个双上下文页面互抢资源
test.describe.configure({ mode: 'serial', timeout: 180_000 })

interface EngineProbe { getOrbitPose(): { theta: number; phi: number; distance: number; target: { x: number; y: number; z: number } } | null; setOrbitPose(p: unknown): void }
interface ProbeWindow { __voxelEngine?: EngineProbe; __voxelEngines?: Record<string, EngineProbe>; __leftBefore?: EngineProbe }

const leftCanvas = (page: Page) => page.locator('[data-voxel-instance="left"] [data-testid="voxel-viewport-canvas"]')
const rightCanvas = (page: Page) => page.locator('[data-voxel-instance="right"] [data-testid="voxel-viewport-canvas"]')

async function openSplit(page: Page) {
  await page.goto('/worlds/world-1?mode=possibility&timeline=timeline-main&right=timeline-fork')
  // 双 SwiftShader 上下文在并行负载下较慢,放宽到 30s
  await expect(leftCanvas(page)).toBeVisible({ timeout: 30000 })
  await expect(rightCanvas(page)).toBeVisible({ timeout: 30000 })
  // 双侧引擎就绪(探针注册完成)
  await expect.poll(() => page.evaluate(() => {
    const w = window as unknown as ProbeWindow
    return Boolean(w.__voxelEngines?.left && w.__voxelEngines?.right)
  }), { timeout: 30000 }).toBe(true)
}

test.describe('S1 分屏平行视口(AC1/AC2)', () => {
  test('双视口实例隔离渲染,标题/时钟/事件流各归各线', async ({ page }) => {
    const errors = watchErrors(page)
    await stubSplitApis(page)
    await openSplit(page)

    // 探针:双实例注册表分离;__voxelEngine 仍为主实例(左侧,向后兼容)
    const probes = await page.evaluate(() => {
      const w = window as unknown as ProbeWindow
      return {
        separate: Boolean(w.__voxelEngines?.left && w.__voxelEngines?.right && w.__voxelEngines.left !== w.__voxelEngines.right),
        primary: w.__voxelEngine === w.__voxelEngines?.left,
      }
    })
    expect(probes.separate).toBe(true)
    expect(probes.primary).toBe(true)

    await expect(page.getByTestId('split-title-left')).toContainText('原来的发展 · 主线')
    await expect(page.getByTestId('split-title-right')).toContainText('另一种发展 · 分叉')
    await expect(page.getByTestId('split-title-right')).toContainText('那封信准时送达')
    await expect(page.getByTestId('split-clock-left')).toContainText('2026-09-19 12:00 (UTC)')
    await expect(page.getByTestId('split-clock-right')).toContainText('2026-09-19 12:00 (UTC)')
    await expect(page.getByTestId('split-events-left')).toContainText(events.left.title)
    await expect(page.getByTestId('split-events-left')).not.toContainText(events.rightEarly.title)
    await expect(page.getByTestId('split-events-right')).toContainText(events.rightEarly.title)
    await expect(page.getByTestId('split-events-right')).toContainText(events.rightLate.title)
    expect(errors).toEqual([])
  })

  test('隔离:右侧切线不影响左侧;对照接口失败左侧照常', async ({ page }) => {
    const errors = watchErrors(page)
    await stubSplitApis(page)
    await openSplit(page)

    // 右侧切换到第三条线:左侧引擎实例与数据不变
    await page.evaluate(() => { (window as unknown as ProbeWindow).__leftBefore = (window as unknown as ProbeWindow).__voxelEngines?.left })
    await page.getByTestId('split-right-selector').selectOption('timeline-fork-2')
    await expect(page.getByTestId('split-events-right')).not.toContainText(events.rightEarly.title, { timeout: 10000 })
    await expect(page.getByTestId('split-events-right')).toContainText(events.shared.title)
    await expect(page.getByTestId('split-events-left')).toContainText(events.left.title)
    await expect(page.getByTestId('split-title-left')).toContainText('主线')
    expect(await page.evaluate(() => {
      const w = window as unknown as ProbeWindow
      return w.__voxelEngines?.left === w.__leftBefore
    })).toBe(true)
    expect(errors).toEqual([])
  })

  test('dispose:关闭分屏后引擎注册表回落,重新进入不泄漏', async ({ page }) => {
    const errors = watchErrors(page)
    await stubSplitApis(page)
    await openSplit(page)
    expect(await page.evaluate(() => Object.keys((window as unknown as ProbeWindow).__voxelEngines ?? {}).sort())).toEqual(['left', 'right'])

    // 关闭分屏:右实例摘除,主实例别名回到 main
    await page.getByTestId('split-close-right').click()
    await expect(page.locator('[data-voxel-instance="main"]')).toHaveCount(1, { timeout: 30000 })
    await expect.poll(() => page.evaluate(() => Object.keys((window as unknown as ProbeWindow).__voxelEngines ?? {}))).toEqual(['main'])
    expect(await page.evaluate(() => {
      const w = window as unknown as ProbeWindow
      return w.__voxelEngine === w.__voxelEngines?.main
    })).toBe(true)

    // 重新进入分屏:双实例重新注册,无残留
    await page.goto('/worlds/world-1?mode=possibility&timeline=timeline-main&right=timeline-fork')
    await expect.poll(() => page.evaluate(() => Object.keys((window as unknown as ProbeWindow).__voxelEngines ?? {}).sort()), { timeout: 30000 }).toEqual(['left', 'right'])
    expect(errors).toEqual([])
  })

  test('隔离:对照接口 500,左侧视口与标题照常渲染', async ({ page }) => {
    const errors = watchErrors(page)
    await stubSplitApis(page)
    await page.route('**/api/worlds/world-1/compare?*', (route) => route.fulfill({ status: 500, body: 'boom' }))
    await page.goto('/worlds/world-1?mode=possibility&timeline=timeline-main&right=timeline-fork')
    await expect(leftCanvas(page)).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('split-title-left')).toContainText('原来的发展 · 主线')
    await expect(page.getByTestId('split-events-left')).toContainText(events.left.title)
    expect(await page.evaluate(() => Boolean((window as unknown as ProbeWindow).__voxelEngines?.left))).toBe(true)
    // 对照失败有明示,不静默
    await expect(page.getByTestId('split-compare-error')).toContainText('时间线对照暂时无法读取', { timeout: 10000 })
    // 接口 500 的 console 噪音允许;页面级错误不允许
    expect(errors.filter((e) => !e.includes('500'))).toEqual([])
  })

  test('右侧快照失败只影响右面板，重试只重新读取右侧', async ({ page }) => {
    const errors = watchErrors(page)
    await stubSplitApis(page)
    let snapshotCalls = 0
    let compareCalls = 0
    await page.route('**/api/worlds/world-1?*', async (route) => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('timelineId') !== 'timeline-fork') return route.fallback()
      snapshotCalls++
      if (snapshotCalls <= 2) return route.fulfill({ status: 503, json: { error: 'internal database detail' } })
      return route.fulfill({ json: snapshotFor('timeline-fork') })
    })
    await page.route('**/api/worlds/world-1/compare?*', async (route) => {
      compareCalls++
      return route.fulfill({ json: comparisonFor('timeline-main', 'timeline-fork') })
    })
    await page.goto('/worlds/world-1?mode=possibility&timeline=timeline-main&right=timeline-fork')
    await expect(leftCanvas(page)).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('split-right-error')).toContainText('另一种发展暂时无法读取')
    await expect(page.getByTestId('split-right-error')).not.toContainText('internal database detail')
    await expect(page.getByTestId('split-compare-summary')).toBeVisible()
    await expect(page.getByTestId('world-canvas-error')).toHaveCount(0)
    const compareCallsBeforeRetry = compareCalls

    await page.getByTestId('split-right-retry').click()
    await expect.poll(() => snapshotCalls, { timeout: 5000 }).toBe(3)
    await expect(rightCanvas(page)).toBeVisible({ timeout: 30000 })
    await expect(page.getByTestId('split-right-error')).toHaveCount(0)
    expect(snapshotCalls).toBe(3)
    expect(compareCalls).toBe(compareCallsBeforeRetry)
    expect(errors.filter((e) => !e.includes('503'))).toEqual([])
  })

  test('对照失败保留左右场景，重试只读取对照资源', async ({ page }) => {
    const errors = watchErrors(page)
    await stubSplitApis(page)
    let snapshotCalls = 0
    let compareCalls = 0
    await page.route('**/api/worlds/world-1?*', async (route) => {
      snapshotCalls++
      return route.fallback()
    })
    await page.route('**/api/worlds/world-1/compare?*', async (route) => {
      compareCalls++
      if (compareCalls <= 2) return route.fulfill({ status: 502, json: { error: 'internal provider detail' } })
      return route.fulfill({ json: comparisonFor('timeline-main', 'timeline-fork') })
    })
    await page.goto('/worlds/world-1?mode=possibility&timeline=timeline-main&right=timeline-fork')
    await expect(leftCanvas(page)).toBeVisible({ timeout: 15000 })
    await expect(rightCanvas(page)).toBeVisible({ timeout: 30000 })
    await expect(page.getByTestId('split-compare-error')).toContainText('时间线对照暂时无法读取')
    await expect(page.getByTestId('split-compare-error')).not.toContainText('internal provider detail')
    const snapshotCallsBeforeRetry = snapshotCalls
    await page.getByTestId('split-compare-retry').click()
    await expect(page.getByTestId('split-compare-summary')).toBeVisible()
    await expect(page.getByTestId('split-compare-error')).toHaveCount(0)
    expect(compareCalls).toBe(3)
    expect(snapshotCalls).toBe(snapshotCallsBeforeRetry)
    expect(errors.filter((e) => !e.includes('502'))).toEqual([])
  })

  test('关闭分屏后，迟到的右侧快照不会重新写入当前视图', async ({ page }) => {
    const errors = watchErrors(page)
    await stubSplitApis(page)
    let releaseSnapshot!: () => void
    const held = new Promise<void>(resolve => { releaseSnapshot = resolve })
    await page.route('**/api/worlds/world-1?*', async (route) => {
      if (new URL(route.request().url()).searchParams.get('timelineId') !== 'timeline-fork') return route.fallback()
      await held
      return route.fulfill({ json: snapshotFor('timeline-fork') })
    })
    await page.goto('/worlds/world-1?mode=possibility&timeline=timeline-main&right=timeline-fork')
    await expect(leftCanvas(page)).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('split-right-loading')).toBeVisible()
    await page.getByTestId('split-close-right').click()
    await expect(page.getByTestId('split-view')).toHaveCount(0)
    releaseSnapshot()
    await expect(page.getByTestId('split-view')).toHaveCount(0)
    expect(errors).toEqual([])
  })
})

test.describe('S1 相机联动(AC1)', () => {
  test('联动开启一侧操作同步另一侧;关闭后各自独立', async ({ page }) => {
    const errors = watchErrors(page)
    await stubSplitApis(page)
    await openSplit(page)

    const poseA = { theta: 1.9, phi: 0.7, distance: 90, target: { x: 5, y: 3, z: 8 } }
    await page.evaluate((pose) => (window as unknown as ProbeWindow).__voxelEngines!.left!.setOrbitPose(pose), poseA)
    // 联动经 rAF 帧回路传播,软渲染双上下文下放宽到 30s
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as ProbeWindow).__voxelEngines?.right?.getOrbitPose()))?.theta, { timeout: 30000 }).toBeCloseTo(1.9, 2)

    // 关闭联动:左侧再动,右侧不动
    await page.getByTestId('split-camera-link').uncheck()
    const poseB = { ...poseA, theta: 0.4 }
    await page.evaluate((pose) => (window as unknown as ProbeWindow).__voxelEngines!.left!.setOrbitPose(pose), poseB)
    await page.waitForTimeout(400)
    const rightTheta = (await page.evaluate(() => (window as unknown as ProbeWindow).__voxelEngines?.right?.getOrbitPose()))!.theta
    expect(rightTheta).toBeCloseTo(1.9, 2)
    expect(errors).toEqual([])
  })
})

test.describe('S1 对齐时间轴(AC3/AC4/AC5)', () => {
  test('分叉点原点、首个分歧标记、拖档截断与点击定位', async ({ page }) => {
    const errors = watchErrors(page)
    await stubSplitApis(page)
    await openSplit(page)

    // 轴:分叉点原点 / 两线 simNow 常驻 / 首个分歧强调 / 三色标记(1 共同 + 1 左 + 2 右)
    await expect(page.getByTestId('aligned-timeline-origin')).toBeVisible()
    await expect(page.getByTestId('aligned-timeline-left-now')).toBeVisible()
    await expect(page.getByTestId('aligned-timeline-right-now')).toBeVisible()
    await expect(page.getByTestId('aligned-timeline-first-divergence')).toContainText('从这里开始不同')
    await expect(page.getByTestId('aligned-timeline-marker')).toHaveCount(4)
    await expect(page.locator('[data-testid="aligned-timeline-marker"][data-side="shared"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="aligned-timeline-marker"][data-side="left"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="aligned-timeline-marker"][data-side="right"]')).toHaveCount(2)

    // 拖档到 09:45(分叉后、首个分歧后):事件流按 simTime 截断,两侧出现「视口为当前状态」徽标
    await page.getByTestId('aligned-timeline-scrub').fill(String(Date.parse('2026-09-19T09:45:00.000Z')))
    await expect(page.getByTestId('aligned-timeline-review-badge')).toContainText('回看中')
    await expect(page.getByTestId('split-current-badge-left')).toContainText('视口为当前状态')
    await expect(page.getByTestId('split-current-badge-right')).toContainText('视口为当前状态')
    await expect(page.getByTestId('split-events-left')).toContainText(events.shared.title)
    await expect(page.getByTestId('split-events-left')).not.toContainText(events.left.title)
    await expect(page.getByTestId('split-events-right')).toContainText(events.rightEarly.title)
    await expect(page.getByTestId('split-events-right')).not.toContainText(events.rightLate.title)
    // 拖档触发带 simTime 的对照重取,对齐 limitations(状态无历史表)原文呈现
    await expect(page.getByTestId('split-limitations')).toContainText('Person states have no history table', { timeout: 10000 })
    await page.screenshot({ path: `${SHOTS}/02-scrubbed.png` })

    // 点击首个分歧标记 → 右侧事件流定位高亮
    await page.locator('[data-testid="aligned-timeline-marker"][data-event-id="ev-right-1"]').click()
    await expect(page.locator('[data-testid="split-events-right"] [data-event-id="ev-right-1"]')).toHaveClass(/bg-amber-100/)

    // 回到当下:徽标消失,事件流恢复
    await page.getByRole('button', { name: '回到当下' }).click()
    await expect(page.getByTestId('aligned-timeline-review-badge')).toBeHidden()
    await expect(page.getByTestId('split-events-left')).toContainText(events.left.title)
    await expect(page.getByTestId('split-events-right')).toContainText(events.rightLate.title)
    expect(errors).toEqual([])
  })
})

test.describe('S1 入口(F6)', () => {
  test('TimelineSwitcher「分屏比较」导航到分屏', async ({ page }) => {
    const errors = watchErrors(page)
    await stubSplitApis(page)
    await page.goto('/worlds/world-1?timeline=timeline-main')
    // 文字视图秒级时钟高频重渲染,按钮易被重建;dispatchEvent 绕过可动性检查
    await page.getByRole('button', { name: /主宇宙 ▾|平行宇宙 ▾/ }).dispatchEvent('click')
    await page.getByTestId('split-view-entry').click()
    await expect(page).toHaveURL(/mode=possibility/)
    await expect(page.getByTestId('split-left')).toBeVisible({ timeout: 30000 })
    expect(errors).toEqual([])
  })

  test('ComparePanel「分屏查看」带上左右选择导航', async ({ page }) => {
    const errors = watchErrors(page)
    await stubSplitApis(page)
    await page.goto('/worlds/world-1?timeline=timeline-main')
    await page.getByRole('button', { name: '对照宇宙' }).click()
    await expect(page.getByRole('heading', { name: '两种人生' })).toBeVisible()
    await page.getByTestId('compare-split-entry').click()
    await expect(page).toHaveURL(/mode=possibility/)
    await expect(page).toHaveURL(/right=timeline-fork/)
    await expect(page.getByTestId('split-left')).toBeVisible({ timeout: 30000 })
    expect(errors).toEqual([])
  })
})

test('S1 端到端走查(AC7):分屏 → 拖档 → 点击分歧,截图落盘', async ({ page }) => {
  const errors = watchErrors(page)
  await stubSplitApis(page)
  await openSplit(page)
  await page.waitForTimeout(600) // 软渲染首帧稳定
  await page.screenshot({ path: `${SHOTS}/01-split-overview.png` })

  await page.getByTestId('aligned-timeline-scrub').fill(String(Date.parse('2026-09-19T09:45:00.000Z')))
  await expect(page.getByTestId('aligned-timeline-review-badge')).toBeVisible()
  await page.locator('[data-testid="aligned-timeline-marker"][data-event-id="ev-right-1"]').click()
  await expect(page.locator('[data-testid="split-events-right"] [data-event-id="ev-right-1"]')).toHaveClass(/bg-amber-100/)
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOTS}/03-divergence-selected.png` })

  // 分叉点原点数据与 stub 一致(09:00)
  await expect(page.getByTestId('aligned-timeline')).toContainText('分叉点')
  expect(FORK_AT).toBe('2026-09-19T09:00:00.000Z')
  expect(errors).toEqual([])
})
