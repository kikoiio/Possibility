import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from '@playwright/test'
import { ASSET_MANIFEST } from '../src/native2d/assets'
import { MIST_MANOR_SCENE } from '../src/native2d/scene'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const apiRoot = resolve(repoRoot, 'api')
const apiTarget = process.env.PHASE2_API_TARGET ?? 'http://127.0.0.1:18891'
const previewUrl = process.env.PHASE2_PREVIEW_URL ?? 'http://127.0.0.1:15175'
const persistTo = process.env.PHASE2_D1_PERSIST ?? '/tmp/phase2-release-acceptance'

interface ApiResult {
  readonly status: number
  readonly body: any
}

interface ApiRecord {
  readonly method: string
  readonly path: string
  readonly status: number
  readonly source: 'worker' | 'mocked-sse'
}

declare global {
  interface Window {
    __native2dDiagnostics?: () => {
      readonly drawCount: number
      readonly objectBounds: Readonly<Record<string, { readonly x: number; readonly y: number; readonly width: number; readonly height: number }>>
    } | undefined
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function apiJson(path: string, init?: RequestInit): Promise<ApiResult> {
  const response = await fetch(`${apiTarget}${path}`, init)
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}

async function waitForText(page: Page, testId: string, text: string, timeout = 20_000): Promise<void> {
  await page.getByTestId(testId).filter({ hasText: text }).waitFor({ timeout })
}

async function prepareOwnerWorld(): Promise<{ username: string; password: string; worldId: string }> {
  const seeded = await apiJson('/api/dev/seed', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert(seeded.status === 200, `test account seed returned HTTP ${seeded.status}`)
  const owner = seeded.body?.accounts?.find((account: any) => account.username === 'admin' && account.password)
  assert(owner, 'fresh isolated D1 did not return a disposable owner account')

  const demo = await apiJson('/api/dev/seed-demo', { method: 'POST' })
  assert(demo.status === 200 && typeof demo.body?.worldId === 'string', `demo seed returned HTTP ${demo.status}`)
  const sql = `UPDATE worlds SET is_demo = 0 WHERE id = '${demo.body.worldId}'; DELETE FROM demo_baselines WHERE world_id = '${demo.body.worldId}';`
  const migration = spawnSync('npx', [
    'wrangler', 'd1', 'execute', 'DB', '--local', '--config', 'wrangler.s02-e2e.toml',
    '--persist-to', persistTo, '--command', sql,
  ], { cwd: apiRoot, encoding: 'utf8' })
  assert(migration.status === 0, `local owner fixture preparation failed (${migration.status ?? 'signal'})`)
  return { username: owner.username, password: owner.password, worldId: demo.body.worldId }
}

async function apiWithToken(path: string, token: string, init?: RequestInit): Promise<ApiResult> {
  const headers = new Headers(init?.headers)
  headers.set('authorization', `Bearer ${token}`)
  return apiJson(path, {
    ...init,
    headers,
  })
}

async function dragBuildingTo(page: Page, buildingId: string, target: { x: number; z: number }): Promise<void> {
  const building = MIST_MANOR_SCENE.buildings.find(item => item.id === buildingId)
  const asset = ASSET_MANIFEST[buildingId]
  assert(building && asset, `unknown building ${buildingId}`)
  const selection = await page.getByTestId('native2d-account-timeline-select').inputValue()
  const selectedWorld = await page.getByTestId('native2d-account-world-select').inputValue()
  const layoutResult = await apiWithToken(
    `/api/worlds/${encodeURIComponent(selectedWorld)}/native2d/layout?timelineId=${encodeURIComponent(selection)}&sceneId=${encodeURIComponent(MIST_MANOR_SCENE.id)}`,
    await page.evaluate(() => localStorage.getItem('possibility_token') ?? ''),
  )
  assert(layoutResult.status === 200, `layout read before move returned HTTP ${layoutResult.status}`)
  const origin = layoutResult.body?.layout?.placements?.find((item: any) => item.buildingId === buildingId)?.origin ?? building.initialOrigin

  const beforeDraw = await page.evaluate(() => window.__native2dDiagnostics?.()?.drawCount ?? 0)
  await page.getByTestId('native2d-overview').click()
  await page.waitForFunction(value => (window.__native2dDiagnostics?.()?.drawCount ?? 0) > value, beforeDraw)
  await page.getByTestId('native2d-viewport').scrollIntoViewIfNeeded()
  const screen = await page.evaluate(({ buildingId: id, pixelWidth, anchorX, anchorY }) => {
    const diagnostics = window.__native2dDiagnostics?.()
    const bounds = diagnostics?.objectBounds[`building:${id}`]
    const host = document.querySelector('[data-testid="native2d-viewport"]')?.getBoundingClientRect()
    if (!bounds || !host) return null
    const zoom = bounds.width / pixelWidth
    return {
      x: host.left + bounds.x + anchorX * zoom,
      y: host.top + bounds.y + anchorY * zoom,
      zoom,
    }
  }, {
    buildingId, pixelWidth: asset.layers[0].pixelWidth,
    anchorX: asset.layers[0].anchorPx.x, anchorY: asset.layers[0].anchorPx.y,
  })
  assert(screen, `missing rendered bounds for ${buildingId}`)

  const dx = (target.x - origin.x - (target.z - origin.z)) * 32 * screen.zoom
  const dy = (target.x - origin.x + target.z - origin.z) * 16 * screen.zoom
  await page.mouse.move(screen.x, screen.y)
  await page.mouse.down()
  await page.mouse.move(screen.x + dx, screen.y + dy, { steps: 12 })
  await page.mouse.up()
  await page.getByTestId('native2d-move-status').filter({ hasText: `候选位置 ${target.x}, ${target.z}` }).waitFor({ timeout: 10_000 })
  await page.getByTestId('native2d-move-status').filter({ hasText: '可应用' }).waitFor({ timeout: 10_000 })
  await page.getByTestId('native2d-apply').click()
  await page.getByTestId('native2d-save-status').filter({ hasText: '布局保存在账户世界' }).waitFor({ timeout: 20_000 })
}

async function main(): Promise<void> {
  const owner = await prepareOwnerWorld()
  const login = await apiJson('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: owner.username, password: owner.password }),
  })
  assert(login.status === 200 && typeof login.body?.token === 'string', `owner login returned HTTP ${login.status}`)
  const token = login.body.token as string
  const initialSnapshot = await apiWithToken(`/api/worlds/${encodeURIComponent(owner.worldId)}`, token)
  assert(initialSnapshot.status === 200, `owner world snapshot returned HTTP ${initialSnapshot.status}`)
  const parentTimelineId = initialSnapshot.body.currentTimelineId as string

  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await context.newPage()
  const records: ApiRecord[] = []
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.endsWith('/scene') && request.method() === 'POST') {
      records.push({ method: request.method(), path: url.pathname, status: 200, source: 'mocked-sse' })
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: 'data: {"type":"delta","text":"release preview accepted"}\n\ndata: {"type":"done"}\n\n',
      })
      return
    }
    const response = await route.fetch({ url: `${apiTarget}${url.pathname}${url.search}` })
    records.push({ method: request.method(), path: url.pathname, status: response.status(), source: 'worker' })
    await route.fulfill({ response })
  })

  try {
    const landing = await page.goto(`${previewUrl}/login`)
    assert(landing?.status() === 200, 'production preview login page did not load')
    await page.getByLabel('用户名').fill(owner.username)
    await page.getByLabel('密码').fill(owner.password)
    await page.getByRole('button', { name: '登录' }).click()
    await page.waitForURL(`${previewUrl}/`)
    await page.goto(`${previewUrl}/dev/native-2d`)
    await page.getByTestId('native2d-source-account').click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="native2d-account-world-select"] option').length > 1)
    await page.getByTestId('native2d-account-world-select').selectOption(owner.worldId)
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="native2d-account-timeline-select"] option').length > 1)
    await page.getByTestId('native2d-account-timeline-select').selectOption(parentTimelineId)
    await page.getByTestId('native2d-source-apply').click()
    await page.getByTestId('native2d-account-actions').waitFor()
    await page.getByTestId('native2d-read-status').getByText('事实已更新').waitFor({ timeout: 20_000 })

    await page.getByTestId('native2d-resident-list').locator('button').first().click()
    await page.getByTestId('native2d-intervention-input').fill('GitHub Actions production preview acceptance')
    await page.getByTestId('native2d-intervene').click()
    await waitForText(page, 'native2d-account-action-status', '干预已提交')

    await page.getByTestId('native2d-chat-input').fill('release preview SSE boundary')
    await page.getByTestId('native2d-chat-send').click()
    await waitForText(page, 'native2d-account-action-status', '对话已完成')

    await page.getByTestId('native2d-fork').click()
    await waitForText(page, 'native2d-account-action-status', '已创建分叉时间线')
    const forkTimelineId = await page.getByTestId('native2d-account-timeline-select').inputValue()
    assert(forkTimelineId && forkTimelineId !== parentTimelineId, 'fork did not select a new timeline')
    await page.getByTestId('native2d-source-label').filter({ hasText: forkTimelineId }).waitFor({ timeout: 20_000 })
    await page.getByTestId('native2d-compare-timeline').selectOption(parentTimelineId)
    await page.getByTestId('native2d-compare').click()
    await waitForText(page, 'native2d-account-action-status', '比较结果已读取')

    await page.getByTestId('native2d-building-list').selectOption('gatehouse')
    await page.getByTestId('native2d-move').click()
    await dragBuildingTo(page, 'gatehouse', { x: 5, z: 10 })
    const childLayoutPath = `/api/worlds/${encodeURIComponent(owner.worldId)}/native2d/layout?timelineId=${encodeURIComponent(forkTimelineId)}&sceneId=${encodeURIComponent(MIST_MANOR_SCENE.id)}`
    const savedLayout = await apiWithToken(childLayoutPath, token)
    assert(savedLayout.status === 200 && savedLayout.body?.layout, `saved child layout read returned HTTP ${savedLayout.status}`)
    const savedPlacements = JSON.stringify(savedLayout.body.layout.placements)
    assert(savedLayout.body.layout.placements.find((item: any) => item.buildingId === 'gatehouse')?.origin.x === 5, 'D1 layout did not retain the moved gatehouse')

    await page.reload()
    await page.getByTestId('native2d-source-account').click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="native2d-account-world-select"] option').length > 1)
    await page.getByTestId('native2d-account-world-select').selectOption(owner.worldId)
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="native2d-account-timeline-select"] option').length > 1)
    await page.getByTestId('native2d-account-timeline-select').selectOption(forkTimelineId)
    await page.getByTestId('native2d-source-apply').click()
    await page.getByTestId('native2d-account-actions').waitFor()
    await page.getByTestId('native2d-read-status').getByText('事实已更新').waitFor({ timeout: 20_000 })
    const restoredLayout = await apiWithToken(childLayoutPath, token)
    assert(restoredLayout.status === 200, `layout read after reload returned HTTP ${restoredLayout.status}`)
    assert(JSON.stringify(restoredLayout.body?.layout?.placements) === savedPlacements, 'D1 layout changed after reload and timeline reselection')

    const workerErrors = records.filter(record => record.source === 'worker' && record.status >= 400)
    assert(workerErrors.length === 0, `real Worker requests failed: ${JSON.stringify(workerErrors)}`)
    const required = [
      ['POST', '/api/auth/login'], ['GET', '/api/worlds'],
      ['POST', `/api/worlds/${owner.worldId}/actions`],
      ['POST', `/api/worlds/${owner.worldId}/timelines/${parentTimelineId}/fork`],
      ['GET', `/api/worlds/${owner.worldId}/compare`],
      ['PUT', `/api/worlds/${owner.worldId}/native2d/layout`],
    ]
    for (const [method, path] of required) {
      assert(records.some(record => record.source === 'worker' && record.method === method && record.path === path), `missing real API evidence: ${method} ${path}`)
    }
    assert(records.some(record => record.source === 'mocked-sse'), 'chat SSE mock boundary was not exercised')

    const result = {
      result: 'PASS',
      commit: process.env.GITHUB_SHA ?? 'local',
      build: 'Vite production bundle served by vite preview',
      browser: 'Chromium desktop 1280x720',
      api: 'local Cloudflare Worker with isolated local D1; browser API responses forwarded without fixtures',
      operations: ['login', 'world/timeline read', 'intervention', 'fork', 'compare', 'layout save', 'reload and layout restore'],
      mocked: ['account chat SSE response only; no model provider call'],
      workerRequests: records.filter(record => record.source === 'worker').length,
      workerStatusFailures: workerErrors.length,
      layoutVersion: restoredLayout.body.layout.version,
      layoutRestoredAfterReload: true,
    }
    const report = `${JSON.stringify(result, null, 2)}\n`
    process.stdout.write(report)
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Phase 2 production preview acceptance\n\n\`\`\`json\n${report}\`\`\`\n`)
    }
  } finally {
    await context.close()
    await browser.close()
  }
}

await main()
