import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium, type BrowserContext, type Page } from '@playwright/test'

const apiTarget = (process.env.PHASE2_API_TARGET ?? 'http://127.0.0.1:18891').replace(/\/$/, '')
const previewUrl = (process.env.PHASE2_PREVIEW_URL ?? 'http://127.0.0.1:15175').replace(/\/$/, '')
const username = process.env.DEPLOYMENT_USERNAME
const password = process.env.DEPLOYMENT_PASSWORD
const worldId = process.env.DEPLOYMENT_WORLD_ID
const runTemp = process.env.RUNNER_TEMP ?? '/tmp'
const evidencePath = resolve(runTemp, 'phase2-environment-continuity.json')
const closedScreenshotPath = resolve(runTemp, 'phase2-environment-closed.png')
const reopenedScreenshotPath = resolve(runTemp, 'phase2-environment-reopened.png')

type JsonObject = Record<string, any>
type ApiResult = { status: number; body: JsonObject }
type Diagnostic = {
  drawCount: number
  environment?: { weather?: string | null; lighting?: string | null; access?: Record<string, string> }
  environmentVisuals?: Array<{ kind: string; value: string; locationName?: string }>
}
type VoxelEnvironmentDiagnostic = { weatherFog: number; renderedFogDensity: number }

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const assertions: Record<string, boolean> = {}
const requests: Array<{ method: string; path: string; status: number }> = []

async function api(path: string, init?: RequestInit, token?: string): Promise<ApiResult> {
  const headers = new Headers(init?.headers)
  headers.set('accept', 'application/json')
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  if (token) headers.set('authorization', `Bearer ${token}`)
  const response = await fetch(`${apiTarget}${path}`, { ...init, headers })
  const text = await response.text()
  let body: JsonObject = {}
  try { body = text ? JSON.parse(text) as JsonObject : {} } catch { body = { error: 'non_json_response' } }
  requests.push({ method: init?.method ?? 'GET', path: new URL(path, apiTarget).pathname, status: response.status })
  return { status: response.status, body }
}

async function authorized(path: string, token: string, init?: RequestInit): Promise<ApiResult> {
  return api(path, init, token)
}

function record(name: string, condition: unknown): void {
  assertions[name] = Boolean(condition)
  assert(condition, `assertion failed: ${name}`)
}

async function state(world: string, timeline: string, token: string): Promise<JsonObject> {
  const result = await authorized(`/api/worlds/${encodeURIComponent(world)}/state?timelineId=${encodeURIComponent(timeline)}`, token)
  assert(result.status === 200, `state read failed (${result.status})`)
  return result.body
}

async function environmentAction(
  world: string, timeline: string, token: string,
  actionId: string, location: string | null,
  condition: 'weather' | 'lighting' | 'access', value: 'fog' | 'night' | 'open' | 'closed',
): Promise<JsonObject> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await state(world, timeline, token)
    const result = await authorized(`/api/worlds/${encodeURIComponent(world)}/actions`, token, {
      method: 'POST', body: JSON.stringify({ id: actionId, timelineId: timeline, expectedVersion: current.version,
        action: { type: 'environment', location, condition, value } }),
    })
    if (result.status === 200) return result.body
    if (result.status !== 409) throw new Error(`environment action failed (${result.status})`)
  }
  throw new Error('environment action remained conflicted after version refresh')
}

async function enterWithCurrentVersion(world: string, timeline: string, location: string, commandId: string, token: string): Promise<ApiResult> {
  let last: ApiResult | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await state(world, timeline, token)
    last = await authorized(`/api/worlds/${encodeURIComponent(world)}/scene/position`, token, {
      method: 'POST', body: JSON.stringify({ timelineId: timeline, location, commandId, expectedVersion: current.version }),
    })
    if (last.status !== 409 || !String(last.body.error ?? '').includes('版本')) return last
  }
  return last!
}

async function verifyRenderer(page: Page, locationState: 'closed' | 'open', previousDrawCount = 0): Promise<Diagnostic> {
  await page.waitForFunction(({ minDrawCount, expectedAccess }) => {
    const diagnostics = (window as any).__native2dDiagnostics?.()
    const visuals = diagnostics?.environmentVisuals ?? []
    return Boolean(diagnostics && diagnostics.drawCount > minDrawCount
      && visuals.some(item => item.kind === 'weather' && item.value === 'fog')
      && visuals.some(item => item.kind === 'lighting' && item.value === 'night')
      && visuals.some(item => item.kind === 'access' && item.value === expectedAccess && item.locationName === '后山散步道'))
  }, { minDrawCount: previousDrawCount, expectedAccess: locationState }, { timeout: 20_000 })
  const diagnostics = await page.evaluate(() => (window as any).__native2dDiagnostics?.() as Diagnostic | undefined)
  assert(diagnostics, 'native2d Pixi renderer diagnostics are unavailable')
  assert(diagnostics.environment?.weather === 'fog' && diagnostics.environment?.lighting === 'night'
    && diagnostics.environment?.access?.['后山散步道'] === locationState,
  'native2d environment diagnostics do not match the committed child timeline')
  return diagnostics
}

async function verifyVoxelRenderer(page: Page, world: string, timeline: string): Promise<VoxelEnvironmentDiagnostic> {
  await page.getByTestId('pane-facts-single').waitFor({ timeout: 30_000 })
  await page.waitForFunction(({ expectedWorld, expectedTimeline }) => {
    const pane = document.querySelector('[data-testid="comparison-pane-single"]')
    const engine = (window as any).__voxelEngines?.single
    return pane?.getAttribute('data-world-id') === expectedWorld
      && pane?.getAttribute('data-timeline-id') === expectedTimeline
      && Boolean(engine?.world && engine.weather?.state?.fog >= 0.95
        && engine.renderer?.scene?.fog?.density > 0)
  }, { expectedWorld: world, expectedTimeline: timeline }, { timeout: 30_000 })
  assert(await page.getByTestId('pane-facts-single').textContent().then(text => text?.includes(timeline)),
    '3D pane facts do not show the selected child timeline')
  const diagnostic = await page.evaluate(() => {
    const engine = (window as any).__voxelEngines?.single
    return {
      weatherFog: engine?.weather?.state?.fog ?? 0,
      renderedFogDensity: engine?.renderer?.scene?.fog?.density ?? 0,
    } as VoxelEnvironmentDiagnostic
  })
  assert(diagnostic.weatherFog >= 0.95 && diagnostic.renderedFogDensity > 0,
    '3D renderer did not receive the committed fog projection')
  return diagnostic
}

async function selectAccountTimeline(page: Page, world: string, timeline: string): Promise<void> {
  await page.getByTestId('native2d-source-account').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="native2d-account-world-select"] option').length > 1)
  await page.getByTestId('native2d-account-world-select').selectOption(world)
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="native2d-account-timeline-select"] option').length > 1)
  await page.getByTestId('native2d-account-timeline-select').selectOption(timeline)
  await page.getByTestId('native2d-source-apply').click()
  await page.getByTestId('native2d-account-actions').waitFor()
  await page.getByTestId('native2d-read-status').getByText('事实已更新').waitFor({ timeout: 20_000 })
  assert(await page.getByTestId('native2d-account-world-select').inputValue() === world, 'account 2D selected another world')
  assert(await page.getByTestId('native2d-account-timeline-select').inputValue() === timeline, 'account 2D selected another timeline')
  await page.locator('.native2d-scene-frame').waitFor()
}

async function routeBrowserApiToWorker(context: BrowserContext): Promise<void> {
  await context.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const response = await route.fetch({ url: `${apiTarget}${url.pathname}${url.search}` })
    requests.push({ method: request.method(), path: url.pathname, status: response.status() })
    await route.fulfill({ response })
  })
}

async function main(): Promise<void> {
  assert(username && password && worldId, 'missing deployment account/world variables from phase2-release-preview')
  const login = await api('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
  })
  assert(login.status === 200 && typeof login.body.token === 'string', `owner login failed (${login.status})`)
  const token = login.body.token as string

  const snapshotResult = await authorized(`/api/worlds/${encodeURIComponent(worldId)}`, token)
  assert(snapshotResult.status === 200, `owner world read failed (${snapshotResult.status})`)
  const snapshot = snapshotResult.body
  const parentTimelineId = String(snapshot.currentTimelineId ?? '')
  assert(parentTimelineId, 'owner world snapshot has no current timeline')
  const locations = Array.isArray(snapshot.world?.locations) ? snapshot.world.locations : []
  const residentCount = Array.isArray(snapshot.locationBoard)
    ? snapshot.locationBoard.reduce((count: number, entry: JsonObject) => count + (Array.isArray(entry.persons) ? entry.persons.length : 0), 0)
    : 0
  record('phase2SeedHasSixResidentsAndSevenLocations', residentCount === 6 && locations.length === 7)
  record('seedContainsHallLocation', locations.some((location: JsonObject) => location.name === '大厅'))

  const persona = await authorized(`/api/worlds/${encodeURIComponent(worldId)}/persona`, token, {
    method: 'POST', body: JSON.stringify({ name: '验收访客', description: '用于验证封闭地点规则的临时访客。' }),
  })
  assert(persona.status === 200, `owner persona registration failed (${persona.status})`)
  const parentStateBefore = await state(worldId, parentTimelineId, token)

  const forkRequestId = crypto.randomUUID()
  const fork = await authorized(`/api/worlds/${encodeURIComponent(worldId)}/timelines/${encodeURIComponent(parentTimelineId)}/fork`, token, {
    method: 'POST', body: JSON.stringify({ requestId: forkRequestId, scenario: {
      name: '环境连续性验收', whatIf: '后山散步道暂时关闭后重新开放', changedVariable: '地点通行状态',
    } }),
  })
  assert(fork.status === 200 && typeof fork.body.id === 'string', `world fork failed (${fork.status})`)
  const childTimelineId = fork.body.id as string

  const fog = await environmentAction(worldId, childTimelineId, token, `phase2-fog-${forkRequestId}`, null, 'weather', 'fog')
  const lighting = await environmentAction(worldId, childTimelineId, token, `phase2-lighting-${forkRequestId}`, null, 'lighting', 'night')
  const closed = await environmentAction(worldId, childTimelineId, token, `phase2-close-${forkRequestId}`, '后山散步道', 'access', 'closed')
  const blockedEntry = await enterWithCurrentVersion(worldId, childTimelineId, '后山散步道', `phase2-enter-blocked-${forkRequestId}`, token)
  record('closedLocationBlocksVisitorEntry', blockedEntry.status === 409 && String(blockedEntry.body.error ?? '').includes('后山散步道当前封闭'))

  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--no-sandbox'] })
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  let closedDiagnostics: Diagnostic | undefined
  let reopenedDiagnostics: Diagnostic | undefined
  let returnedDiagnostics: Diagnostic | undefined
  let voxelDiagnostics: VoxelEnvironmentDiagnostic | undefined
  let reopen: JsonObject | undefined
  let retryEntry: ApiResult | undefined
  let fogEvidence: JsonObject | undefined
  let lightingEvidence: JsonObject | undefined
  let closeEvidence: JsonObject | undefined
  let reopenEvidence: JsonObject | undefined
  try {
    await routeBrowserApiToWorker(context)
    const landing = await page.goto(`${previewUrl}/login`)
    assert(landing?.status() === 200, 'production preview login page did not load')
    await page.getByLabel('用户名').fill(username)
    await page.getByLabel('密码').fill(password)
    await page.getByRole('button', { name: '登录' }).click()
    await page.waitForURL(`${previewUrl}/`)
    await page.goto(`${previewUrl}/dev/native-2d`)
    await selectAccountTimeline(page, worldId, childTimelineId)
    closedDiagnostics = await verifyRenderer(page, 'closed')
    await page.locator('.native2d-scene-frame').screenshot({ path: closedScreenshotPath })
    record('closedChildTimelineRendersFogAndClosedPath', true)
    const initial2dSource = await page.getByTestId('native2d-source-label').textContent()
    record('native2dAccountScopeUsesTheOwnerWorldAndChildTimeline',
      initial2dSource?.includes('账户世界') && initial2dSource.includes(worldId) && initial2dSource.includes(childTimelineId)
      && await page.getByTestId('native2d-account-world-select').inputValue() === worldId
      && await page.getByTestId('native2d-account-timeline-select').inputValue() === childTimelineId)

    reopen = await environmentAction(worldId, childTimelineId, token, `phase2-open-${forkRequestId}`, '后山散步道', 'access', 'open')
    retryEntry = await enterWithCurrentVersion(worldId, childTimelineId, '后山散步道', `phase2-enter-retry-${forkRequestId}`, token)
    record('reopenAllowsNewVisitorEntryCommand', retryEntry.status === 200)

    await page.reload()
    await selectAccountTimeline(page, worldId, childTimelineId)
    reopenedDiagnostics = await verifyRenderer(page, 'open')
    await page.locator('.native2d-scene-frame').screenshot({ path: reopenedScreenshotPath })
    record('reopenedChildTimelineRendersFogAndOpenPath', true)

    const committedChildState = await state(worldId, childTimelineId, token)
    const worldPage = await page.goto(`${previewUrl}/worlds/${encodeURIComponent(worldId)}?timeline=${encodeURIComponent(childTimelineId)}&presentation=voxel3d`)
    assert(worldPage?.status() === 200, 'production preview world page did not load')
    await page.locator('[data-testid="comparison-pane-single"] [data-presentation="voxel3d"] canvas').waitFor({ timeout: 30_000 })
    voxelDiagnostics = await verifyVoxelRenderer(page, worldId, childTimelineId)
    record('voxelPaneUsesTheSameOwnerWorldAndChildTimeline',
      await page.getByTestId('pane-facts-single').textContent().then(text => text?.includes('owner') && text.includes(childTimelineId)))
    record('voxelRendererReceivesWorldFogProjection', voxelDiagnostics.weatherFog >= 0.95 && voxelDiagnostics.renderedFogDensity > 0)
    await page.getByTestId('voxel-mode-toggle').click()
    await page.waitForFunction(() => (window as any).__voxelEngines?.single?.probeScene?.().cameraMode === 'walk', null, { timeout: 15_000 })
    const walkEntry = await page.evaluate(() => ({
      probe: (window as any).__voxelEngines?.single?.probeScene?.(),
      pointerLocked: document.pointerLockElement !== null,
    }))
    const spawned = walkEntry.probe?.walkPosition
    const worldSize = walkEntry.probe?.worldSize
    assert(spawned && worldSize && spawned.x >= 0 && spawned.x < worldSize.width
      && spawned.z >= 0 && spawned.z < worldSize.depth && walkEntry.pointerLocked === false,
    'production 3D first-person entry did not spawn in bounds without pointer lock')
    await page.getByTestId('voxel-mode-toggle').click()
    await page.waitForFunction(() => (window as any).__voxelEngines?.single?.probeScene?.().cameraMode === 'orbit', null, { timeout: 15_000 })
    assert(await page.evaluate(() => document.pointerLockElement === null), 'production 3D exit left pointer lock active')
    record('production3dWalkSpawnExitAndNoPointerLock', true)

    await page.getByRole('group', { name: '世界画面表现' }).getByRole('button', { name: '2D' }).click()
    await page.locator('[data-testid="comparison-pane-single"] [data-presentation="native2d"] canvas').waitFor({ timeout: 30_000 })
    const pageScope = await page.locator('[data-testid="comparison-pane-single"]').evaluate(element => ({
      world: element.getAttribute('data-world-id'), timeline: element.getAttribute('data-timeline-id'),
    }))
    record('integrated2dSwitchKeepsTheSameWorldAndChildTimeline', pageScope.world === worldId && pageScope.timeline === childTimelineId)
    await page.goto(`${previewUrl}/`)
    await page.goto(`${previewUrl}/dev/native-2d`)
    await selectAccountTimeline(page, worldId, childTimelineId)
    returnedDiagnostics = await verifyRenderer(page, 'open')
    const returnedChildState = await state(worldId, childTimelineId, token)
    record('leavingAndReturningKeepsCommittedChildStateUnchanged',
      JSON.stringify(returnedChildState) === JSON.stringify(committedChildState))
    record('returned2dAccountScopeMatchesTheWorldAndTimeline',
      await page.getByTestId('native2d-account-world-select').inputValue() === worldId
      && await page.getByTestId('native2d-account-timeline-select').inputValue() === childTimelineId)

    const commandEvidence = async (commandId: string, resultVersion: number, factId: string): Promise<JsonObject> => {
      const command = await authorized(`/api/worlds/${encodeURIComponent(worldId)}/actions/${encodeURIComponent(commandId)}`, token)
      assert(command.status === 200 && command.body.timelineId === childTimelineId && command.body.resultVersion === resultVersion,
        'direct command read did not return the committed child version')
      const detail = await authorized(`/api/worlds/${encodeURIComponent(worldId)}/events/${encodeURIComponent(`command:${commandId}`)}/evidence?timelineId=${encodeURIComponent(childTimelineId)}`, token)
      assert(detail.status === 200, `direct event evidence read failed (${detail.status})`)
      const fact = Array.isArray(detail.body.facts) ? detail.body.facts.find((item: JsonObject) => item.id === factId) : null
      assert(detail.body.timelineId === childTimelineId && detail.body.event?.id === `command:${commandId}`
        && detail.body.command?.id === commandId && detail.body.command?.version === resultVersion
        && fact?.sourceCommandId === commandId && fact.version === resultVersion,
        'event evidence did not link command, fact, and version')
      return { event: detail.body.event, command: detail.body.command, fact }
    }
    fogEvidence = await commandEvidence(String(fog.commandId), Number(fog.version), String(fog.factId))
    lightingEvidence = await commandEvidence(String(lighting.commandId), Number(lighting.version), String(lighting.factId))
    closeEvidence = await commandEvidence(String(closed.commandId), Number(closed.version), String(closed.factId))
    reopenEvidence = await commandEvidence(String(reopen.commandId), Number(reopen.version), String(reopen.factId))
    record('versionedFactEventAndSourceCommandEvidenceVerified', true)

    const childState = await state(worldId, childTimelineId, token)
    const parentState = await state(worldId, parentTimelineId, token)
    const childCommands = new Set([String(fog.commandId), String(lighting.commandId), String(closed.commandId), String(reopen.commandId), String(retryEntry?.body.commandId ?? '')])
    const childFacts = Array.isArray(childState.facts) ? childState.facts : []
    const parentFacts = Array.isArray(parentState.facts) ? parentState.facts : []
    record('parentTimelineHasNoChildCommandsOrFacts', !parentFacts.some((fact: JsonObject) => childCommands.has(fact.sourceCommandId)))
    record('childTimelineContainsExpectedEnvironmentFacts', childFacts.some((fact: JsonObject) =>
      fact.sourceCommandId === fog.commandId && fact.value?.condition === 'weather' && fact.value?.value === 'fog')
      && childFacts.some((fact: JsonObject) => fact.sourceCommandId === lighting.commandId
        && fact.value?.condition === 'lighting' && fact.value?.value === 'night')
      && childFacts.some((fact: JsonObject) => fact.sourceCommandId === closed.commandId && fact.value?.value === 'closed')
      && childFacts.some((fact: JsonObject) => fact.sourceCommandId === reopen.commandId && fact.value?.value === 'open'))
    record('parentAndChildStateReadsRemainIsolated',
      parentState.version === parentStateBefore.version
      && JSON.stringify(parentState.facts) === JSON.stringify(parentStateBefore.facts)
      && childState.version > parentState.version)
    record('browserViewsUsedWorkerBackedApiReads', requests.some(request => request.path.endsWith('/map/bootstrap') && request.status === 200)
      && requests.some(request => request.path === `/api/worlds/${worldId}` && request.status === 200)
      && requests.some(request => request.path.endsWith('/state') && request.status === 200))
    record('noUnexpectedWorkerFailures', requests.filter(request => request.status >= 400
      && !(request.path.endsWith('/scene/position') && request.status === blockedEntry.status)).length === 0)
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await context.close()
    await browser.close()
  }

  const report = {
    result: 'PASS',
    api: 'GitHub-hosted runner; isolated local Worker and D1; browser API calls use that local Worker; no remote deployment',
    browser: 'production preview account 2D/3D routes; Pixi environment visuals, Voxel weather/fog projection, and desktop first-person mode checked after render; touch first-person remains disabled by the platform gate',
    providerCalls: 0,
    seed: { residentCount, locationCount: locations.length },
    timeline: { branched: true, parentIdSha256: hash(parentTimelineId), childIdSha256: hash(childTimelineId) },
    assertions,
    renderer: {
      closed: { environment: closedDiagnostics?.environment, visuals: closedDiagnostics?.environmentVisuals },
      reopened: { environment: reopenedDiagnostics?.environment, visuals: reopenedDiagnostics?.environmentVisuals },
      returned: { environment: returnedDiagnostics?.environment, visuals: returnedDiagnostics?.environmentVisuals },
      voxel: voxelDiagnostics,
      screenshots: [closedScreenshotPath, reopenedScreenshotPath],
    },
    evidence: { fog: fogEvidence, lighting: lightingEvidence, closed: closeEvidence, reopened: reopenEvidence },
    limitations: [
      'Touch first-person entry is disabled by the existing platform gate, so the real-account browser walk check is desktop-only.',
      'Fall recovery is not forced through the user-facing browser path; this run does not claim browser coverage for that edge case.',
    ],
    blockedEntry: { status: blockedEntry.status },
    retryEntry: { status: retryEntry?.status },
    workerRequests: requests.length,
    workerFailures: requests.filter(request => request.status >= 400
      && !(request.path.endsWith('/scene/position') && request.status === blockedEntry.status)).length,
  }
  mkdirSync(runTemp, { recursive: true })
  writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ result: report.result, evidencePath, assertions }, null, 2)}\n`)
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

await main().catch(error => {
  const message = error instanceof Error ? error.message : 'unknown acceptance failure'
  const failure = { result: 'FAIL', error: message, assertions,
    workerRequests: requests.length, workerStatuses: requests.map(({ method, status }) => ({ method, status })), providerCalls: 0 }
  mkdirSync(runTemp, { recursive: true })
  writeFileSync(evidencePath, `${JSON.stringify(failure, null, 2)}\n`, 'utf8')
  process.stderr.write(`${JSON.stringify({ result: failure.result, evidencePath, error: message }, null, 2)}\n`)
  process.exitCode = 1
})
