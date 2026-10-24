import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const SECRET_KEY = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|header|raw.?body|trace|database.?path)/i
const SECRET_VALUE = /(bearer\s+|token[=:]\s*|password[=:]\s*|secret[=:]\s*)[^\s,;]+/i
const LONG_CREDENTIAL = /\b(?:sk|ghp|github_pat|xox[baprs])_[a-z0-9_-]{12,}\b/i
const CASE_STATUSES = ['passed', 'failed', 'unverified']

export function currentSha() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
  catch { return null }
}

export function sensitivePaths(value, path = '$') {
  if (typeof value === 'string') return SECRET_VALUE.test(value) || LONG_CREDENTIAL.test(value) ? [path] : []
  if (!value || typeof value !== 'object') return []
  const findings = []
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) findings.push(`${path}.${key}`)
    else findings.push(...sensitivePaths(child, `${path}.${key}`))
  }
  return findings
}

export function loadEvidence(directory) {
  const root = resolve(directory)
  const manifestPath = existsSync(join(root, 'manifest.json')) ? join(root, 'manifest.json') : join(root, 'run.json')
  if (!existsSync(manifestPath)) throw new Error(`missing evidence manifest in ${root}`)
  return { root, manifestPath, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) }
}

export function writeEvidenceReport({ root, manifest, validation, schema, title, summarizeCase, successMessage }) {
  const data = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {}
  const cases = Array.isArray(data.cases) ? data.cases : []
  const counts = Object.fromEntries(CASE_STATUSES.map(status => [
    status,
    cases.filter(item => item?.status === status).length,
  ]))
  const caseErrors = cases.flatMap(item => {
    if (item?.status === 'failed') return [`${item.ac ?? 'case'} failed`]
    if (!CASE_STATUSES.includes(item?.status)) return [`${item?.ac ?? 'case'} has an invalid status`]
    return []
  })
  const errors = [...validation.errors, ...caseErrors]
  const status = errors.length ? 'failed' : (counts.unverified === 0 ? 'passed' : 'partial')
  const report = {
    schema,
    runId: data.runId,
    gitSha: data.gitSha,
    status,
    counts,
    errors,
    cleanup: data.cleanup,
    cases: cases.map(summarizeCase),
  }
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'final-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const summary = [
    `## ${title}: ${report.status}`,
    '',
    `Run: \`${report.runId}\` · SHA: \`${report.gitSha}\` · Passed: ${counts.passed} · Failed: ${counts.failed} · Unverified: ${counts.unverified}`,
    '',
    ...(errors.length ? errors.map(error => `- ${error}`)
      : [status === 'partial' ? `${counts.unverified} acceptance case(s) remain unverified.` : successMessage].map(message => `- ${message}`)),
    '',
  ].join('\n')
  writeFileSync(join(root, 'summary.md'), summary)
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' })
  return { ...report, root }
}
