import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

export const PHASE1C_SCHEMA = 'phase1c-world-projection-v1'
export const ACCEPTANCE_IDS = Array.from({ length: 12 }, (_, index) => `AC${index + 1}`)
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
  if (manifest.schema !== PHASE1C_SCHEMA) errors.push(`unexpected schema: ${manifest.schema ?? 'missing'}`)
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
    const kind = item.kind ?? 'journey'
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) errors.push(`${item.ac} has no evidence paths`)
    if (kind === 'contract') {
      // 契约证据来自单元矩阵：无页面上下文，但必须声明替身并指向具体证据来源。
      if (!Array.isArray(item.substitutes) || item.substitutes.length === 0) errors.push(`${item.ac} contract case has no declared substitutes`)
      continue
    }
    if (!item.requestTarget?.worldAlias || !item.requestTarget?.presentation) errors.push(`${item.ac} has no request target association`)
    if (kind === 'negative') {
      // 拒绝路径：断言的就是没有 ready 上下文，只要求目标与证据关联。
      continue
    }
    if (!item.apiContext?.worldAlias || !item.apiContext?.timelineAlias || item.apiContext?.simNow == null) {
      errors.push(`${item.ac} has no API-confirmed context`)
    }
    if (!item.pageContext?.worldAlias || item.pageContext?.simNow == null) errors.push(`${item.ac} has no page context association`)
    // 页面上下文必须与 API 确认上下文一致（同一别名、同一模拟时刻）。
    if (item.apiContext?.worldAlias !== item.pageContext?.worldAlias
      || item.apiContext?.timelineAlias !== item.pageContext?.timelineAlias
      || item.apiContext?.spaceAlias !== item.pageContext?.spaceAlias) {
      errors.push(`${item.ac} page context does not match the API-confirmed context`)
    }
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
    schema: `${PHASE1C_SCHEMA}-final-report`,
    runId: loaded.manifest.runId,
    gitSha: loaded.manifest.gitSha,
    status,
    counts,
    errors: validation.errors,
    cleanup: loaded.manifest.cleanup,
    cases: loaded.manifest.cases.map(item => ({ ac: item.ac, status: item.status, substitutes: item.substitutes ?? [] })),
  }
  mkdirSync(loaded.root, { recursive: true })
  writeFileSync(join(loaded.root, 'final-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const summary = [
    `## Phase 1C world projection acceptance: ${report.status}`,
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
  const directory = process.env.PHASE1C_EVIDENCE_DIR ?? 'artifacts/phase1c-world-projection'
  const report = finalizeEvidence(directory)
  console.log(JSON.stringify(report, null, 2))
  if (report.status === 'failed') process.exitCode = 1
}
