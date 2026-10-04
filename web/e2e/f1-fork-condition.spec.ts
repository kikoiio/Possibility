import { expect, test, type Page } from '@playwright/test'
import { NOW, stubSplitApis, stubTimelines } from './split-view-stubs'

const scenario = {
  name: '图书馆约见',
  whatIf: '如果居民收到新的集合消息',
  startTime: NOW,
  changedVariable: '居民是否收到消息',
  participants: ['小夜'],
  invariants: ['分叉前的共同历史不变'],
  sourceVersion: 7,
  actionProposal: { type: 'inform', recipientId: 'person-1', topic: '预览主题', content: '预览内容' },
  sourceCandidates: [{ id: 'fact-known', factType: 'environment', certainty: 'fact', simTime: NOW, label: '主楼·天气' }],
  actionTargets: { residents: [{ id: 'person-1', name: '小夜' }], locations: ['主楼'] },
}

async function openFork(page: Page) {
  await page.goto('/worlds/world-1?timeline=timeline-main')
  await page.getByRole('button', { name: /主宇宙 ▾/ }).dispatchEvent('click')
  await page.getByTestId('fork-entry').dispatchEvent('click')
  const dialog = page.getByRole('dialog', { name: '创建平行宇宙' })
  await dialog.getByLabel('这条线要探索什么可能？').fill(scenario.whatIf)
  await dialog.getByTestId('fork-preview-submit').click()
  await expect(dialog.getByTestId('fork-initial-action')).toBeVisible()
  return dialog
}

test('F1 登录用户消息动作：编辑、选择来源、失败保留、重试成功并显示回执', async ({ page }) => {
  await stubSplitApis(page, { timelines: stubTimelines.slice(0, 2) })
  let previewCalls = 0
  const forkRequests: Record<string, unknown>[] = []
  let failOnce = true
  await page.route('**/api/worlds/world-1/timelines/*/fork/preview', route => {
    previewCalls += 1
    return route.fulfill({ json: scenario })
  })
  await page.route('**/api/worlds/world-1/timelines/*/fork', route => {
    forkRequests.push(route.request().postDataJSON() as Record<string, unknown>)
    if (failOnce) {
      failOnce = false
      return route.fulfill({ status: 409, json: { error: '源状态已变化，请重新预览' } })
    }
    return route.fulfill({ json: {
      id: 'timeline-fork', sourceTimelineId: 'timeline-main', simNow: NOW,
      name: scenario.name, whatIf: scenario.whatIf,
      action: { commandId: 'fork:timeline-fork:initial', factId: 'fact-new', version: 1, summary: '已向指定居民传递消息' },
    } })
  })

  const dialog = await openFork(page)
  await dialog.getByLabel('消息主题').fill('暴雨前在主楼集合')
  await dialog.getByLabel('消息内容').fill('明早八点到主楼，我会带来门钥匙。')
  await dialog.getByLabel('消息来源').selectOption('fact-known')
  const confirm = dialog.getByTestId('fork-confirm')
  await confirm.click()

  await expect(dialog.getByRole('alert')).toContainText('源状态已变化')
  await expect(dialog.getByLabel('消息主题')).toHaveValue('暴雨前在主楼集合')
  await expect(dialog.getByLabel('消息内容')).toHaveValue('明早八点到主楼，我会带来门钥匙。')
  await expect(dialog.getByLabel('消息来源')).toHaveValue('fact-known')
  expect(forkRequests).toHaveLength(1)

  await confirm.click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('fork-action-summary')).toContainText('已向指定居民传递消息')
  expect(previewCalls).toBe(1)
  expect(forkRequests).toHaveLength(2)
  expect(forkRequests[0]).toMatchObject({
    expectedSourceVersion: 7,
    initialAction: {
      type: 'inform', recipientId: 'person-1', topic: '暴雨前在主楼集合',
      content: '明早八点到主楼，我会带来门钥匙。', sourceFactId: 'fact-known',
    },
  })
  expect(forkRequests[1].requestId).toBe(forkRequests[0].requestId)
  expect(forkRequests[1].initialAction).toEqual(forkRequests[0].initialAction)
})

test('F1 没有可执行动作建议时禁止确认创建', async ({ page }) => {
  await stubSplitApis(page, { timelines: stubTimelines.slice(0, 2) })
  let createCalls = 0
  await page.route('**/api/worlds/world-1/timelines/*/fork/preview', route =>
    route.fulfill({ json: { ...scenario, actionProposal: null } }))
  await page.route('**/api/worlds/world-1/timelines/*/fork', route => {
    createCalls += 1
    return route.fulfill({ status: 500, json: { error: '不应提交' } })
  })

  const dialog = await openFork(page)
  await expect(dialog.getByTestId('fork-action-unsupported')).toContainText('无法映射')
  await expect(dialog.getByTestId('fork-confirm')).toBeDisabled()
  expect(createCalls).toBe(0)
})
