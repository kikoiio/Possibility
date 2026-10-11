import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { BASELINE_CASES } from '../scripts/phase1-core-loop-baseline.acceptance'
import { createPresentationFixtures, installPresentationFixtures } from './presentation.fixtures'

// The matrix intentionally opens the voxel map for most cases. Keep those
// observations in one worker so baseline collection does not fan out WebGL
// pages across the machine.
test.describe.configure({ mode: 'serial' })

/**
 * Phase 0 records an observable current-version baseline without claiming that
 * an unimplemented journey passed. Each case gets a real page URL, visible
 * labels, and the API responses observed while loading that entry.
 */
type HttpEvidence = { method: string; path: string; status: number }
type PageEvidence = { url: string; labels: string[] }
type BaselineDefinition = { caseId: string; category: 'bb' | 'supplemental'; entry: string }
type CaseEvidence = {
  schema: 'phase1-core-loop-baseline-v1-case'
  caseId: string
  category: BaselineDefinition['category']
  entry: string
  status: 'passed' | 'failed' | 'unverified'
  identity: 'owner'
  context: { worldId: string | null; timelineId: string | null; spaceId: string | null; simNow: string | null }
  page: PageEvidence
  http: HttpEvidence[]
  failure?: { summary: string; nextStep: string }
}
const OWNER_WORLD = 'presentation-world-a'
const OWNER_TIMELINE = 'presentation-world-a-main'
const OWNER_SIM_NOW = '2026-10-01T08:00:00.000Z'
const BASELINE_DEFINITIONS = BASELINE_CASES.map(([caseId, category, entry]) => ({ caseId, category, entry })) as BaselineDefinition[]

function entryTarget(caseId: string): string {
  if (caseId === 'BB-01') return '/worlds/new'
  if (caseId === 'supplemental-registration-claim') return '/worlds/new?person=phase0-registration'
  if (caseId === 'supplemental-guest-timezone') return `/worlds/${OWNER_WORLD}?timezone=Asia/Tokyo`
  if (caseId === 'supplemental-interior-3d') return `/worlds/${OWNER_WORLD}?space=interior`
  if (caseId === 'supplemental-timeline-display') return `/worlds/${OWNER_WORLD}?timeline=${OWNER_TIMELINE}`
  if (caseId === 'BB-15') return `/worlds/${OWNER_WORLD}?mode=possibility&timeline=${OWNER_TIMELINE}`
  return `/worlds/${OWNER_WORLD}?baseline=${encodeURIComponent(caseId)}`
}

async function installNewWorldFixture(page: Page) {
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'phase0-baseline-token'))
  await page.route('**/api/persons', route => route.fulfill({ json: {
    persons: [{ id: 'phase0-registration', name: '基线居民', createdAt: '2026-01-01T00:00:00.000Z' }],
  } }))
}

async function installCaseFixture(page: Page, caseId: string) {
  if (caseId === 'BB-01' || caseId === 'supplemental-registration-claim') {
    await installNewWorldFixture(page)
    return
  }
  await installPresentationFixtures(page, createPresentationFixtures({ leftIdentity: 'owner', rightIdentity: 'readonly' }))
}

function redactPath(url: string): string {
  const parsed = new URL(url)
  return `${parsed.pathname}${parsed.search ? '?query' : ''}`
}

async function collectCaseEvidence(
  page: Page,
  testInfo: TestInfo,
  definition: BaselineDefinition,
  http: HttpEvidence[],
  outcome: { status: 'unverified' | 'failed'; failure: { summary: string; nextStep: string } },
): Promise<void> {
  const labels = await page.locator('body').innerText().catch(() => '')
  const evidence: CaseEvidence = {
    schema: 'phase1-core-loop-baseline-v1-case',
    caseId: definition.caseId,
    category: definition.category,
    entry: definition.entry,
    status: outcome.status,
    identity: 'owner',
    context: {
      worldId: definition.caseId === 'BB-01' || definition.caseId === 'supplemental-registration-claim' ? null : OWNER_WORLD,
      timelineId: definition.caseId === 'BB-01' || definition.caseId === 'supplemental-registration-claim' ? null : OWNER_TIMELINE,
      spaceId: definition.caseId === 'supplemental-interior-3d' ? 'interior' : definition.caseId === 'BB-01' || definition.caseId === 'supplemental-registration-claim' ? null : 'exterior',
      simNow: definition.caseId === 'BB-01' || definition.caseId === 'supplemental-registration-claim' ? null : OWNER_SIM_NOW,
    },
    page: {
      url: page.url(),
      labels: labels.split(/\r?\n/).map(item => item.trim()).filter(Boolean).slice(0, 80),
    },
    http: http.slice(0, 80),
    failure: outcome.failure,
  }
  const outputDir = process.env.PHASE1_BASELINE_EVIDENCE_DIR
  if (outputDir) {
    const outputPath = resolve(outputDir, `${definition.caseId}.json`)
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  }
  await testInfo.attach('baseline-evidence.json', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  })
}
for (const definition of BASELINE_DEFINITIONS) {
  test(`${definition.caseId} ${definition.entry} records page and HTTP evidence`, async ({ page }, testInfo) => {
    const http: HttpEvidence[] = []
    page.on('response', response => {
      const url = response.url()
      if (!new URL(url).pathname.startsWith('/api/')) return
      http.push({ method: response.request().method(), path: redactPath(url), status: response.status() })
    })

    try {
      await installCaseFixture(page, definition.caseId)
      await page.goto(entryTarget(definition.caseId))
      await expect(page.locator('body')).not.toBeEmpty()
      expect(http.length).toBeGreaterThan(0)
      await collectCaseEvidence(page, testInfo, definition, http, {
        status: 'unverified',
        failure: {
          summary: '阶段 0 仅采集当前入口的页面和 HTTP 证据，完整旅程尚未编排。',
          nextStep: '在隔离环境执行该条目的专用确定性旅程，并将结果更新为 passed 或 failed。',
        },
      })
    } catch (error) {
      await collectCaseEvidence(page, testInfo, definition, http, {
        status: 'failed',
        failure: {
          summary: `入口证据采集失败：${error instanceof Error ? error.message : String(error)}`,
          nextStep: '检查该入口的隔离 route fixture 和页面加载错误后重新采集。',
        },
      })
      throw error
    }
  })
}
