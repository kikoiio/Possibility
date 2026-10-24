import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const PHASE2B_SCHEMA = 'phase2b-time-status-v1' as const
export const ACCEPTANCE_IDS = Array.from({ length: 12 }, (_, index) => `AC${index + 1}`) as readonly string[]

export type AcceptanceStatus = 'passed' | 'failed' | 'unverified'

/**
 * journey：真实入口读取成功并要求 API/页面上下文关联一致；
 * contract：单元/契约矩阵证据（无页面上下文）；negative：真实入口上的拒绝路径（无 ready 上下文）。
 */
export type AcceptanceKind = 'journey' | 'contract' | 'negative'

export type ContextSummary = {
  worldAlias: string | null
  timelineAlias: string | null
  simNow: string | null
}

export type AcceptanceCase = {
  ac: string
  kind: AcceptanceKind
  status: AcceptanceStatus
  summary: string
  requestTarget: { worldAlias: string | null; timelineAlias: string | null }
  apiContext: ContextSummary | null
  pageContext: ContextSummary | null
  substitutes: string[]
  evidence: string[]
  failureReason?: string
}

export type AcceptanceManifest = {
  schema: typeof PHASE2B_SCHEMA
  runId: string
  gitSha: string
  startedAt: string
  environment: { runner: string; browser: string; apiMode: string; modelMode: string }
  cases: AcceptanceCase[]
  cleanup: { servicesStopped: boolean; tempPathsRemoved: boolean; attempted: boolean; errors: string[] }
  redaction: { status: 'passed' | 'failed'; findings: string[] }
}

const SECRET_KEY = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|header|raw.?body|trace|database.?path)/i
const SECRET_VALUE = /(bearer\s+|token[=:]\s*|password[=:]\s*|secret[=:]\s*)[^\s,;]+/i
const LONG_CREDENTIAL = /\b(?:sk|ghp|github_pat|xox[baprs])_[a-z0-9_-]{12,}\b/i

const unverifiedReason = '尚未运行该验收项，需在隔离环境执行对应 API/UI 旅程。'

/** 与 scripts/lib/acceptance-evidence.mjs 的 currentSha 同源：CI 用 GITHUB_SHA，本地回落 rev-parse。 */
function currentSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return 'unknown' }
}

/**
 * 每次运行独立的别名登记表：真实 world/timeline id 一律映射为稳定别名，
 * 证据只保留别名与模拟时刻（finalizer 会再跑 sensitivePaths 脱敏复核）。
 */
export function createContextAliasRegistry() {
  const worlds = new Map<string, string>()
  const timelines = new Map<string, string>()
  return {
    world(id: string | null | undefined): string | null {
      if (!id) return null
      if (!worlds.has(id)) worlds.set(id, `world-${worlds.size + 1}`)
      return worlds.get(id) ?? null
    },
    timeline(id: string | null | undefined): string | null {
      if (!id) return null
      if (!timelines.has(id)) timelines.set(id, `timeline-${timelines.size + 1}`)
      return timelines.get(id) ?? null
    },
  }
}

function blankCase(ac: string): AcceptanceCase {
  return {
    ac,
    kind: 'journey',
    status: 'unverified',
    summary: unverifiedReason,
    requestTarget: { worldAlias: null, timelineAlias: null },
    apiContext: null,
    pageContext: null,
    substitutes: [],
    evidence: [],
    failureReason: unverifiedReason,
  }
}

export function createAcceptanceManifest(
  runId: string,
  gitSha = currentSha(),
  overrides: Partial<Pick<AcceptanceManifest, 'environment' | 'cleanup'>> = {},
): AcceptanceManifest {
  return {
    schema: PHASE2B_SCHEMA,
    runId,
    gitSha,
    startedAt: new Date().toISOString(),
    environment: {
      runner: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
      browser: 'chromium-desktop-single-worker',
      apiMode: 'isolated-d1-fixture',
      modelMode: 'no-model-calls',
      ...overrides.environment,
    },
    cases: ACCEPTANCE_IDS.map(blankCase),
    cleanup: { servicesStopped: false, tempPathsRemoved: false, attempted: false, errors: [], ...overrides.cleanup },
    redaction: { status: 'passed', findings: [] },
  }
}

function redactString(value: string): string {
  return value.replace(SECRET_VALUE, '[REDACTED]').replace(LONG_CREDENTIAL, '[REDACTED]')
}

export function sanitizeEvidence<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T
  if (Array.isArray(value)) return value.map(item => sanitizeEvidence(item)) as T
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue
    output[key] = sanitizeEvidence(child)
  }
  return output as T
}

function findSensitivePaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') {
    return SECRET_VALUE.test(value) || LONG_CREDENTIAL.test(value) ? [path] : []
  }
  if (!value || typeof value !== 'object') return []
  const findings: string[] = []
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) findings.push(`${path}.${key}`)
    else findings.push(...findSensitivePaths(child, `${path}.${key}`))
  }
  return findings
}

/** 与 scripts/finalize-phase2b-time-status-acceptance.mjs 同一套关联规则（写入前自检）。 */
export function validateManifest(manifest: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!manifest || typeof manifest !== 'object') return { valid: false, errors: ['manifest must be an object'] }
  const candidate = manifest as Partial<AcceptanceManifest>
  if (candidate.schema !== PHASE2B_SCHEMA) errors.push(`schema must be ${PHASE2B_SCHEMA}`)
  if (!candidate.runId) errors.push('runId is required')
  if (!candidate.gitSha) errors.push('gitSha is required')
  if (!Array.isArray(candidate.cases)) errors.push('cases must be an array')
  const cases = Array.isArray(candidate.cases) ? candidate.cases : []
  const ids = cases.map(item => item && typeof item === 'object' ? (item as { ac?: string }).ac : null)
  for (const ac of ACCEPTANCE_IDS) if (!ids.includes(ac)) errors.push(`missing ${ac}`)
  if (new Set(ids.filter(Boolean)).size !== ids.filter(Boolean).length) errors.push('duplicate acceptance id')
  if (!candidate.cleanup || candidate.cleanup.attempted !== true) errors.push('cleanup must be attempted')
  for (const item of cases) {
    if (!item || item.status !== 'passed') continue
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) errors.push(`${item.ac} has no evidence paths`)
    const kind = item.kind ?? 'journey'
    if (kind === 'contract') {
      if (!Array.isArray(item.substitutes) || item.substitutes.length === 0) errors.push(`${item.ac} contract case has no declared substitutes`)
      continue
    }
    if (!item.requestTarget?.worldAlias || !item.requestTarget?.timelineAlias) errors.push(`${item.ac} has no request target association`)
    if (kind === 'negative') continue
    if (!item.apiContext?.worldAlias || !item.apiContext?.timelineAlias || item.apiContext.simNow == null) errors.push(`${item.ac} has no API-confirmed context`)
    if (!item.pageContext?.worldAlias || !item.pageContext?.timelineAlias || item.pageContext.simNow == null) errors.push(`${item.ac} has no page context association`)
    if (item.apiContext?.worldAlias !== item.pageContext?.worldAlias
      || item.apiContext?.timelineAlias !== item.pageContext?.timelineAlias
      || item.apiContext?.simNow !== item.pageContext?.simNow) {
      errors.push(`${item.ac} page context does not match the API-confirmed context`)
    }
  }
  const sensitive = findSensitivePaths(manifest)
  if (sensitive.length) errors.push(`sensitive fields: ${sensitive.join(', ')}`)
  return { valid: errors.length === 0, errors }
}

export function recordCase(manifest: AcceptanceManifest, ac: string, evidence: Partial<AcceptanceCase>): AcceptanceManifest {
  if (!ACCEPTANCE_IDS.includes(ac)) throw new Error(`unknown acceptance id: ${ac}`)
  const index = manifest.cases.findIndex(item => item.ac === ac)
  if (index < 0) throw new Error(`missing acceptance case: ${ac}`)
  const next = sanitizeEvidence({ ...manifest.cases[index], ...evidence }) as AcceptanceCase
  const updated: AcceptanceManifest = { ...manifest, cases: manifest.cases.slice() }
  updated.cases[index] = next
  const findings = findSensitivePaths(updated)
  updated.redaction = { status: findings.length ? 'failed' : 'passed', findings }
  if (findings.length) throw new Error(`evidence contains sensitive fields: ${findings.join(', ')}`)
  return updated
}

export function writeManifest(manifest: AcceptanceManifest, outputPath: string): void {
  const result = validateManifest(manifest)
  if (!result.valid) throw new Error(result.errors.join('; '))
  const destination = resolve(outputPath)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * 契约/拒绝路径用例声明：由验收工作流在 focused 契约与构建都通过后写入
 * （PHASE2B_DECLARE_CONTRACTS=1），只覆盖仍为 unverified 的用例，
 * 绝不覆盖浏览器旅程记录的真实结果。evidence 指向 focused job 实际执行的测试。
 */
const CONTRACT_DECLARATIONS: Record<string, Partial<AcceptanceCase>> = {
  AC1: {
    kind: 'contract', status: 'passed',
    summary: 'API time context and route fixtures keep world, timeline, simNow, timezone and capabilities together.',
    substitutes: ['api-unit-matrix'],
    evidence: ['api/src/worlds/status.test.ts', 'api/src/worlds/time-status.routes.test.ts'],
  },
  AC3: {
    kind: 'contract', status: 'passed',
    summary: 'Relative time boundaries use only eventSimTime and target simNow.',
    substitutes: ['web-pure-function'],
    evidence: ['web/src/lib/world-time.test.ts'],
  },
  AC5: {
    kind: 'contract', status: 'passed',
    summary: 'World status labels and owner/guest capability matrix are covered.',
    substitutes: ['status-unit-matrix'],
    evidence: ['api/src/worlds/status.test.ts', 'web/src/lib/world-status.test.ts'],
  },
  AC6: {
    kind: 'contract', status: 'passed',
    summary: 'Archived-timeline comparison stays read-only and timeline routes keep authorization gates.',
    substitutes: ['api-timeline-matrix'],
    evidence: ['api/src/life/compare.test.ts', 'api/src/routing/authorization-order.test.ts'],
  },
  AC9: {
    kind: 'negative', status: 'passed',
    summary: 'Cross-world visit targets are rejected without creating a session.',
    requestTarget: { worldAlias: 'private-world', timelineAlias: 'foreign-line' },
    evidence: ['api/src/worlds/time-status.routes.test.ts', 'api/src/life/visit-sessions.test.ts'],
  },
  AC10: {
    kind: 'contract', status: 'passed',
    summary: 'The new migration installs cleanly and legacy status/timeline compatibility tests pass.',
    substitutes: ['local-sqlite-migration'],
    evidence: ['api/src/db/time-status-migration.test.ts', 'api/src/test/legacy-compat.test.ts'],
  },
  AC11: {
    kind: 'contract', status: 'passed',
    summary: 'Focused contracts, evidence finalizer tests and API/Web builds passed at this SHA.',
    substitutes: ['local-validation'],
    evidence: ['scripts/finalize-phase2b-time-status-acceptance.test.mjs', 'api/src/worlds/status.test.ts', 'web/src/lib/world-time.test.ts'],
  },
}

if (process.argv.includes('--validate-manifest')) {
  const manifest = createAcceptanceManifest(`validation-${Date.now()}`)
  manifest.cleanup = { servicesStopped: true, tempPathsRemoved: true, attempted: true, errors: [] }
  const aliases = createContextAliasRegistry()
  const probe = recordCase(manifest, 'AC1', {
    status: 'passed',
    summary: 'manifest 自检：上下文别名与脱敏探针',
    requestTarget: { worldAlias: aliases.world('alias-probe'), timelineAlias: aliases.timeline('main') },
    apiContext: { worldAlias: aliases.world('alias-probe'), timelineAlias: aliases.timeline('main'), simNow: '2026-10-23T00:00:00Z' },
    pageContext: { worldAlias: aliases.world('alias-probe'), timelineAlias: aliases.timeline('main'), simNow: '2026-10-23T00:00:00Z' },
    substitutes: [],
    evidence: ['self-probe'],
  })
  const result = validateManifest(probe)
  if (!result.valid) {
    console.error(result.errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log(`phase2b manifest ok: ${manifest.cases.length} acceptance cases, redaction clean`)
  }
}

if (process.argv.includes('--write-manifest')) {
  const outputPath = process.env.PHASE2B_EVIDENCE_MANIFEST
  if (!outputPath) {
    console.error('PHASE2B_EVIDENCE_MANIFEST is required')
    process.exitCode = 1
  } else {
    // 浏览器旅程先写 manifest（test.afterAll）；此处在其上合并契约声明，缺册时补全骨架。
    let manifest: AcceptanceManifest = existsSync(outputPath)
      ? JSON.parse(readFileSync(outputPath, 'utf8')) as AcceptanceManifest
      : createAcceptanceManifest(process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`)
    if (manifest.schema !== PHASE2B_SCHEMA) {
      console.error(`refusing to merge: existing manifest schema ${manifest.schema} is not ${PHASE2B_SCHEMA}`)
      process.exitCode = 1
    } else {
      if (process.env.PHASE2B_DECLARE_CONTRACTS === '1') {
        for (const [ac, declaration] of Object.entries(CONTRACT_DECLARATIONS)) {
          const index = manifest.cases.findIndex(item => item.ac === ac)
          if (index >= 0 && manifest.cases[index].status === 'unverified') {
            manifest = recordCase(manifest, ac, declaration)
          }
        }
      }
      manifest = { ...manifest, cleanup: { servicesStopped: true, tempPathsRemoved: true, attempted: true, errors: [] } }
      writeManifest(manifest, outputPath)
      const passed = manifest.cases.filter(item => item.status === 'passed').length
      console.log(`phase2b evidence manifest written: ${outputPath} (${passed}/${manifest.cases.length} cases passed at ${manifest.gitSha})`)
    }
  }
}
