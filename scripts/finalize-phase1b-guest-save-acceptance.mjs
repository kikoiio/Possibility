import { currentSha, loadEvidence, sensitivePaths, writeEvidenceReport } from './lib/acceptance-evidence.mjs'

export { loadEvidence }

export const PHASE1B_SCHEMA = 'phase1b-guest-save-v1'
export const ACCEPTANCE_IDS = Array.from({ length: 14 }, (_, index) => `AC${index + 1}`)
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

export function finalizeEvidence(directory, options = {}) {
  const loaded = loadEvidence(directory)
  const expectedSha = options.expectedSha === undefined ? currentSha() : options.expectedSha
  const validation = validateEvidence(loaded.manifest, expectedSha)
  return writeEvidenceReport({
    root: loaded.root,
    manifest: loaded.manifest,
    validation,
    schema: `${PHASE1B_SCHEMA}-final-report`,
    title: 'Phase 1B guest save acceptance',
    summarizeCase: item => ({ ac: item?.ac, status: item?.status, uniqueResultCount: item?.result?.uniqueResultCount ?? null }),
    successMessage: 'All acceptance evidence associations and cleanup checks passed.',
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = process.env.PHASE1B_EVIDENCE_DIR ?? 'artifacts/phase1b-guest-save'
  const report = finalizeEvidence(directory)
  console.log(JSON.stringify(report, null, 2))
  if (report.status === 'failed') process.exitCode = 1
}
