import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  BASELINE_CASES,
  createAcceptanceManifest,
  collectPageEvidence,
  writeAcceptanceManifest,
  type BaselineCase,
} from '../scripts/phase1-core-loop-baseline.acceptance'

/**
 * This is an evidence recorder, rather than a second implementation of the
 * product journeys. Existing phase1-core-loop.spec.ts remains the assertion
 * suite; this matrix gives every BB row a deterministic route and records a
 * failure/unverified reason when that route cannot be exercised.
 */
test.describe.configure({ mode: 'serial' })
// The matrix intentionally visits 22 real routes in one serial browser
// context. Keep enough budget for the slowest WebGL mount while bounding each
// missing selector so one unimplemented surface cannot consume the whole run.
test.setTimeout(300_000)

const outputRoot = resolve(process.env.PHASE1_BASELINE_OUTPUT_DIR ?? '../artifacts/phase1-core-loop')
const runId = process.env.PHASE1_BASELINE_RUN_ID ?? `playwright-${process.env.GITHUB_RUN_ID ?? Date.now()}`
const runDir = resolve(outputRoot, runId)
const screenshotEnabled = process.env.PHASE1_BASELINE_SCREENSHOTS === 'true'

const person = { id: 'person-1', name: 'Ada', createdAt: '2026-01-01T00:00:00.000Z' }
const world = {
  id: 'phase1-core-world',
  name: '阶段一雾影庄',
  description: '白雾町的一座旧宅、温室和石灯庭院。',
  status: 'running',
  pauseReason: null,
  isDemo: false,
  callsToday: 0,
  timeZone: 'Asia/Shanghai',
  locations: [
    { name: '主楼', description: '旧宅主楼' },
    { name: '温室', description: '玻璃温室' },
    { name: '庭院', description: '石灯庭院' },
  ],
}
const timeline = { id: 'phase1-core-timeline', parentTimelineId: null, simNow: '2026-10-02T12:00:00.000Z', name: '主线' }
const scene = {
  format: 'voxel-document',
  size: { width: 16, height: 8, depth: 16 },
  objects: [],
  locations: [],
}

function snapshot() {
  return {
    world,
    timelines: [timeline, { id: 'phase1-fork', parentTimelineId: timeline.id, simNow: timeline.simNow, name: '平行宇宙' }],
    currentTimelineId: timeline.id,
    simNow: timeline.simNow,
    stateVersion: 1,
    worldModelVersion: 1,
    evidenceStatus: 'structured',
    evidence: { level: 'complete', reasonCodes: [] },
    currentFacts: [{ factType: 'environment', value: { condition: 'weather', value: 'clear' } }],
    locationBoard: [{ location: '主楼', persons: [{ ...person, activity: '正在安顿' }] }],
    events: [],
  }
}

function mapBootstrap() {
  return {
    access: { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false },
    world: snapshot(),
    scene: { status: 'ready', document: scene },
    presentation: {
      timelineId: timeline.id,
      stateVersion: 1,
      simNow: timeline.simNow,
      timeOfDay: 'day',
      weather: { kind: null, label: null },
      residents: [{ ...person, activity: '正在安顿', location: '主楼' }],
      locations: world.locations,
      signals: [],
    },
    theme: { id: 'mist-manor', assetVersion: 'phase1-fixture' },
    resume: { worldId: world.id, timelineId: timeline.id, spaceId: 'exterior', mode: 'life', updatedAt: timeline.simNow },
  }
}

async function installRoutes(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'phase1-e2e-token'))
  // Keep the deterministic token valid for the app's auth bootstrap. Otherwise
  // the first real /auth/me 401 clears localStorage and sends later journeys to
  // /login, hiding the page behavior this baseline is meant to observe.
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: { id: 'owner-1', username: 'baseline-owner' } } }))
  await page.route('**/api/persons**', route => route.fulfill({ json: { persons: [person] } }))
  await page.route('**/api/worlds', route => route.fulfill({ json: { worlds: [world] } }))
  await page.route('**/api/worlds/phase1-core-world/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/time-zone')) return route.fulfill({ json: { timeZone: world.timeZone } })
    if (path.endsWith('/map/bootstrap')) return route.fulfill({ json: mapBootstrap() })
    if (path.endsWith('/map/resume')) return route.fulfill({ json: { ok: true } })
    if (path.endsWith('/stream')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' })
    if (path.endsWith('/scene')) return route.fulfill({ json: { scope: { worldId: world.id, timelineId: timeline.id }, status: 'ready', document: scene, version: 1 } })
    return route.fulfill({ json: snapshot() })
  })
  await page.route('**/api/worlds/world-1/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/time-zone')) return route.fulfill({ json: { timeZone: world.timeZone } })
    if (path.endsWith('/map/bootstrap')) return route.fulfill({ json: mapBootstrap() })
    if (path.endsWith('/stream')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' })
    return route.fulfill({ json: snapshot() })
  })
  await page.route('**/api/worlds/phase1-core-world', route => route.fulfill({ json: snapshot() }))
  await page.route('**/api/worlds/world-1', route => route.fulfill({ json: snapshot() }))
}

type Journey = {
  path: string
  selector: string
  reason?: string
}

const journeys: Record<string, Journey> = {
  'BB-01': { path: '/worlds/new?person=person-1', selector: 'scene-create-shell' },
  'BB-02': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline', selector: 'voxel-viewport-canvas' },
  'BB-03': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline', selector: 'world-canvas-page' },
  'BB-04': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline', selector: 'world-canvas-page' },
  'BB-05': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline', selector: 'fork-entry' },
  'BB-06': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline', selector: 'world-canvas-page' },
  'BB-07': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline', selector: 'voxel-viewport-canvas' },
  'BB-08': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline', selector: 'timeline-switcher' },
  'BB-09': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline', selector: 'world-time-zone-setting' },
  'BB-10': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline', selector: 'owner-map-stage' },
  'BB-11': { path: '/worlds/new?person=person-1', selector: 'scene-prompt' },
  'BB-12': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline', selector: 'world-canvas-page' },
  'BB-13': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline', selector: 'owner-map-stage' },
  'BB-14': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline', selector: 'world-time-zone-setting' },
  'BB-15': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline', selector: 'fork-entry' },
  'BB-16': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline', selector: 'world-canvas-page' },
  'BB-17': { path: '/worlds/new?person=person-1', selector: 'scene-create-shell' },
  'BB-18': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline', selector: 'world-status' },
  'supplemental-registration-claim': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline', selector: 'world-canvas-page' },
  'supplemental-guest-timezone': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline', selector: 'world-time-zone-setting' },
  'supplemental-interior-3d': { path: '/worlds/phase1-core-world?timeline=phase1-core-timeline&presentation=voxel3d', selector: 'voxel-viewport-canvas' },
  'supplemental-timeline-display': { path: '/worlds/phase1-core-world?mode=possibility&timeline=phase1-core-timeline', selector: 'timeline-switcher' },
}

function caseDefinition(caseId: string): BaselineCase {
  const definition = BASELINE_CASES.find(item => item[0] === caseId)
  if (!definition) throw new Error(`Missing baseline definition: ${caseId}`)
  const [resolvedCaseId, category, entry] = definition
  return {
    caseId: resolvedCaseId,
    category,
    entry,
    identity: 'fixture:deterministic-owner',
    context: { worldId: world.id, timelineId: timeline.id, spaceId: 'exterior', simNow: timeline.simNow },
    status: 'unverified',
    http: [],
    page: { url: null, labels: [] },
    evidencePaths: [],
    failure: { summary: '尚未运行该验收项。', nextStep: '在隔离环境运行对应入口旅程。' },
  }
}

test('records deterministic Phase 1 baseline matrix', async ({ page }, testInfo) => {
  const manifest = createAcceptanceManifest(runId, 'playwright')
  const responseRecords: Array<{ method: string; path: string; status: number }> = []
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname.startsWith('/api/')) responseRecords.push({ method: response.request().method(), path: url.pathname, status: response.status() })
  })
  await installRoutes(page)

  for (const [caseId] of BASELINE_CASES) {
    const result = caseDefinition(caseId)
    const journey = journeys[caseId]
    try {
      if (!journey) throw new Error('未配置确定性入口旅程。')
      await page.goto(journey.path, { waitUntil: 'domcontentloaded' })
      await page.getByTestId(journey.selector).waitFor({ state: 'visible', timeout: 8_000 })
      result.page = await collectPageEvidence(page, screenshotEnabled ? { screenshotPath: resolve(runDir, 'screenshots', `${caseId}.png`) } : {})
      if (result.page.screenshotPath) result.evidencePaths.push(`screenshots/${caseId}.png`)
      result.http = responseRecords.splice(0)
      result.status = 'passed'
      delete result.failure
    } catch (error) {
      result.page = await collectPageEvidence(page).catch(() => ({ url: null, labels: [] }))
      result.http = responseRecords.splice(0)
      result.status = journey?.reason ? 'unverified' : 'failed'
      result.failure = {
        summary: journey?.reason ?? (error instanceof Error ? error.message : String(error)),
        nextStep: journey?.reason ? '补充隔离 fixture 后重新运行该入口。' : '检查该入口 fixture 与页面选择器后重试。',
      }
    }
    manifest.cases = manifest.cases.map((item: BaselineCase) => item.caseId === result.caseId ? result : item)
    mkdirSync(runDir, { recursive: true })
    writeAcceptanceManifest(manifest, resolve(runDir, 'matrix.json'))
    await testInfo.attach(`${caseId}-evidence`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
  }

  expect(manifest.cases).toHaveLength(22)
  expect(new Set(manifest.cases.map(item => item.caseId)).size).toBe(22)
  writeAcceptanceManifest(manifest, resolve(runDir, 'run.json'))
})
