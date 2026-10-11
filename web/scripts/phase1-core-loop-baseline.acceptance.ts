import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Page } from '@playwright/test'

export const BASELINE_SCHEMA = 'phase1-core-loop-baseline-v1' as const
const SECRET_KEY = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|session)/i
const SECRET_VALUE = /(bearer\s+)[a-z0-9._~+/=-]+/gi
const LONG_CREDENTIAL = /\b(?:sk|ghp|github_pat|xox[baprs])_[a-z0-9_-]{12,}\b/gi
const SECRET_ASSIGNMENT = /((?:authorization|cookie|password|passwd|secret|token|api[-_]?key|session)\s*[:=]\s*)(?!\[REDACTED\])(?:bearer\s+)?[^,;&\s]+/gi
const UNVERIFIED_FAILURE = {
  summary: '尚未运行该验收项。',
  nextStep: '在隔离环境运行对应入口旅程。',
} as const

export const BASELINE_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow-485', width: 485, height: 724 },
  { name: 'narrow-390', width: 390, height: 844 },
] as const

export const BASELINE_CASES = [
  ['BB-01', 'bb', '新世界创建/场景检查'], ['BB-02', 'bb', '2D 与真实世界/室内空间'],
  ['BB-03', 'bb', '传话事实一致性'], ['BB-04', 'bb', '访客认领重试'], ['BB-05', 'bb', 'Fork 弹窗'],
  ['BB-06', 'bb', 'Fork 过期恢复'], ['BB-07', 'bb', 'pane 恢复'], ['BB-08', 'bb', '时间线同步'],
  ['BB-09', 'bb', '访客时区'], ['BB-10', 'bb', '人物推断标记'], ['BB-11', 'bb', '示例生成失败'],
  ['BB-12', 'bb', '窄屏工具条'], ['BB-13', 'bb', '无人地点状态'], ['BB-14', 'bb', '时间叙述'],
  ['BB-15', 'bb', 'What-if 入口'], ['BB-16', 'bb', '工程字段暴露'], ['BB-17', 'bb', '首次到场叙述'],
  ['BB-18', 'bb', 'paused/archived 状态'],
  ['supplemental-registration-claim', 'supplemental', '注册后自动认领'],
  ['supplemental-guest-timezone', 'supplemental', '访客时区显示'],
  ['supplemental-interior-3d', 'supplemental', '室内 3D'],
  ['supplemental-timeline-display', 'supplemental', '时间线显示'],
] as const

export type BaselineStatus = 'passed' | 'failed' | 'unverified'
export type BaselineCase = {
  caseId: string
  category: 'bb' | 'supplemental'
  entry: string
  identity: string
  context: { worldId: string | null; timelineId: string | null; spaceId: string | null; simNow: string | null }
  status: BaselineStatus
  http: Array<{ method: string; path: string; status: number }>
  page: { url: string | null; labels: string[]; screenshotPath?: string }
  evidencePaths: string[]
  failure?: { summary: string; nextStep: string }
}

export type BaselineRunManifest = {
  schema: typeof BASELINE_SCHEMA
  runId: string
  gitSha: string
  startedAt: string
  environment: { runner: string; viewportSet: string[]; dataMode: string }
  cases: BaselineCase[]
  cleanup: { servicesStopped: boolean; tempPathsRemoved: boolean; attempted?: boolean; errors?: string[] }
  redaction: { status: 'passed' | 'failed'; patterns: string[]; findings?: string[] }
}

export function createAcceptanceCase([caseId, category, entry]: (typeof BASELINE_CASES)[number]): BaselineCase {
  return {
    caseId, category, entry, identity: 'unverified',
    context: { worldId: null, timelineId: null, spaceId: null, simNow: null },
    status: 'unverified', http: [], page: { url: null, labels: [] }, evidencePaths: [],
    failure: { ...UNVERIFIED_FAILURE },
  }
}

export function createAcceptanceManifest(runId: string, gitSha = 'unknown'): BaselineRunManifest {
  return {
    schema: BASELINE_SCHEMA, runId, gitSha, startedAt: new Date().toISOString(),
    environment: {
      runner: typeof process !== 'undefined' && process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
      viewportSet: BASELINE_VIEWPORTS.map(viewport => `${viewport.name}:${viewport.width}x${viewport.height}`),
      dataMode: typeof process !== 'undefined' ? process.env.PLAYWRIGHT_API_DATA_MODE ?? 'baseline' : 'baseline',
    },
    cases: BASELINE_CASES.map(createAcceptanceCase),
    cleanup: { servicesStopped: false, tempPathsRemoved: false, attempted: false, errors: [] },
    redaction: { status: 'passed', patterns: ['credential-key', 'bearer', 'provider-key'] },
  }
}

function redact(value: unknown): any {
  if (typeof value === 'string') {
    return value.replace(SECRET_ASSIGNMENT, '$1[REDACTED]').replace(SECRET_VALUE, '$1[REDACTED]').replace(LONG_CREDENTIAL, '[REDACTED]')
  }
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : redact(item)]))
  }
  return value
}

export function scanForSecrets(value: unknown): { passed: boolean; findings: string[] } {
  const strings: string[] = []
  const collect = (item: unknown): void => {
    if (typeof item === 'string') strings.push(item)
    else if (Array.isArray(item)) item.forEach(collect)
    else if (item && typeof item === 'object') Object.values(item).forEach(collect)
  }
  collect(value)
  const bearerFound = strings.some(item => new RegExp(SECRET_VALUE.source, 'i').test(item))
  const providerKeyFound = strings.some(item => new RegExp(LONG_CREDENTIAL.source, 'i').test(item))
  const assignmentFound = strings.some(item => {
    const match = item.match(new RegExp(SECRET_ASSIGNMENT.source, 'i'))
    return Boolean(match && !match[0].includes('[REDACTED]'))
  })
  return {
    passed: !bearerFound && !providerKeyFound && !assignmentFound,
    findings: [bearerFound ? 'bearer-value' : null, providerKeyFound ? 'provider-key' : null, assignmentFound ? 'credential-assignment' : null].filter((item): item is string => Boolean(item)),
  }
}

export function validateAcceptanceManifest(manifest: unknown): { passed: boolean; errors: string[] } {
  const errors: string[] = []
  if (!manifest || typeof manifest !== 'object') errors.push('manifest is not an object')
  const candidate = manifest as Partial<BaselineRunManifest> | null
  if (candidate?.schema !== BASELINE_SCHEMA) errors.push(`schema must be ${BASELINE_SCHEMA}`)
  const cases = Array.isArray(candidate?.cases) ? candidate.cases : []
  if (cases.length !== BASELINE_CASES.length) errors.push(`expected ${BASELINE_CASES.length} cases, got ${cases.length}`)
  const expectedIds = new Set<string>(BASELINE_CASES.map(([caseId]) => caseId))
  const seen = new Set<string>()
  for (const item of cases) {
    if (!item || typeof item !== 'object') {
      errors.push('case is not an object')
      continue
    }
    const result = item as BaselineCase
    if (seen.has(result.caseId)) errors.push(`duplicate caseId: ${result.caseId}`)
    seen.add(result.caseId)
    if (!expectedIds.has(result.caseId)) errors.push(`unknown caseId: ${result.caseId}`)
    if (!['passed', 'failed', 'unverified'].includes(result.status)) errors.push(`invalid status for ${result.caseId}`)
    if (result.status === 'unverified' && (!result.failure || !result.failure.summary || !result.failure.nextStep)) errors.push(`unverified case ${result.caseId} must explain its next step`)
    if (result.status === 'passed') {
      const hasHttp = Array.isArray(result.http) && result.http.length > 0
      const hasPage = Boolean(result.page && (result.page.url || (Array.isArray(result.page.labels) && result.page.labels.length > 0)))
      if (!hasHttp && !hasPage) errors.push(`passed case ${result.caseId} has no observable evidence`)
    }
    if (!result.page || !Array.isArray(result.page.labels)) errors.push(`case ${result.caseId} has invalid page evidence`)
    if (!Array.isArray(result.http) || !Array.isArray(result.evidencePaths)) errors.push(`case ${result.caseId} has invalid evidence arrays`)
  }
  if (seen.size !== expectedIds.size) errors.push('case set does not contain every baseline case')
  const scan = scanForSecrets(manifest)
  if (!scan.passed) errors.push(`secret scan failed: ${scan.findings.join(', ')}`)
  return { passed: errors.length === 0, errors }
}

export async function collectPageEvidence(page: Page, { screenshotPath }: { screenshotPath?: string } = {}) {
  const labels = await page.locator('body').innerText().catch(() => '')
  const result: { url: string | null; labels: string[]; screenshotPath?: string } = {
    url: redact(page.url() || null),
    labels: labels.split(/\r?\n/).map(label => redact(label.trim())).filter(Boolean).slice(0, 80),
  }
  if (screenshotPath) {
    mkdirSync(dirname(screenshotPath), { recursive: true })
    await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' })
    result.screenshotPath = screenshotPath
    statSync(screenshotPath)
  }
  return result
}

export function writeAcceptanceManifest(manifest: BaselineRunManifest, outputPath: string) {
  const safeManifest = redact(manifest) as BaselineRunManifest
  const scan = scanForSecrets(safeManifest)
  if (!scan.passed) throw new Error(`Refusing to write acceptance manifest containing secrets: ${scan.findings.join(', ')}`)
  safeManifest.redaction = { ...safeManifest.redaction, status: 'passed', findings: scan.findings }
  for (const item of safeManifest.cases) {
    const relativePath = `cases/${item.caseId}.json`
    if (!item.evidencePaths.includes(relativePath)) item.evidencePaths.push(relativePath)
  }
  const validation = validateAcceptanceManifest(safeManifest)
  if (!validation.passed) throw new Error(`Invalid phase 1 baseline manifest: ${validation.errors.join('; ')}`)
  const absoluteOutputPath = resolve(outputPath)
  const outputDirectory = dirname(absoluteOutputPath)
  mkdirSync(outputDirectory, { recursive: true })
  for (const item of safeManifest.cases) {
    const casePath = resolve(outputDirectory, 'cases', `${item.caseId}.json`)
    mkdirSync(dirname(casePath), { recursive: true })
    writeFileSync(casePath, `${JSON.stringify({
      schema: `${BASELINE_SCHEMA}-case`,
      runId: safeManifest.runId,
      caseId: item.caseId,
      status: item.status,
      verified: item.status === 'passed',
      page: item.page,
      http: item.http,
      failure: item.failure,
    }, null, 2)}\n`, { mode: 0o600 })
  }
  writeFileSync(absoluteOutputPath, `${JSON.stringify(safeManifest, null, 2)}\n`, { mode: 0o600 })
  return absoluteOutputPath
}

/**
 * Page journeys are added by T13-T15. Keeping the runner deterministic here
 * makes every not-yet-implemented case explicit instead of implying success.
 */
export async function runAcceptance({ runId = `phase1-baseline-${Date.now()}`, gitSha, outputPath, page, pageEvidenceCaseId = BASELINE_CASES[0][0], screenshotPath }: { runId?: string; gitSha?: string; outputPath?: string; page?: Page; pageEvidenceCaseId?: string; screenshotPath?: string } = {}) {
  const manifest = createAcceptanceManifest(runId, gitSha)
  if (page) {
    const targetCase = manifest.cases.find(item => item.caseId === pageEvidenceCaseId)
    if (!targetCase) throw new Error(`Unknown page evidence case: ${pageEvidenceCaseId}`)
    targetCase.page = await collectPageEvidence(page, { screenshotPath })
    // Page observations are evidence only; they never imply that a journey passed.
    targetCase.status = 'unverified'
    targetCase.failure = { summary: '页面已连接，尚未编排完整旅程。', nextStep: '补充该 case 的确定性入口操作。' }
  }
  const validation = validateAcceptanceManifest(manifest)
  if (!validation.passed) throw new Error(`Invalid phase 1 baseline manifest: ${validation.errors.join('; ')}`)
  if (outputPath) writeAcceptanceManifest(manifest, outputPath)
  return manifest
}

