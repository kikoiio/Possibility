import { expect, test, type Page } from '@playwright/test'
import { NOW, stubSplitApis, stubTimelines, watchErrors } from './split-view-stubs'

/**
 * S4 历史时刻分叉 e2e(T13,AC8)。
 * 范围:2026-09-19 08:00 ~ 12:00(NOW);所选 09:30 由服务端吸附到 09:00。
 */

const MAIN_AND_FORK = stubTimelines.slice(0, 2)
const EARLIEST = '2026-09-19T08:00:00.000Z'
const SNAPPED = '2026-09-19T09:00:00.000Z'

const SCENARIO = {
  whatIf: '如果那封信在暴雨前送达',
  changedVariable: '信件是否送达',
  participants: ['小夜'],
  invariants: ['分叉前的共同历史不变'],
}

interface Stubs {
  checkBodies: () => { at?: string }[]
  previewBodies: () => { whatIf?: string; startTime?: string }[]
  forkBodies: () => { scenario?: Record<string, unknown> }[]
}

async function stubHistoryApis(page: Page, opts: { checkOk?: boolean } = {}): Promise<Stubs> {
  const checks: { at?: string }[] = []
  const previews: { whatIf?: string; startTime?: string }[] = []
  const forks: { scenario?: Record<string, unknown> }[] = []
  // 后注册的路由优先于 stubSplitApis 的默认「无历史」
  await page.route('**/api/worlds/world-1/timelines/*/history', (route) =>
    route.fulfill({ json: { earliest: EARLIEST, simNow: NOW } }))
  await page.route('**/api/worlds/world-1/timelines/*/history/check', (route) => {
    checks.push(route.request().postDataJSON() as { at?: string })
    if (opts.checkOk === false) {
      return route.fulfill({ status: 409, json: { error: '该时刻的历史证据不完整，无法完整重建', reasonCode: 'baseline_incomplete' } })
    }
    return route.fulfill({ json: { ok: true, effectiveMoment: SNAPPED } })
  })
  await page.route('**/api/worlds/world-1/timelines/*/fork/preview', (route) => {
    const body = route.request().postDataJSON() as { whatIf?: string; startTime?: string }
    previews.push(body)
    return route.fulfill({ json: { ...SCENARIO, startTime: body.startTime ?? NOW } })
  })
  await page.route('**/api/worlds/world-1/timelines/*/fork', (route) => {
    forks.push(route.request().postDataJSON() as { scenario?: Record<string, unknown> })
    return route.fulfill({ json: { id: 'timeline-fork', simNow: SNAPPED } })
  })
  return { checkBodies: () => checks, previewBodies: () => previews, forkBodies: () => forks }
}

async function openForkDialog(page: Page) {
  await page.goto('/worlds/world-1?view=text&timeline=timeline-main')
  // 文字视图秒级时钟高频重渲染,按钮易被重建;dispatchEvent 绕过可动性检查
  await page.getByRole('button', { name: /主宇宙 ▾|平行宇宙 ▾/ }).dispatchEvent('click')
  await page.getByTestId('fork-entry').dispatchEvent('click')
  await expect(page.getByRole('dialog', { name: '创建平行宇宙' })).toBeVisible()
}

test.describe('S4 历史时刻分叉', () => {
  test('选过去时刻 → 吸附显示 → 预览确认 → fork 携带有效时刻 → 落点分屏', async ({ page }) => {
    const errors = watchErrors(page)
    await stubSplitApis(page, { timelines: MAIN_AND_FORK })
    const stubs = await stubHistoryApis(page)
    await openForkDialog(page)

    const dialog = page.getByRole('dialog', { name: '创建平行宇宙' })
    // 范围加载:默认当前时刻,可展开过去时刻(区间由范围查询驱动)
    await expect(dialog.getByTestId('fork-moment')).toBeVisible()
    await expect(dialog.getByTestId('fork-moment-current')).toBeChecked()
    await dialog.getByTestId('fork-moment-custom').click()
    const input = dialog.getByTestId('fork-moment-input')
    await expect(input).toBeVisible()
    await expect(dialog.getByText('可回溯 2026-09-19 08:00 ～ 2026-09-19 12:00')).toBeVisible()

    // 失焦触发 check:请求携带所选时刻(UTC 墙钟),吸附结果显示
    await input.fill('2026-09-19T09:30')
    await dialog.locator('textarea').click()
    await expect(dialog.getByTestId('fork-moment-effective')).toContainText('2026-09-19 09:00')
    expect(stubs.checkBodies()).toEqual([{ at: '2026-09-19T09:30:00.000Z' }])

    // 预览携带吸附后的时刻;确认卡显示历史起始时刻
    await dialog.locator('textarea').fill(SCENARIO.whatIf)
    await dialog.getByTestId('fork-preview-submit').click()
    await expect(dialog.getByText('起始时刻在确认后不可更改')).toBeVisible()
    expect(stubs.previewBodies()).toEqual([{ whatIf: SCENARIO.whatIf, startTime: SNAPPED }])

    // fork 请求 startTime=有效时刻
    await dialog.getByTestId('fork-confirm').click()
    expect(stubs.forkBodies()).toHaveLength(1)
    expect(stubs.forkBodies()[0]?.scenario?.startTime).toBe(SNAPPED)

    // 落点并排比较:横幅 → 分屏左源右新
    await expect(page.getByTestId('fork-compare-hint')).toBeVisible()
    await page.getByTestId('fork-compare-hint-go').dispatchEvent('click')
    await expect(page).toHaveURL(/mode=possibility/)
    await expect(page).toHaveURL(/timeline=timeline-main/)
    await expect(page).toHaveURL(/right=timeline-fork/)
    await expect(page.getByTestId('split-left')).toBeVisible({ timeout: 30000 })
    expect(errors).toEqual([])
  })

  test('不可重建时刻:原因展示,预览与分叉均不发生', async ({ page }) => {
    // 预期的 409 会打一条 "Failed to load resource" console error,本地收集并滤掉
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) errors.push(msg.text())
    })
    page.on('pageerror', (err) => errors.push(String(err)))
    await stubSplitApis(page, { timelines: MAIN_AND_FORK })
    const stubs = await stubHistoryApis(page, { checkOk: false })
    await openForkDialog(page)

    const dialog = page.getByRole('dialog', { name: '创建平行宇宙' })
    await expect(dialog.getByTestId('fork-moment')).toBeVisible()
    await dialog.getByTestId('fork-moment-custom').click()
    await dialog.getByTestId('fork-moment-input').fill('2026-09-19T09:30')
    await dialog.locator('textarea').click()
    await expect(dialog.getByTestId('fork-moment-error')).toContainText('历史证据不完整')
    expect(stubs.checkBodies()).toEqual([{ at: '2026-09-19T09:30:00.000Z' }])

    // 带着失败时刻提交预览:原地展示原因,不消耗预览、不分叉
    await dialog.locator('textarea').fill(SCENARIO.whatIf)
    await dialog.getByTestId('fork-preview-submit').click()
    await expect(dialog.getByTestId('fork-moment-error')).toContainText('历史证据不完整')
    expect(stubs.previewBodies()).toEqual([])
    expect(stubs.forkBodies()).toEqual([])
    expect(errors).toEqual([])
  })
})
