import { expect, test, type Page } from '@playwright/test'

const personDraft = {
  name: '',
  model: {
    identity: [{ text: '', provenance: 'known' }],
    behavior: [{ text: '', provenance: 'known' }],
    speech: [{ text: '', provenance: 'known' }],
    skills: [], memories: [], relationships: [],
    boundaries: [{ text: '', provenance: 'known' }],
    unknowns: [''],
  },
  worldName: '', worldDescription: '',
  initialState: { location: '', activity: '', mood: '', goal: '' },
}

const worlds = [
  {
    id: 'world-river', name: '河畔街', description: '有一间安静的书店。', status: 'running', pauseReason: null,
    isDemo: false, hasScene: true, personIds: ['person-lin'], personCount: 1, callsToday: 2,
    simNow: '2026-10-01T10:00:00.000Z', timeZone: 'UTC', createdAt: '2026-09-20T10:00:00.000Z',
  },
  {
    id: 'world-river-empty', name: '河畔街', description: '场景尚未准备好。', status: 'paused', pauseReason: 'manual',
    isDemo: false, hasScene: false, personIds: ['person-gu'], personCount: 1, callsToday: 0,
    simNow: null, timeZone: 'UTC', createdAt: '2026-09-25T10:00:00.000Z',
  },
]

async function authenticate(page: Page) {
  await page.addInitScript(() => localStorage.setItem('possibility_token', 's5a-e2e-token'))
}

async function stubWorldList(page: Page) {
  await page.route('**/api/worlds', route => route.fulfill({ json: { worlds } }))
  await page.route('**/api/persons', route => route.fulfill({ json: {
    persons: [
      { id: 'person-lin', name: '林晚', createdAt: '2026-09-01T10:00:00.000Z' },
      { id: 'person-gu', name: '顾舟', createdAt: '2026-09-02T10:00:00.000Z' },
    ],
  } }))
}

test.describe('S5A 人物表单与世界列表', () => {
  test('manual form maps errors, focuses first field, and clears corrected errors', async ({ page }) => {
    await authenticate(page)
    let saveCalls = 0
    await page.route('**/api/persons', async route => {
      if (route.request().method() === 'POST') {
        saveCalls += 1
        return route.fulfill({ status: 422, json: {
          error: '人物资料需要修正。',
          issues: [{ code: 'name_required', message: '姓名不能为空。' }],
        } })
      }
      return route.fulfill({ json: { persons: [] } })
    })

    await page.goto('/people/new')
    await page.getByRole('button', { name: '不调用生成服务，手动填写人物卡' }).click()
    await page.getByRole('button', { name: '确认创建人物' }).click()

    await expect(page.locator('#person-create-name')).toBeFocused()
    await expect(page.locator('#person-create-error-name')).toHaveText('姓名不能为空。')
    await expect(page.locator('#person-create-error-identity')).toBeVisible()
    expect(saveCalls).toBe(0)

    await page.locator('#person-create-name').fill('林晚')
    await expect(page.locator('#person-create-error-name')).toHaveCount(0)
    await page.locator('#person-create-identity-0').fill('书店店主')
    await page.locator('#person-create-behavior-0').fill('观察入微')
    await page.locator('#person-create-speech-0').fill('说话温和')
    await page.locator('#person-create-boundaries-0').fill('尊重他人决定')
    await page.locator('#person-create-unknowns-0').fill('未来的选择')
    await page.getByRole('button', { name: '确认创建人物' }).click()

    await expect(page.locator('#person-create-error-name')).toHaveText('姓名不能为空。')
    await expect(page.locator('p[role="alert"]').filter({ hasText: '人物资料需要修正。' })).toBeVisible()
    expect(saveCalls).toBe(1)
  })

  test('world list separates same-name worlds with real summaries', async ({ page }) => {
    await authenticate(page)
    await stubWorldList(page)
    await page.goto('/worlds')

    const items = page.locator('article')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toContainText('河畔街')
    await expect(items.nth(0)).toContainText('林晚')
    await expect(items.nth(0)).toContainText('运行中')
    await expect(items.nth(0)).toContainText('创建于')
    await expect(items.nth(1)).toContainText('顾舟')
    await expect(items.nth(1)).toContainText('待创建场景')
    await expect(items.nth(1)).toContainText('补建场景')
    await expect(items.nth(0)).not.toContainText('world-river')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  })

  test('unmapped server failures remain global while mapped field errors stay local', async ({ page }) => {
    await authenticate(page)
    await page.route('**/api/persons', async route => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 422, json: {
          error: '服务暂时不可用，请稍后重试。',
          issues: [{ code: 'name_required', message: '姓名不能为空。' }, { code: 'provider', message: '提供方暂不可用。' }],
        } })
      }
      return route.fulfill({ json: { persons: [] } })
    })

    await page.goto('/people/new')
    await page.getByRole('button', { name: '不调用生成服务，手动填写人物卡' }).click()
    await page.locator('#person-create-name').fill('林晚')
    await page.locator('#person-create-identity-0').fill('书店店主')
    await page.locator('#person-create-behavior-0').fill('观察入微')
    await page.locator('#person-create-speech-0').fill('说话温和')
    await page.locator('#person-create-boundaries-0').fill('尊重他人决定')
    await page.locator('#person-create-unknowns-0').fill('未来的选择')
    await page.getByRole('button', { name: '确认创建人物' }).click()

    await expect(page.locator('p[role="alert"]').filter({ hasText: '服务暂时不可用，请稍后重试。' })).toBeVisible()
    await expect(page.locator('p[role="alert"]').filter({ hasText: '姓名不能为空。' })).toBeVisible()
    await expect(page.locator('p[role="alert"]').filter({ hasText: '提供方暂不可用。' })).toHaveCount(0)
  })
})
