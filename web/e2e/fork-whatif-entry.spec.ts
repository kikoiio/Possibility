import { expect, test, type Page } from '@playwright/test'
import { NOW, stubSplitApis, stubTimelines, watchErrors } from './split-view-stubs'

/**
 * S2 「如果……」干预入口 e2e(T13,AC1/AC2/AC4/AC5/F6 落点)。
 * 预览与 fork 走 route stub;分屏断言复用 S1 testid。
 */

// 分叉成功后可分屏:主线 + 新分叉线
const MAIN_AND_FORK = stubTimelines.slice(0, 2)

const SCENARIO = {
  whatIf: '如果那封信在暴雨前送达',
  startTime: NOW,
  changedVariable: '信件是否送达',
  participants: ['小夜'],
  invariants: ['分叉前的共同历史不变'],
}

async function stubForkApis(page: Page, opts: { onPreview?: () => void; onFork?: (body: unknown) => void } = {}) {
  await page.route('**/api/worlds/world-1/timelines/*/fork/preview', (route) => {
    opts.onPreview?.()
    return route.fulfill({ json: SCENARIO })
  })
  await page.route('**/api/worlds/world-1/timelines/*/fork', (route) => {
    opts.onFork?.(route.request().postDataJSON())
    return route.fulfill({ json: { id: 'timeline-fork', simNow: NOW } })
  })
}

async function openForkDialog(page: Page) {
  await page.goto('/worlds/world-1?view=text&timeline=timeline-main')
  // 文字视图秒级时钟高频重渲染,按钮易被重建;dispatchEvent 绕过可动性检查
  await page.getByRole('button', { name: /主宇宙 ▾|平行宇宙 ▾/ }).dispatchEvent('click')
  await page.getByTestId('fork-entry').dispatchEvent('click')
  await expect(page.getByRole('dialog', { name: '创建平行宇宙' })).toBeVisible()
}

test.describe('S2 一句话分叉入口', () => {
  test('世界级主流程:一句话 → 预览确认卡(startTime 只读) → 分叉 → 横幅 → 分屏', async ({ page }) => {
    const errors = watchErrors(page)
    await stubSplitApis(page, { timelines: MAIN_AND_FORK })
    let forkBody: { scenario?: Record<string, unknown> } | null = null
    await stubForkApis(page, { onFork: (body) => { forkBody = body as typeof forkBody } })
    await openForkDialog(page)

    const dialog = page.getByRole('dialog', { name: '创建平行宇宙' })
    // 默认一句话模式(AC1):textarea + 生成按钮 + 高级链接
    await expect(dialog.locator('textarea')).toBeVisible()
    await expect(dialog.getByTestId('fork-preview-submit')).toBeVisible()
    await expect(dialog.getByRole('button', { name: '高级：手动设定条件' })).toBeVisible()

    await dialog.locator('textarea').fill(SCENARIO.whatIf)
    await dialog.getByTestId('fork-preview-submit').click()

    // 确认卡(AC2):startTime 无编辑控件,其余字段可编辑
    await expect(dialog.getByText('分叉只能从当前时刻开始')).toBeVisible()
    expect(await dialog.locator('input[type="datetime-local"]').count()).toBe(0)
    // 微调 participants(确认卡内唯一的 input)
    await dialog.locator('input').fill('小夜，阿澄')

    await dialog.getByTestId('fork-confirm').click()
    // 分叉请求带上五字段(AC3 前端半)
    expect(forkBody?.scenario?.whatIf).toBe(SCENARIO.whatIf)
    expect(forkBody?.scenario?.changedVariable).toBe('信件是否送达')
    expect(forkBody?.scenario?.participants).toEqual(['小夜', '阿澄'])
    expect(forkBody?.scenario?.invariants).toEqual(['分叉前的共同历史不变'])

    // 落点(AC5):横幅出现,点击进分屏左源右新
    await expect(page.getByTestId('fork-compare-hint')).toBeVisible()
    await page.getByTestId('fork-compare-hint-go').dispatchEvent('click')
    await expect(page).toHaveURL(/mode=possibility/)
    await expect(page).toHaveURL(/timeline=timeline-main/)
    await expect(page).toHaveURL(/right=timeline-fork/)
    await expect(page.getByTestId('split-left')).toBeVisible({ timeout: 30000 })
    expect(errors).toEqual([])
  })

  test('高级路径:两字段直分叉,不消耗预览(AC4)', async ({ page }) => {
    const errors = watchErrors(page)
    await stubSplitApis(page, { timelines: MAIN_AND_FORK })
    let previewCalls = 0
    let forkCalled = false
    await stubForkApis(page, { onPreview: () => { previewCalls += 1 }, onFork: () => { forkCalled = true } })
    await openForkDialog(page)

    const dialog = page.getByRole('dialog', { name: '创建平行宇宙' })
    await dialog.getByRole('button', { name: '高级：手动设定条件' }).click()
    await dialog.locator('textarea').fill('手动假设')
    await dialog.locator('#fork-changed-variable').fill('手动条件')
    await dialog.getByRole('button', { name: '记录条件并分叉' }).click()

    await expect(page.getByTestId('fork-compare-hint')).toBeVisible()
    expect(forkCalled).toBe(true)
    expect(previewCalls).toBe(0)
    expect(errors).toEqual([])
  })

  test('forkFrom 落点(人物级统一):体素页横幅出现,关闭后消失且抹参(F6)', async ({ page }) => {
    const errors = watchErrors(page)
    await stubSplitApis(page, { timelines: MAIN_AND_FORK })
    await page.goto('/worlds/world-1?timeline=timeline-fork&forkFrom=timeline-main')
    await expect(page.getByTestId('fork-compare-hint')).toBeVisible({ timeout: 30000 })
    await page.getByTestId('fork-compare-hint-dismiss').click()
    await expect(page.getByTestId('fork-compare-hint')).toHaveCount(0)
    await expect(page).not.toHaveURL(/forkFrom/)
    expect(errors).toEqual([])
  })

  test('窄屏:横幅不渲染,页面本身正常(AC5 降级)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    const errors = watchErrors(page)
    await stubSplitApis(page, { timelines: MAIN_AND_FORK })
    await page.goto('/worlds/world-1?timeline=timeline-fork&forkFrom=timeline-main')
    await expect(page.getByTestId('world-canvas-page')).toBeVisible({ timeout: 30000 })
    await expect(page.getByTestId('fork-compare-hint')).toBeHidden()
    expect(errors).toEqual([])
  })
})
