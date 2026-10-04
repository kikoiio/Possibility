import { expect, test, type Page } from '@playwright/test'
import { comparisonFor, NOW, snapshotFor, stubSplitApis, stubTimelines, voxelDocument, type StubTimeline } from './split-view-stubs'

const draft = {
  name: '建议分支', whatIf: '如果那封信提前到达', changedVariable: '送达时间', startTime: NOW,
  participants: ['小夜'], invariants: ['共同过去保持不变'], sourceVersion: 1,
  actionProposal: { type: 'environment', location: '主楼', condition: 'weather', value: '晴朗' },
  sourceCandidates: [], actionTargets: { residents: [{ id: 'person-1', name: '小夜' }], locations: ['主楼'] },
}

async function fixture(page: Page, options: { failCreate?: boolean; failRefresh?: boolean; alignment?: 'same_sim_time' | 'different_sim_times' } = {}) {
  const state = { requests: [] as Record<string, unknown>[], created: false, failRefresh: !!options.failRefresh, failSwitch: false, compares: [] as [string, string][] }
  const initial = stubTimelines.slice(0, 2)
  const currentList = () => state.created
    ? [{ ...stubTimelines[1], id: 'new-fork', forkScenario: { ...draft, name: '准时的信', whatIf: '如果信准时送达', changedVariable: '信件送达时刻' } }, ...initial] as StubTimeline[]
    : initial
  await stubSplitApis(page, { timelines: initial })
  await page.route('**/api/worlds/world-1/map/bootstrap**', route => {
    const id = new URL(route.request().url()).searchParams.get('timelineId') ?? 'timeline-main'
    if ((state.created && state.failRefresh) || (state.failSwitch && id === 'timeline-fork')) return route.fulfill({ status: 503, json: { error: '时间线暂不可用，请重试' } })
    const snapshot = snapshotFor(id, currentList())
    return route.fulfill({ json: { access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false }, world: snapshot, scene: { status: 'ready', document: voxelDocument }, presentation: { timelineId: id, stateVersion: 1, simNow: NOW, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] }, theme: { id: 'mist-manor', assetVersion: 'e2e' }, resume: { worldId: 'world-1', timelineId: id, spaceId: 'exterior', mode: 'life', updatedAt: NOW } } })
  })
  await page.route('**/api/worlds/world-1?*', route => {
    if (state.created && state.failRefresh) return route.fulfill({ status: 503, json: { error: '列表暂不可用' } })
    return route.fulfill({ json: snapshotFor(new URL(route.request().url()).searchParams.get('timelineId') ?? 'timeline-main', currentList()) })
  })
  await page.route('**/api/worlds/world-1/timelines/*/fork/preview', route => route.fulfill({ json: draft }))
  await page.route('**/api/worlds/world-1/timelines/*/fork', async route => {
    const input = route.request().postDataJSON()
    state.requests.push(input)
    if (options.failCreate) return route.fulfill({ status: 503, json: { error: '创建暂不可用，稍后重试' } })
    state.created = true
    return route.fulfill({ json: { id: 'new-fork', sourceTimelineId: 'timeline-main', simNow: NOW, name: input.scenario.name, whatIf: input.scenario.whatIf } })
  })
  await page.route('**/api/worlds/world-1/compare?*', route => {
    const url = new URL(route.request().url())
    const left = url.searchParams.get('left')!; const right = url.searchParams.get('right')!
    state.compares.push([left, right])
    return route.fulfill({ json: { ...comparisonFor(left, right), timeAlignment: options.alignment ?? 'same_sim_time', sharedForkOrigin: null } })
  })
  await page.goto('/worlds/world-1?timeline=timeline-main')
  await expect(page.getByTestId('world-canvas-page')).toBeVisible()
  return state
}

async function confirmCard(page: Page) {
  await page.getByRole('button', { name: '主宇宙 ▾' }).dispatchEvent('click')
  await page.getByTestId('fork-entry').dispatchEvent('click')
  const dialog = page.getByRole('dialog', { name: '创建平行宇宙' })
  await dialog.getByLabel('这条线要探索什么可能？').fill(draft.whatIf)
  await dialog.getByTestId('fork-preview-submit').click()
  await dialog.getByLabel('分支名称').fill('准时的信')
  await dialog.getByLabel('What-if').fill('如果信准时送达')
  await dialog.getByLabel('场景中的改变描述').fill('信件送达时刻')
  return dialog
}

test('编辑后仅创建一次，精确来源/新分支比较不受列表排序和已有分支影响', async ({ page }) => {
  const state = await fixture(page)
  const dialog = await confirmCard(page)
  await dialog.getByTestId('fork-confirm').dispatchEvent('click')
  await dialog.getByTestId('fork-confirm').dispatchEvent('click').catch(() => {})
  await expect(page.getByTestId('fork-compare-hint')).toContainText('准时的信')
  await expect(page.getByTestId('fork-compare-hint')).toContainText('如果信准时送达')
  expect(state.requests).toHaveLength(1)
  expect(state.requests[0].scenario).toMatchObject({ name: '准时的信', whatIf: '如果信准时送达', changedVariable: '信件送达时刻' })
  await page.getByTestId('fork-compare-hint-go').click()
  await expect(page.getByLabel('左侧')).toHaveValue('timeline-main')
  await expect(page.getByLabel('右侧')).toHaveValue('new-fork')
  await expect(page.getByText('两线已对齐到相同世界时间。')).toBeVisible()
  expect(state.compares.at(-1)).toEqual(['timeline-main', 'new-fork'])
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: /准时的信 ▾|主宇宙 ▾/ }).dispatchEvent('click')
  await page.getByRole('button', { name: /主宇宙.*2026/ }).first().click()
  await expect(page.getByRole('button', { name: '主宇宙 ▾' })).toBeVisible()
})

test('无效输入与取消均无创建请求', async ({ page }) => {
  const state = await fixture(page)
  const dialog = await confirmCard(page)
  await dialog.getByLabel('分支名称').fill(' ')
  await dialog.getByTestId('fork-confirm').click()
  await expect(dialog.getByRole('alert')).toContainText('分支名称')
  expect(state.requests).toHaveLength(0)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(state.requests).toHaveLength(0)
})

test('创建失败保留全部编辑输入及原时间线，可明确重试', async ({ page }) => {
  const state = await fixture(page, { failCreate: true })
  const dialog = await confirmCard(page)
  await dialog.getByTestId('fork-confirm').click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(dialog.getByLabel('分支名称')).toHaveValue('准时的信')
  await expect(dialog.getByLabel('What-if')).toHaveValue('如果信准时送达')
  await expect(dialog.getByLabel('场景中的改变描述')).toHaveValue('信件送达时刻')
  await expect(page).toHaveURL(/timeline=timeline-main/)
  expect(state.requests).toHaveLength(1)
  expect(state.compares).toHaveLength(0)
})

test('创建成功但列表刷新失败保留摘要，重试后精确比较且尊重未对齐状态', async ({ page }) => {
  const state = await fixture(page, { failRefresh: true, alignment: 'different_sim_times' })
  const dialog = await confirmCard(page)
  await dialog.getByTestId('fork-confirm').click()
  const hint = page.getByTestId('fork-compare-hint')
  await expect(hint).toContainText('准时的信')
  await expect(hint.getByRole('button', { name: '重试刷新时间线' })).toBeVisible()
  expect(state.compares).toHaveLength(0)
  state.failRefresh = false
  await hint.getByRole('button', { name: '重试刷新时间线' }).click()
  await hint.getByTestId('fork-compare-hint-go').click()
  await expect(page.getByLabel('左侧')).toHaveValue('timeline-main')
  await expect(page.getByLabel('右侧')).toHaveValue('new-fork')
  await expect(page.getByText(/两线世界时间尚未对齐/)).toBeVisible()
  expect(state.requests).toHaveLength(1)
})

test('旧分支使用假设可读标签，切换失败保留原线及待重试选择', async ({ page }) => {
  const state = await fixture(page)
  state.failSwitch = true
  await page.getByRole('button', { name: '主宇宙 ▾' }).dispatchEvent('click')
  await expect(page.getByText(/当前时间和居民数量属于所选时间线/)).toBeVisible()
  await page.getByRole('button', { name: /那封信准时送达.*2026/ }).click()
  await expect(page.getByRole('button', { name: '重试切换' })).toBeVisible()
  await expect(page).toHaveURL(/timeline=timeline-main/)
  state.failSwitch = false
  await page.getByRole('button', { name: '重试切换' }).click()
  await expect(page.getByRole('button', { name: '那封信准时送达 ▾' })).toBeVisible()
})

test('访客移动端：编辑确认、取消与失败保留、刷新恢复及精确比较', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const state = { requests: [] as Record<string, unknown>[], failCreate: true, failRefresh: false, created: false, compared: [] as [string, string][] }
  await page.route('**/api/demo/session', route => route.fulfill({ json: { token: 'guest-s4c', sessionId: 'guest-session', worldId: 'world-1', timelineId: 'timeline-main', generation: 1, expiresAt: '2099-01-01T00:00:00Z' } }))
  await page.route('**/api/worlds/world-1/map/resume', route => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/worlds/world-1/map/bootstrap**', route => {
    if (state.created && state.failRefresh) return route.fulfill({ status: 503, json: { error: '列表刷新失败' } })
    const id = new URL(route.request().url()).searchParams.get('timelineId') ?? 'timeline-main'
    const list = state.created ? [stubTimelines[0], { ...stubTimelines[1], id: 'guest-new', forkScenario: { ...draft, name: '访客的信', whatIf: '访客假设' } }] : [stubTimelines[0]]
    const base = snapshotFor(id, list)
    const world = { ...base, world: { ...base.world, isDemo: true } }
    return route.fulfill({ json: { access: { observe: true, participate: true, editScene: false, fork: true, compare: true, persist: false, resetDemo: true }, world, scene: { status: 'ready', document: { format: 'voxel-spaces', version: 1, defaultSpaceId: 'exterior', spaces: [{ id: 'exterior', name: '外景', document: voxelDocument }] } }, presentation: { timelineId: id, stateVersion: 1, simNow: NOW, timeOfDay: 'day', weather: { kind: null, label: null }, residents: [], locations: [], signals: [] }, theme: { id: 'mist-manor', assetVersion: 'fixture' }, resume: { worldId: 'world-1', timelineId: id, spaceId: 'exterior', mode: 'life', updatedAt: NOW } } })
  })
  await page.route('**/api/demo/worlds/world-1/fork', route => {
    const body = route.request().postDataJSON(); state.requests.push(body)
    if (state.failCreate) return route.fulfill({ status: 503, json: { error: '创建暂不可用' } })
    state.created = true
    return route.fulfill({ json: { id: 'guest-new', sourceTimelineId: body.timelineId, simNow: NOW, name: body.name, whatIf: body.whatIf } })
  })
  await page.route('**/api/demo/worlds/world-1/compare?*', route => {
    const url = new URL(route.request().url()); const left = url.searchParams.get('left')!; const right = url.searchParams.get('right')!
    state.compared.push([left, right])
    return route.fulfill({ json: { ...comparisonFor(left, right), timeAlignment: 'different_sim_times', sharedForkOrigin: null } })
  })
  await page.route('**/voxel-assets/**', route => route.fulfill({ status: 404, body: 'not found' }))
  await page.goto('/')
  await expect(page.getByTestId('guest-world-map')).toBeVisible()
  await page.getByRole('button', { name: '关闭导览' }).click()
  await page.getByRole('button', { name: '可能', exact: true }).click()
  await page.getByRole('button', { name: '创建并对照' }).click()
  let dialog = page.getByRole('dialog', { name: '确认平行宇宙' })
  await dialog.getByRole('button', { name: '取消' }).click()
  expect(state.requests).toHaveLength(0)
  await page.getByRole('button', { name: '创建并对照' }).click()
  dialog = page.getByRole('dialog', { name: '确认平行宇宙' })
  await dialog.getByLabel('分支名称').fill('访客的信')
  await dialog.getByLabel('What-if').fill('访客假设')
  await dialog.getByLabel('场景中的改变描述').fill('信件送达')
  await dialog.getByTestId('guest-fork-confirm').click()
  await expect(page.getByText('创建暂不可用')).toBeVisible()
  await expect(dialog.getByLabel('分支名称')).toHaveValue('访客的信')
  await expect(dialog.getByLabel('What-if')).toHaveValue('访客假设')
  state.failCreate = false; state.failRefresh = true
  await dialog.getByTestId('guest-fork-confirm').click()
  await expect(page.getByTestId('guest-fork-summary')).toContainText('访客的信')
  await expect(page.getByTestId('guest-fork-summary')).toContainText('访客假设')
  await expect(page.getByRole('button', { name: '直接比较来源与新分支' })).toBeDisabled()
  expect(state.compared).toHaveLength(0)
  state.failRefresh = false
  await page.getByRole('button', { name: '重试刷新时间线' }).click()
  await page.getByRole('button', { name: '直接比较来源与新分支' }).click()
  await expect(page.getByLabel('左侧')).toHaveValue('timeline-main')
  await expect(page.getByLabel('右侧')).toHaveValue('guest-new')
  await expect(page.getByText(/两线世界时间尚未对齐/)).toBeVisible()
  expect(state.compared.at(-1)).toEqual(['timeline-main', 'guest-new'])
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  expect(state.requests).toHaveLength(2)
  expect(state.requests[0].requestId).toBe(state.requests[1].requestId)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})
