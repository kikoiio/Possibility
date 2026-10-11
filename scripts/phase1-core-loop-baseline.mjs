import { execFileSync, spawn } from 'node:child_process'
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const BASELINE_SCHEMA = 'phase1-core-loop-baseline-v1'
export const VIEWPORTS = Object.freeze([
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow-485', width: 485, height: 724 },
  { name: 'narrow-390', width: 390, height: 844 },
])

export const BASELINE_CASES = Object.freeze([
  ['BB-01', 'bb', '新世界创建/场景检查'],
  ['BB-02', 'bb', '2D 与真实世界/室内空间'],
  ['BB-03', 'bb', '传话事实一致性'],
  ['BB-04', 'bb', '访客认领重试'],
  ['BB-05', 'bb', 'Fork 弹窗'],
  ['BB-06', 'bb', 'Fork 过期恢复'],
  ['BB-07', 'bb', 'pane 恢复'],
  ['BB-08', 'bb', '时间线同步'],
  ['BB-09', 'bb', '访客时区'],
  ['BB-10', 'bb', '人物推断标记'],
  ['BB-11', 'bb', '示例生成失败'],
  ['BB-12', 'bb', '窄屏工具条'],
  ['BB-13', 'bb', '无人地点状态'],
  ['BB-14', 'bb', '时间叙述'],
  ['BB-15', 'bb', 'What-if 入口'],
  ['BB-16', 'bb', '工程字段暴露'],
  ['BB-17', 'bb', '首次到场叙述'],
  ['BB-18', 'bb', 'paused/archived 状态'],
  ['supplemental-registration-claim', 'supplemental', '注册后自动认领'],
  ['supplemental-guest-timezone', 'supplemental', '访客时区显示'],
  ['supplemental-interior-3d', 'supplemental', '室内 3D'],
  ['supplemental-timeline-display', 'supplemental', '时间线显示'],
].map(([caseId, category, entry]) => Object.freeze({ caseId, category, entry })))

const BASELINE_CASE_IDS = new Set(BASELINE_CASES.map(({ caseId }) => caseId))
const CASE_EVIDENCE_DIR = 'cases'
const UNVERIFIED_FAILURE = Object.freeze({
  summary: '尚未运行该验收项。',
  nextStep: '在隔离环境运行对应入口旅程。',
})

const SECRET_KEY = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|session)/i
const SECRET_VALUE = /(bearer\s+)[a-z0-9._~+/=-]+/gi
const LONG_CREDENTIAL = /\b(?:sk|ghp|github_pat|xox[baprs])_[a-z0-9_-]{12,}\b/gi
const SECRET_ASSIGNMENT = /((?:authorization|cookie|password|passwd|secret|token|api[-_]?key|session)\s*[:=]\s*)(?!\[REDACTED\])(?:bearer\s+)?[^,;]+/gi

export function redact(value) {
  if (typeof value === 'string') {
    return value.replace(SECRET_ASSIGNMENT, '$1[REDACTED]').replace(SECRET_VALUE, '$1[REDACTED]').replace(LONG_CREDENTIAL, '[REDACTED]')
  }
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? '[REDACTED]' : redact(item),
    ]))
  }
  return value
}

export function scanForSecrets(value) {
  const strings = []
  const collectStrings = item => {
    if (typeof item === 'string') strings.push(item)
    else if (Array.isArray(item)) item.forEach(collectStrings)
    else if (item && typeof item === 'object') Object.values(item).forEach(collectStrings)
  }
  collectStrings(value)
  const bearerFound = strings.some(string => new RegExp(SECRET_VALUE.source, 'i').test(string))
  const providerKeyFound = strings.some(string => new RegExp(LONG_CREDENTIAL.source, 'i').test(string))
  const assignmentFound = strings.some(string => {
    const match = string.match(new RegExp(SECRET_ASSIGNMENT.source, 'i'))
    return Boolean(match && !match[0].includes('[REDACTED]'))
  })
  return {
    passed: !bearerFound && !providerKeyFound && !assignmentFound,
    findings: [
      bearerFound ? 'bearer-value' : null,
      providerKeyFound ? 'provider-key' : null,
      assignmentFound ? 'credential-assignment' : null,
    ].filter(Boolean),
  }
}

export function createCaseSkeleton(definition, { evidencePath } = {}) {
  return {
    caseId: definition.caseId,
    category: definition.category,
    entry: definition.entry,
    identity: 'unverified',
    context: { worldId: null, timelineId: null, spaceId: null, simNow: null },
    status: 'unverified',
    http: [],
    page: { url: null, labels: [] },
    evidencePaths: evidencePath ? [evidencePath] : [],
    failure: { ...UNVERIFIED_FAILURE },
  }
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function makeRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `phase1-baseline-${stamp}-${process.pid}`
}

export function createManifest({ runId = makeRunId(), startedAt = new Date().toISOString(), runner = process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local', dataMode = process.env.PLAYWRIGHT_API_DATA_MODE ?? 'baseline', cases = BASELINE_CASES.map(createCaseSkeleton) } = {}) {
  return redact({
    schema: BASELINE_SCHEMA,
    runId,
    gitSha: gitSha(),
    startedAt,
    environment: {
      runner,
      dataMode,
      viewportSet: VIEWPORTS.map(({ name, width, height }) => `${name}:${width}x${height}`),
    },
    cases,
    cleanup: {
      servicesStopped: false,
      tempPathsRemoved: false,
      attempted: false,
      errors: [],
    },
    redaction: { status: 'passed', patterns: ['credential-key', 'bearer', 'provider-key'] },
  })
}

/**
 * Keep the evidence contract strict enough that a partially populated matrix
 * cannot be mistaken for a completed acceptance run.
 */
export function validateManifest(manifest) {
  const errors = []
  if (!manifest || typeof manifest !== 'object') errors.push('manifest is not an object')
  if (manifest?.schema !== BASELINE_SCHEMA) errors.push(`schema must be ${BASELINE_SCHEMA}`)
  const cases = Array.isArray(manifest?.cases) ? manifest.cases : []
  if (cases.length !== BASELINE_CASES.length) errors.push(`expected ${BASELINE_CASES.length} cases, got ${cases.length}`)
  const seen = new Set()
  for (const item of cases) {
    if (!item || typeof item !== 'object') {
      errors.push('case is not an object')
      continue
    }
    if (seen.has(item.caseId)) errors.push(`duplicate caseId: ${item.caseId}`)
    seen.add(item.caseId)
    if (!BASELINE_CASE_IDS.has(item.caseId)) errors.push(`unknown caseId: ${item.caseId}`)
    if (!['bb', 'supplemental'].includes(item.category)) errors.push(`invalid category for ${item.caseId}`)
    if (!['passed', 'failed', 'unverified'].includes(item.status)) errors.push(`invalid status for ${item.caseId}`)
    if (item.status === 'unverified' && (!item.failure || typeof item.failure.summary !== 'string' || typeof item.failure.nextStep !== 'string')) {
      errors.push(`unverified case ${item.caseId} must explain its next step`)
    }
    if (item.status === 'passed') {
      const hasHttp = Array.isArray(item.http) && item.http.length > 0
      const hasPage = Boolean(item.page && (item.page.url || (Array.isArray(item.page.labels) && item.page.labels.length > 0)))
      if (!hasHttp && !hasPage) errors.push(`passed case ${item.caseId} has no observable evidence`)
    }
    if (!item.page || !Array.isArray(item.page.labels)) errors.push(`case ${item.caseId} has invalid page evidence`)
    if (!Array.isArray(item.http) || !Array.isArray(item.evidencePaths)) errors.push(`case ${item.caseId} has invalid evidence arrays`)
  }
  if (seen.size !== BASELINE_CASE_IDS.size) errors.push('case set does not contain every baseline case')
  const redaction = scanForSecrets(manifest)
  if (!redaction.passed) errors.push(`secret scan failed: ${redaction.findings.join(', ')}`)
  return { passed: errors.length === 0, errors }
}

export function assertValidManifest(manifest) {
  const result = validateManifest(manifest)
  if (!result.passed) throw new Error(`Invalid phase 1 baseline manifest: ${result.errors.join('; ')}`)
  return manifest
}

function parseArgs(argv) {
  const options = { mode: 'dry-run', outputDir: process.env.PHASE1_BASELINE_OUTPUT_DIR ?? 'artifacts/phase1-core-loop' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--list') options.mode = 'list'
    else if (arg === '--dry-run') options.mode = 'dry-run'
    else if (arg === '--run') options.mode = 'run'
    else if (arg === '--output-dir') options.outputDir = argv[++index] ?? options.outputDir
    else if (arg === '--help' || arg === '-h') options.mode = 'help'
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

function writeJson(filePath, value) {
  const safeValue = redact(value)
  const scan = scanForSecrets(safeValue)
  if (!scan.passed) throw new Error(`Refusing to write evidence containing secrets: ${scan.findings.join(', ')}`)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(safeValue, null, 2)}\n`, { mode: 0o600 })
}

function materializeCaseEvidence(runDir, manifest) {
  for (const item of manifest.cases) {
    const relativePath = join(CASE_EVIDENCE_DIR, `${item.caseId}.json`)
    if (!item.evidencePaths.includes(relativePath)) item.evidencePaths.push(relativePath)
    writeJson(join(runDir, relativePath), {
      schema: `${BASELINE_SCHEMA}-case`,
      runId: manifest.runId,
      caseId: item.caseId,
      status: item.status,
      verified: item.status === 'passed',
      page: item.page,
      failure: item.failure,
    })
  }
}

function writeRunArtifacts(runDir, manifest) {
  const validation = validateManifest(manifest)
  if (!validation.passed) throw new Error(`Invalid phase 1 baseline manifest: ${validation.errors.join('; ')}`)
  materializeCaseEvidence(runDir, manifest)
  const safeManifest = redact(manifest)
  const scan = scanForSecrets(safeManifest)
  if (!scan.passed) throw new Error(`Refusing to write baseline manifest containing secrets: ${scan.findings.join(', ')}`)
  safeManifest.redaction = {
    ...safeManifest.redaction,
    status: scan.passed ? 'passed' : 'failed',
    findings: scan.findings,
  }
  writeJson(join(runDir, 'run.json'), safeManifest)
  writeJson(join(runDir, 'matrix.json'), safeManifest)
}

function listOutput() {
  return {
    schema: BASELINE_SCHEMA,
    caseCount: BASELINE_CASES.length,
    bbCount: BASELINE_CASES.filter(item => item.category === 'bb').length,
    supplementalCount: BASELINE_CASES.filter(item => item.category === 'supplemental').length,
    viewports: VIEWPORTS,
    cases: BASELINE_CASES,
  }
}

function commandFromEnv(name) {
  const command = process.env[name]
  return command ? { command, args: [], shell: true } : null
}

async function startOptionalServices() {
  const services = []
  for (const name of ['PHASE1_API_START_COMMAND', 'PHASE1_WEB_START_COMMAND']) {
    const spec = commandFromEnv(name)
    if (!spec) continue
    const child = spawn(spec.command, spec.args, { shell: spec.shell, stdio: 'inherit', env: { ...process.env, PHASE1_BASELINE_SERVICES: 'true' } })
    services.push(child)
  }
  return services
}

async function stopServices(services) {
  for (const service of services) {
    if (!service || service.exitCode !== null) continue
    service.kill('SIGTERM')
  }
  await Promise.all(services.map(service => new Promise(resolveService => {
    if (!service || service.exitCode !== null) return resolveService()
    service.once('close', resolveService)
    setTimeout(() => {
      if (service.exitCode === null) service.kill('SIGKILL')
      resolveService()
    }, 2_000).unref()
  })))
}

export async function runBaseline({ outputRoot = process.env.PHASE1_BASELINE_OUTPUT_DIR ?? 'artifacts/phase1-core-loop', runId = makeRunId(), startServices = startOptionalServices } = {}) {
  const runDir = resolve(outputRoot, runId)
  const tempDir = join(runDir, 'tmp')
  mkdirSync(tempDir, { recursive: true })
  const manifest = createManifest({ runId })
  const services = []
  try {
    services.push(...await startServices())
    manifest.cleanup.attempted = true
    // The baseline runner intentionally records every unimplemented journey as
    // unverified. Page evidence can be attached later by the web acceptance
    // helper without changing this status.
    writeRunArtifacts(runDir, manifest)
    return { ...manifest, runDir }
  } catch (error) {
    manifest.cleanup.errors.push(error instanceof Error ? error.message : String(error))
    throw error
  } finally {
    await stopServices(services)
    manifest.cleanup.servicesStopped = true
    rmSync(tempDir, { recursive: true, force: true })
    manifest.cleanup.tempPathsRemoved = true
    writeRunArtifacts(runDir, manifest)
    writeJson(join(runDir, 'cleanup.json'), manifest.cleanup)
  }
}

export const runBaselineMatrix = runBaseline

function usage() {
  return 'Usage: node scripts/phase1-core-loop-baseline.mjs [--list|--dry-run|--run] [--output-dir <dir>]'
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.mode === 'help') return process.stdout.write(`${usage()}\n`)
  if (options.mode === 'list') return process.stdout.write(`${JSON.stringify(listOutput(), null, 2)}\n`)
  if (options.mode === 'dry-run') {
    const result = await runBaseline({ outputRoot: options.outputDir, startServices: async () => [] })
    return process.stdout.write(`${JSON.stringify({ mode: 'dry-run', runDir: result.runDir, ...listOutput() }, null, 2)}\n`)
  }
  const result = await runBaseline({ outputRoot: options.outputDir })
  return process.stdout.write(`${JSON.stringify({ mode: 'run', runDir: result.runDir, ...listOutput() }, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
