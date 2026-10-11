import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

export const PHASE1B_SCHEMA = 'phase1b-guest-save-v1'
export const ACCEPTANCE_IDS = Array.from({ length: 14 }, (_, index) => `AC${index + 1}`)
const SECRET_KEY = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|header|raw.?body|trace|database.?path)/i
const SECRET_VALUE = /(bearer\s+|token[=:]\s*|password[=:]\s*|secret[=:]\s*)[^\s,;]+/i
const LONG_CREDENTIAL = /\b(?:sk|ghp|github_pat|xox[baprs])_[a-z0-9_-]{12,}\b/i

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sensitivePaths(value, path = '$') {
  if (typeof value === 'string') return SECRET_VALUE.test(value) || LONG_CREDENTIAL.test(value) ? [path] : []
  if (!value || typeof value !== 'object') return []
  const findings = []
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) findings.push(`${path}.${key}`)
    else findings.push(...sensitivePaths(child, `${path}.${key}`))
  }
  return findings
}

function currentSha() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
  catch { return null }
}

export function validateEvidence(manifest, expectedSha = currentSha()) {
  const errors = []
  if (!manifest || typeof manifest !== 'object') return { valid: false, errors: ['manifest is missing'] }
  if (manifest.schema !== PHASE1B_SCHEMA) errors.push(`unexpected schema: ${manifest.schema ?? 'missing'}`)
  if (!manifest.runId) errors.push('runId is missing')
  if (!manifest.gitSha) errors.push('gitSha is missing')
  if (expectedSha && manifest.gitSha !== expectedSha) errors.push(`evidence SHA ${manifest.gitSha} does not match current SHA ${expectedSha}`)
  if (!Array.isArray(manifest.cases)) errors.push('cases are missing')
  const cases = Array.isArray(manifest.cases) ? manifest.cases : []
  const ids = cases.map(item => item?.ac)
  for (const ac of ACCEPTANCE_IDS) if (!ids.includes(ac)) errors.push(`missing ${ac}`)
  if (new Set(ids).size !== ids.length) errors.push('duplicate acceptance case')
  if (manifest.redaction?.status !== 'passed') errors.push('redaction status is not passed')
  const findings = sensitivePaths(manifest)
  if (findings.length) errors.push(`sensitive evidence fields: ${findings.join(', ')}`)
  if (manifest.cleanup?.attempted !== true || manifest.cleanup?.servicesStopped !== true || manifest.cleanup?.tempPathsRemoved !== true) {
    errors.push('cleanup was not confirmed')
  }
  for (const item of cases) {
    if (!item || item.status !== 'passed') continue
    if (!item.source?.sessionId || !item.source?.worldId) errors.push(`${item.ac} has no source association`)
    if (!item.target?.userId) errors.push(`${item.ac} has no target association`)
    if (!item.operation?.requestId) errors.push(`${item.ac} has no request association`)
    if (!item.result?.worldId || item.result?.writeConfirmed !== true) errors.push(`${item.ac} has no confirmed result`)
    if (item.result?.uniqueResultCount !== 1) errors.push(`${item.ac} does not prove a unique result`)
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) errors.push(`${item.ac} has no evidence paths`)
  }
  return { valid: errors.length === 0, errors }
}

export function loadEvidence(directory) {
  const root = resolve(directory)
  const manifestPath = existsSync(join(root, 'manifest.json')) ? join(root, 'manifest.json') : join(root, 'run.json')
  if (!existsSync(manifestPath)) throw new Error(`missing evidence manifest in ${root}`)
  return { root, manifestPath, manifest: readJson(manifestPath) }
}

export function finalizeEvidence(directory, options = {}) {
  const loaded = loadEvidence(directory)
  const expectedSha = options.expectedSha === undefined ? currentSha() : options.expectedSha
  const validation = validateEvidence(loaded.manifest, expectedSha)
  const counts = Object.fromEntries(['passed', 'failed', 'unverified'].map(status => [status, loaded.manifest.cases.filter(item => item.status === status).length]))
  const status = validation.valid ? (counts.unverified === 0 ? 'passed' : 'partial') : 'failed'
  const report = {
    schema: `${PHASE1B_SCHEMA}-final-report`,
    runId: loaded.manifest.runId,
    gitSha: loaded.manifest.gitSha,
    status,
    counts,
    errors: validation.errors,
    cleanup: loaded.manifest.cleanup,
    cases: loaded.manifest.cases.map(item => ({ ac: item.ac, status: item.status, uniqueResultCount: item.result?.uniqueResultCount ?? null })),
  }
  mkdirSync(loaded.root, { recursive: true })
  writeFileSync(join(loaded.root, 'final-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const summary = [
    `## Phase 1B guest save acceptance: ${report.status}`,
    '',
    `Run: \`${report.runId}\` · SHA: \`${report.gitSha}\` · Passed: ${counts.passed} · Failed: ${counts.failed} · Unverified: ${counts.unverified}`,
    '',
    ...(validation.errors.length ? validation.errors.map(error => `- ${error}`) : ['- All acceptance evidence associations and cleanup checks passed.']),
    '',
  ].join('\n')
  writeFileSync(join(loaded.root, 'summary.md'), summary)
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' })
  return { ...report, root: loaded.root }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = process.env.PHASE1B_EVIDENCE_DIR ?? 'artifacts/phase1b-guest-save'
  const report = finalizeEvidence(directory)
  console.log(JSON.stringify(report, null, 2))
  if (report.status === 'failed') process.exitCode = 1
}
