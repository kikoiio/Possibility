import { expect, test, type Page } from '@playwright/test'
import { watchErrors } from './split-view-stubs'

function watchExpectedSettingsFailures(page: Page, allowed: { path: string; status: number }[]) {
  const errors: string[] = []
  const expectedFailures: string[] = []
  page.on('console', message => {
    if (message.type() !== 'error') return
    const text = message.text()
    const url = message.location().url
    const expected = allowed.find(({ path, status }) => url.endsWith(path)
      && text === `Failed to load resource: the server responded with a status of ${status} (${status === 409 ? 'Conflict' : 'Bad Request'})`)
    if (expected) { expectedFailures.push(`${expected.path}:${expected.status}`); return }
    errors.push(text)
  })
  page.on('pageerror', error => errors.push(String(error)))
  return { errors, expectedFailures }
}

type Verification = { status: 'incomplete' | 'unverified' | 'verified'; verifiedAt: string | null }
async function settingsFixture(page: Page) {
  const state = {
    baseUrl: null as string | null, model: null as string | null, key: '',
    verification: { status: 'incomplete', verifiedAt: null } as Verification,
    dailyCallCap: 400 as number | null, usedToday: 0, fallbackUsedToday: 0,
    requests: [] as string[], providerCalls: 0, receipts: 0, failSave: false, failTest: false,
  }
  const publicConfig = () => ({ baseUrl: state.baseUrl, model: state.model, hasKey: Boolean(state.key),
    keyPreview: state.key ? `…${state.key.slice(-4)}` : null, verification: state.verification })
  const publicBudget = () => ({ dailyCallCap: state.dailyCallCap, usedToday: state.usedToday,
    fallbackUsedToday: state.fallbackUsedToday, unlimitedEligible: state.verification.status === 'verified' })
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/api/settings/llm', async route => {
    const method = route.request().method()
    state.requests.push(`${method} llm`)
    if (method === 'GET') return route.fulfill({ json: publicConfig() })
    if (method === 'DELETE') {
      state.baseUrl = null; state.model = null; state.key = ''
      state.verification = { status: 'incomplete', verifiedAt: null }; state.dailyCallCap = 400
      return route.fulfill({ json: { ok: true } })
    }
    if (state.failSave) return route.fulfill({ status: 400, json: { error: '端点保存失败' } })
    const patch = route.request().postDataJSON() as { baseUrl: string | null; model: string | null; apiKey?: string }
    const changed = state.baseUrl !== patch.baseUrl || state.model !== patch.model || Boolean(patch.apiKey && patch.apiKey !== state.key)
    state.baseUrl = patch.baseUrl; state.model = patch.model
    if (patch.apiKey !== undefined) state.key = patch.apiKey
    if (changed) state.verification = { status: state.baseUrl && state.model && state.key ? 'unverified' : 'incomplete', verifiedAt: null }
    return route.fulfill({ json: publicConfig() })
  })
  await page.route('**/api/settings/llm/test', async route => {
    state.requests.push('POST test')
    expect(route.request().postData()).toBeNull()
    expect(state.baseUrl && state.model && state.key).toBeTruthy()
    state.providerCalls++; state.receipts++; state.usedToday++
    if (state.failTest) {
      state.verification = { status: 'unverified', verifiedAt: null }
      return route.fulfill({ status: 400, json: { ok: false, kind: 'authentication', error: '认证失败，请检查 API Key' } })
    }
    state.verification = { status: 'verified', verifiedAt: '2026-10-03T09:00:00.000Z' }
    return route.fulfill({ json: { ok: true, verifiedAt: state.verification.verifiedAt } })
  })
  await page.route('**/api/settings/budget', async route => {
    const method = route.request().method()
    if (method === 'GET') return route.fulfill({ json: publicBudget() })
    const { dailyCallCap } = route.request().postDataJSON() as { dailyCallCap: number | null }
    if (dailyCallCap === null && state.verification.status !== 'verified') {
      return route.fulfill({ status: 409, json: { error: '启用不限前，请通过连接测试' } })
    }
    state.dailyCallCap = dailyCallCap
    return route.fulfill({ json: publicBudget() })
  })
  return state
}

test('S4A 自定义恢复、手填模型保留、草稿保存不持久化 Key', async ({ page }) => {
  const errors = watchErrors(page)
  await settingsFixture(page)
  await page.goto('/settings')
  await expect(page.getByTestId('llm-verification')).toContainText('不完整')
  await page.getByTestId('llm-preset-openai').click()
  await page.getByTestId('llm-preset-custom').click()
  await expect(page.getByTestId('llm-baseurl')).toHaveValue('')
  await expect(page.getByTestId('llm-model')).toHaveValue('')
  await page.getByTestId('llm-baseurl').fill('https://my-provider.example/v1')
  await page.getByTestId('llm-model').fill('my-model')
  await page.getByTestId('llm-save').click()
  await expect(page.getByTestId('llm-msg')).toContainText('已保存但未验证')
  await page.getByTestId('llm-preset-openai').click()
  await page.getByTestId('llm-preset-custom').click()
  await expect(page.getByTestId('llm-baseurl')).toHaveValue('https://my-provider.example/v1')
  await expect(page.getByTestId('llm-model')).toHaveValue('my-model')
  // Manually entering a suggested model still counts as a user choice.
  await page.getByTestId('llm-preset-openai').click()
  await page.getByTestId('llm-model').fill('gpt-5')
  await page.getByTestId('llm-apikey').fill('sk-persist-canary-7654')
  await page.getByTestId('llm-preset-deepseek').click()
  await expect(page.getByTestId('llm-model')).toHaveValue('gpt-5')
  await expect(page.getByTestId('llm-apikey')).toHaveValue('sk-persist-canary-7654')
  await page.getByTestId('llm-save').click()
  await expect(page.getByTestId('llm-msg')).toContainText('未验证')
  await page.reload()
  await expect(page.getByTestId('llm-apikey')).toHaveValue('')
  await page.getByTestId('llm-preset-custom').click()
  await expect(page.getByTestId('llm-baseurl')).toHaveValue('https://my-provider.example/v1')
  await expect(page.getByTestId('llm-model')).toHaveValue('my-model')
  expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain('sk-persist-canary-7654')
  expect(errors).toEqual([])
})

test('S4A 保存后单次连接测试、资格失效与删除预算反馈', async ({ page }) => {
  const { errors, expectedFailures } = watchExpectedSettingsFailures(page, [
    { path: '/api/settings/budget', status: 409 }, { path: '/api/settings/llm/test', status: 400 },
  ])
  const state = await settingsFixture(page)
  await page.goto('/settings')
  await expect(page.getByTestId('llm-verification')).toContainText('不完整')
  await page.getByTestId('budget-unlimited').check()
  await page.getByTestId('budget-save').click()
  await expect(page.getByTestId('budget-msg')).toContainText('通过连接测试')
  await page.getByTestId('llm-baseurl').fill('https://my-provider.example/v1')
  await page.getByTestId('llm-model').fill('my-model')
  await page.getByTestId('llm-apikey').fill('sk-e2e-canary-1234')
  await expect(page.getByText('连接测试会向提供方发送一次最小请求，可能产生费用。')).toBeVisible()
  const prior = state.requests.length
  await page.getByTestId('llm-test').click()
  await expect(page.getByTestId('llm-msg')).toContainText('连接成功')
  expect(state.requests.slice(prior).filter(x => x !== 'GET llm')).toEqual(['PUT llm', 'POST test'])
  expect(state.providerCalls).toBe(1); expect(state.receipts).toBe(1)
  await expect(page.getByTestId('llm-verification')).toContainText('已验证')
  await page.getByTestId('budget-unlimited').check()
  await page.getByTestId('budget-save').click()
  await expect(page.getByTestId('budget-usage')).toContainText('回退来源已用 0 / 400')
  await page.getByTestId('llm-model').fill('other-model')
  await expect(page.getByTestId('llm-verification')).toContainText('重新测试')
  await page.getByTestId('llm-save').click()
  await expect(page.getByTestId('budget-fallback')).toContainText('当前没有个人 Key 不限豁免')
  await page.getByTestId('budget-unlimited').check()
  await page.getByTestId('budget-save').click()
  await expect(page.getByTestId('budget-msg')).toContainText('通过连接测试')
  state.failTest = true
  await page.getByTestId('llm-test').click()
  await expect(page.getByTestId('llm-msg')).toContainText('认证失败')
  await expect(page.getByTestId('llm-verification')).toContainText('尚未验证')
  expect(state.providerCalls).toBe(2); expect(state.receipts).toBe(2)
  await page.getByTestId('llm-delete').click()
  await expect(page.getByTestId('budget-usage')).toContainText('/ 400')
  await expect(page.getByTestId('budget-unlimited')).not.toBeChecked()
  await expect(page.getByTestId('llm-msg')).toContainText('个人豁免已失效')
  expect(expectedFailures.sort()).toEqual(['/api/settings/budget:409', '/api/settings/budget:409', '/api/settings/llm/test:400'])
  expect(errors).toEqual([])
})

test('S4A 保存失败不发连接测试请求', async ({ page }) => {
  const { errors, expectedFailures } = watchExpectedSettingsFailures(page, [{ path: '/api/settings/llm', status: 400 }])
  const state = await settingsFixture(page)
  await page.goto('/settings')
  await expect(page.getByTestId('llm-verification')).toContainText('不完整')
  await page.getByTestId('llm-baseurl').fill('https://my-provider.example/v1')
  await page.getByTestId('llm-model').fill('my-model')
  await page.getByTestId('llm-apikey').fill('sk-unsaved')
  state.failSave = true
  await page.getByTestId('llm-test').click()
  await expect(page.getByTestId('llm-msg')).toContainText('端点保存失败')
  expect(state.providerCalls).toBe(0); expect(state.receipts).toBe(0)
  expect(state.requests).not.toContain('POST test')
  expect(expectedFailures).toEqual(['/api/settings/llm:400'])
  expect(errors).toEqual([])
})
