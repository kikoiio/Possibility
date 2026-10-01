import { expect, test, type Page } from '@playwright/test'
import { stubSplitApis, watchErrors } from './split-view-stubs'

/**
 * S3 BYOK 与全局预算 e2e(T15,AC5/AC8/AC9/AC10/AC14 的 web 半程)。
 * settings 端点走可变状态 stub;世界页复用 S1 stub。
 */

interface LlmStub { baseUrl: string | null; model: string | null; hasKey: boolean; keyPreview: string | null }

async function stubSettingsApis(page: Page, state: { llm: LlmStub; budget: { dailyCallCap: number | null; usedToday: number } }) {
  await page.route('**/api/settings/llm', (route) => {
    const method = route.request().method()
    if (method === 'GET') return route.fulfill({ json: state.llm })
    if (method === 'DELETE') {
      state.llm = { baseUrl: null, model: null, hasKey: false, keyPreview: null }
      return route.fulfill({ json: { ok: true } })
    }
    const body = route.request().postDataJSON() as { baseUrl?: string | null; model?: string | null; apiKey?: string }
    state.llm = {
      baseUrl: body.baseUrl === undefined ? state.llm.baseUrl : body.baseUrl,
      model: body.model === undefined ? state.llm.model : body.model,
      hasKey: body.apiKey ? true : state.llm.hasKey,
      keyPreview: body.apiKey ? `…${body.apiKey.slice(-4)}` : state.llm.keyPreview,
    }
    return route.fulfill({ json: state.llm })
  })
  await page.route('**/api/settings/budget', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: state.budget })
    const body = route.request().postDataJSON() as { dailyCallCap: number | null }
    state.budget.dailyCallCap = body.dailyCallCap
    return route.fulfill({ json: state.budget })
  })
}

test.describe('S3 设置页 BYOK(AC5/AC13 web 侧)', () => {
  test('配置 Key/模型/端点 → 掩码回显无明文 → 刷新仍掩码 → 删除回落', async ({ page }) => {
    const errors = watchErrors(page)
    const state = {
      llm: { baseUrl: null, model: null, hasKey: false, keyPreview: null } as LlmStub,
      budget: { dailyCallCap: 400 as number | null, usedToday: 12 },
    }
    await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
    await stubSettingsApis(page, state)

    await page.goto('/settings')
    await expect(page.getByTestId('llm-settings')).toBeVisible()
    await expect(page.getByTestId('budget-usage')).toContainText('今日已用 12 / 400')

    await page.getByTestId('llm-baseurl').fill('https://api.user-example.com/v1')
    await page.getByTestId('llm-model').fill('user-model')
    await page.getByTestId('llm-apikey').fill('sk-user-secret-1234')
    await page.getByTestId('llm-save').click()

    // 掩码回显:末 4 位可见,明文绝不出现在页面(AC13)
    await expect(page.getByText('当前 Key:…1234')).toBeVisible()
    expect(await page.getByText('sk-user-secret-1234').count()).toBe(0)
    expect(state.llm.hasKey).toBe(true)

    await page.reload()
    await expect(page.getByText('当前 Key:…1234')).toBeVisible()
    expect(await page.getByText('sk-user-secret-1234').count()).toBe(0)

    await page.getByTestId('llm-delete').click()
    await expect(page.getByText('已删除,LLM 调用回落平台配置')).toBeVisible()
    expect(errors).toEqual([])
  })
})

test.describe('S3 全局预算触顶与恢复(AC9/AC10)', () => {
  test('Home 横幅显示用量/原因 → 跳设置页 → 提额 → 保存反馈', async ({ page }) => {
    const errors = watchErrors(page)
    const state = {
      llm: { baseUrl: null, model: null, hasKey: false, keyPreview: null } as LlmStub,
      budget: { dailyCallCap: 400 as number | null, usedToday: 400 },
    }
    await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
    await stubSettingsApis(page, state)
    await page.route('**/api/home', (route) => route.fulfill({
      json: {
        worlds: [{ id: 'world-1', name: '雾影庄', status: 'capped', pauseReason: 'global_daily_cap',
          isDemo: false, personCount: 2, simNow: '2026-10-01T08:00:00.000Z', todayEventCount: 3 }],
        timelines: [],
        persons: [],
      },
    }))

    await page.goto('/home')
    const banner = page.getByTestId('global-cap-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('400/400')
    await expect(banner).toContainText('已暂停')

    await page.getByTestId('global-cap-cta').click()
    await expect(page).toHaveURL(/\/settings/)
    await expect(page.getByTestId('budget-usage')).toContainText('今日已用 400 / 400')

    await page.getByTestId('budget-cap').fill('800')
    await page.getByTestId('budget-save').click()
    await expect(page.getByTestId('budget-msg')).toContainText('被全局预算暂停的世界已恢复')
    await expect(page.getByTestId('budget-usage')).toContainText('今日已用 400 / 800')
    expect(errors).toEqual([])
  })
})

test.describe('S3 世界级 LLM 覆盖(AC6)', () => {
  test('世界页 LLM 面板 → 部分覆盖只填 Key → PATCH 载荷正确且无明文回显', async ({ page }) => {
    const errors = watchErrors(page)
    let patchBody: { llmConfig?: Record<string, unknown> } | null = null
    const worldConfig: LlmStub = { baseUrl: null, model: null, hasKey: false, keyPreview: null }
    await stubSplitApis(page)
    await page.route('**/api/worlds/world-1/llm-config', (route) => route.fulfill({ json: worldConfig }))
    await page.route('**/api/worlds/world-1', (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback()
      patchBody = route.request().postDataJSON() as typeof patchBody
      const key = (patchBody as { llmConfig?: { apiKey?: string } })?.llmConfig?.apiKey
      worldConfig.hasKey = !!key
      worldConfig.keyPreview = key ? `…${key.slice(-4)}` : null
      return route.fulfill({ json: worldConfig })
    })

    await page.goto('/worlds/world-1?timeline=timeline-main')
    await page.getByRole('button', { name: 'LLM', exact: true }).dispatchEvent('click')
    const panel = page.getByTestId('world-llm-config')
    await expect(panel).toBeVisible()

    await panel.getByTestId('world-llm-apikey').fill('sk-world-9999')
    await panel.getByTestId('world-llm-save').click()
    expect(patchBody).toEqual({ llmConfig: { apiKey: 'sk-world-9999' } })
    await expect(panel.getByText('当前 Key:…9999')).toBeVisible()
    expect(await panel.getByText('sk-world-9999').count()).toBe(0)
    expect(errors).toEqual([])
  })
})
