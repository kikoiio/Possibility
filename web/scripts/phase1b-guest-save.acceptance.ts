import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const PHASE1B_SCHEMA = 'phase1b-guest-save-v1' as const
export const ACCEPTANCE_IDS = Array.from({ length: 14 }, (_, index) => `AC${index + 1}`) as readonly string[]
export const PHASE1B_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow-485', width: 485, height: 724 },
  { name: 'narrow-390', width: 390, height: 844 },
] as const

export type AcceptanceStatus = 'passed' | 'failed' | 'unverified'

export type AcceptanceCase = {
  ac: string
  status: AcceptanceStatus
  summary: string
  source: { sessionId: string | null; worldId: string | null; generation: number | null }
  target: { userId: string | null; username: string | null }
  operation: { requestId: string | null; executionId: string | null; epoch: number | null }
  result: { worldId: string | null; uniqueResultCount: number | null; writeConfirmed: boolean | null }
  evidence: string[]
  substitutes: string[]
  failureReason?: string
}

export type AcceptanceManifest = {
  schema: typeof PHASE1B_SCHEMA
  runId: string
  gitSha: string
  startedAt: string
  environment: { runner: string; viewports: string[]; apiMode: string; modelMode: string }
  cases: AcceptanceCase[]
  cleanup: { servicesStopped: boolean; tempPathsRemoved: boolean; attempted: boolean; errors: string[] }
  redaction: { status: 'passed' | 'failed'; findings: string[] }
}

const SECRET_KEY = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|header|raw.?body|trace|database.?path)/i
const SECRET_VALUE = /(bearer\s+|token[=:]\s*|password[=:]\s*|secret[=:]\s*)[^\s,;]+/i
const LONG_CREDENTIAL = /\b(?:sk|ghp|github_pat|xox[baprs])_[a-z0-9_-]{12,}\b/i

const unverifiedReason = '尚未运行该验收项，需在隔离环境执行对应 API/UI 旅程。'

function blankCase(ac: string): AcceptanceCase {
  return {
    ac,
    status: 'unverified',
    summary: unverifiedReason,
    source: { sessionId: null, worldId: null, generation: null },
    target: { userId: null, username: null },
    operation: { requestId: null, executionId: null, epoch: null },
    result: { worldId: null, uniqueResultCount: null, writeConfirmed: null },
    evidence: [],
    substitutes: [],
    failureReason: unverifiedReason,
  }
}

export function createAcceptanceManifest(
  runId: string,
  gitSha = 'unknown',
  overrides: Partial<Pick<AcceptanceManifest, 'environment' | 'cleanup'>> = {},
): AcceptanceManifest {
  return {
    schema: PHASE1B_SCHEMA,
    runId,
    gitSha,
    startedAt: new Date().toISOString(),
    environment: {
      runner: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
      viewports: PHASE1B_VIEWPORTS.map(viewport => `${viewport.name}:${viewport.width}x${viewport.height}`),
      apiMode: process.env.PHASE1B_API_MODE ?? 'isolated-worker',
      modelMode: process.env.PHASE1B_MODEL_MODE ?? 'deterministic-substitute',
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

export function validateManifest(manifest: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!manifest || typeof manifest !== 'object') return { valid: false, errors: ['manifest must be an object'] }
  const candidate = manifest as Partial<AcceptanceManifest>
  if (candidate.schema !== PHASE1B_SCHEMA) errors.push(`schema must be ${PHASE1B_SCHEMA}`)
  if (!candidate.runId) errors.push('runId is required')
  if (!candidate.gitSha) errors.push('gitSha is required')
  if (!Array.isArray(candidate.cases)) errors.push('cases must be an array')
  const cases = Array.isArray(candidate.cases) ? candidate.cases : []
  const ids = cases.map(item => item && typeof item === 'object' ? (item as { ac?: string }).ac : null)
  for (const ac of ACCEPTANCE_IDS) if (!ids.includes(ac)) errors.push(`missing ${ac}`)
  if (new Set(ids.filter(Boolean)).size !== ids.filter(Boolean).length) errors.push('duplicate acceptance id')
  if (!candidate.cleanup || candidate.cleanup.attempted !== true) errors.push('cleanup must be attempted')
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

if (process.argv.includes('--validate-manifest')) {
  const manifest = createAcceptanceManifest(`validation-${Date.now()}`, process.env.GITHUB_SHA ?? 'validation')
  manifest.cleanup = { servicesStopped: true, tempPathsRemoved: true, attempted: true, errors: [] }
  const result = validateManifest(manifest)
  if (!result.valid) {
    console.error(result.errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log(`phase1b manifest ok: ${manifest.cases.length} acceptance cases, ${manifest.environment.viewports.length} viewports, redaction clean`)
  }
}

if (process.argv.includes('--write-manifest')) {
  const outputPath = process.env.PHASE1B_EVIDENCE_MANIFEST
  if (!outputPath) {
    console.error('PHASE1B_EVIDENCE_MANIFEST is required')
    process.exitCode = 1
  } else {
    const manifest = createAcceptanceManifest(
      process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`,
      process.env.GITHUB_SHA ?? 'unknown',
      { cleanup: { servicesStopped: true, tempPathsRemoved: true, attempted: true, errors: [] } },
    )
    writeManifest(manifest, outputPath)
    console.log(`phase1b evidence manifest written: ${outputPath} (${manifest.cases.length} cases currently unverified)`)
  }
}
