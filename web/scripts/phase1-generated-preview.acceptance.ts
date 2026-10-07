import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { chromium, type BrowserContext, type Page } from '@playwright/test'

const evidencePath = process.env.G0_EVIDENCE_FILE
const previewUrl = process.env.PHASE1_PREVIEW_URL ?? 'http://127.0.0.1:15176'
const runnerTemp = process.env.RUNNER_TEMP ?? '/tmp'
const resident = { id: 'phase1-preview-resident', name: '阶段一验收居民', createdAt: '2026-01-01T00:00:00.000Z' }

interface GeneratedDraft {
  world: {
    name: string
    description: string
    locations: { name: string; description: string }[]
  }
  document: {
    size: { width: number; height: number; depth: number }
    objects: { id: string; objectType: string; anchor?: { x: number; y: number; z: number } }[]
    locations: { name: string; description?: string; objectId: string }[]
    assetPlacements?: { id: string; assetId: string; anchor: [number, number, number] }[]
  }
}

interface AcceptanceArtifact {
  schema: string
  workflowRunId: string
  commit: string
  passed: boolean
  generatedDrafts: Record<string, GeneratedDraft>
}

interface PreviewResult {
  scenarioId: string
  worldName: string
  worldDescription: string
  locations: GeneratedDraft['world']['locations']
  documentSha256: string
  locationBindings: {
    name: string
    objectId: string
    carrier: 'object' | 'asset-placement' | 'unresolved'
    objectType?: string
    assetId?: string
    anchor?: { x: number; y: number; z: number }
  }[]
  screenshots: { overview: string; overviewBytes: number; alternate: string; alternateBytes: number }
  render: 'ready' | 'failed'
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function inspectBindings(draft: GeneratedDraft): PreviewResult['locationBindings'] {
  const objects = new Map(draft.document.objects.map(object => [object.id, object]))
  const placements = new Map((draft.document.assetPlacements ?? []).map(placement => [placement.id, placement]))
  return draft.document.locations.map(location => {
    const object = objects.get(location.objectId)
    if (object) return {
      name: location.name,
      objectId: location.objectId,
      carrier: 'object',
      objectType: object.objectType,
      ...(object.anchor ? { anchor: object.anchor } : {}),
    }
    const placement = placements.get(location.objectId)
    if (placement) return {
      name: location.name,
      objectId: location.objectId,
      carrier: 'asset-placement',
      assetId: placement.assetId,
      anchor: { x: placement.anchor[0], y: placement.anchor[1], z: placement.anchor[2] },
    }
    return { name: location.name, objectId: location.objectId, carrier: 'unresolved' }
  })
}

async function installApiStubs(context: BrowserContext, draft: GeneratedDraft, apiRequests: string[]): Promise<void> {
  await context.route('**/api/**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    apiRequests.push(`${request.method()} ${pathname}`)
    if (pathname === '/api/persons' && request.method() === 'GET') {
      await route.fulfill({ json: { persons: [resident] } })
      return
    }
    if (pathname === '/api/scene-drafts/voxel' && request.method() === 'POST') {
      await route.fulfill({ json: { world: draft.world, document: draft.document, explanation: '阶段一真实生成稿只读预览。', warnings: [], callsUsed: 0 } })
      return
    }
    await route.fulfill({ status: 404, json: { error: 'phase1_preview_api_isolated' } })
  })
}

async function previewScenario(context: BrowserContext, page: Page, scenarioId: string, draft: GeneratedDraft): Promise<PreviewResult> {
  const apiRequests: string[] = []
  await installApiStubs(context, draft, apiRequests)
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'phase1-preview-only'))
  const landing = await page.goto(new URL('/worlds/new', previewUrl).toString())
  assert(landing?.ok(), `preview returned HTTP ${landing?.status() ?? 'no response'} for ${scenarioId}`)
  await page.getByRole('button', { name: resident.name }).waitFor({ state: 'visible', timeout: 15_000 })
  await page.getByTestId('scene-prompt').fill(`${draft.world.name}。${draft.world.description}`.slice(0, 1100))
  await page.getByRole('button', { name: resident.name }).click()
  await page.getByTestId('generate-scene').click()
  await page.getByTestId('voxel-create-workspace').waitFor({ state: 'visible', timeout: 30_000 })
  const canvas = page.getByTestId('voxel-viewport-canvas')
  await canvas.waitFor({ state: 'visible', timeout: 15_000 })
  await page.getByTestId('voxel-viewport-loading').waitFor({ state: 'hidden', timeout: 30_000 })
  await page.waitForFunction(() => {
    const engine = (window as Window & { __voxelEngine?: { world?: unknown; getOrbitPose?: () => unknown } }).__voxelEngine
    return Boolean(engine?.world && engine.getOrbitPose?.())
  }, undefined, { timeout: 15_000 })
  assert(apiRequests.includes('GET /api/persons'), `${scenarioId} did not read the isolated resident list`)
  assert(apiRequests.includes('POST /api/scene-drafts/voxel'), `${scenarioId} did not request the generated draft`)
  assert(apiRequests.every(path => path === 'GET /api/persons' || path === 'POST /api/scene-drafts/voxel'),
    `${scenarioId} attempted an API outside the read-only preview stubs`)

  const screenshotBase = resolve(runnerTemp, `phase1-generated-${scenarioId}`)
  const overviewPath = `${screenshotBase}-overview.png`
  const alternatePath = `${screenshotBase}-alternate.png`
  await page.screenshot({ path: overviewPath, fullPage: true, animations: 'disabled' })
  const overviewBytes = statSync(overviewPath).size
  assert(overviewBytes > 10_000, `${scenarioId} overview screenshot is unexpectedly small (${overviewBytes} bytes)`)
  const alternateSet = await page.evaluate(() => {
    const engine = (window as Window & { __voxelEngine?: {
      getOrbitPose: () => { theta: number; phi: number; distance: number; target: { x: number; y: number; z: number } } | null
      setOrbitPose: (pose: { theta: number; phi: number; distance: number; target: { x: number; y: number; z: number } }) => void
    } }).__voxelEngine
    const pose = engine?.getOrbitPose()
    if (!pose || !engine) return false
    engine.setOrbitPose({ ...pose, theta: pose.theta + Math.PI / 3 })
    return true
  })
  assert(alternateSet, `${scenarioId} did not expose the orbit camera probe`)
  await page.waitForTimeout(350)
  await page.screenshot({ path: alternatePath, fullPage: true, animations: 'disabled' })
  const alternateBytes = statSync(alternatePath).size
  assert(alternateBytes > 10_000, `${scenarioId} alternate screenshot is unexpectedly small (${alternateBytes} bytes)`)
  assert(apiRequests.every(path => path === 'GET /api/persons' || path === 'POST /api/scene-drafts/voxel'),
    `${scenarioId} attempted an API outside the read-only preview stubs`)

  return {
    scenarioId,
    worldName: draft.world.name,
    worldDescription: draft.world.description,
    locations: draft.world.locations,
    documentSha256: sha256(JSON.stringify(draft.document)),
    locationBindings: inspectBindings(draft),
    // The source hash identifies the exact archived document returned by the isolated draft API stub.
    screenshots: { overview: overviewPath, overviewBytes, alternate: alternatePath, alternateBytes },
    render: 'ready',
  }
}

async function main(): Promise<void> {
  assert(evidencePath, 'G0_EVIDENCE_FILE is required')
  const artifact = JSON.parse(readFileSync(evidencePath, 'utf8')) as AcceptanceArtifact
  assert(artifact.schema === 'phase1-g0-provider-acceptance-v1', 'unsupported phase 1 provider evidence schema')
  const scenarioIds = Object.keys(artifact.generatedDrafts ?? {}).sort()
  assert(scenarioIds.length > 0, 'provider acceptance artifact contains no generated drafts')
  mkdirSync(runnerTemp, { recursive: true })

  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--no-sandbox'] })
  const previews: PreviewResult[] = []
  try {
    for (const scenarioId of scenarioIds) {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
      try {
        const page = await context.newPage()
        previews.push(await previewScenario(context, page, scenarioId, artifact.generatedDrafts[scenarioId]))
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }

  const report = {
    schema: 'phase1-generated-preview-acceptance-v1',
    source: {
      schema: artifact.schema,
      workflowRunId: artifact.workflowRunId,
      commit: artifact.commit,
      providerAcceptancePassed: artifact.passed,
      artifactSha256: sha256(JSON.stringify(artifact)),
    },
    previewUrl,
    semanticVerdict: 'manual-review-required',
    previews,
  }
  const reportPath = resolve(runnerTemp, 'phase1-generated-preview.json')
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${reportPath}\n`)
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
