import { currentSha, loadEvidence, sensitivePaths, writeEvidenceReport } from './lib/acceptance-evidence.mjs'

export { loadEvidence }

export const PHASE1C_SCHEMA = 'phase1c-world-projection-v1'
export const ACCEPTANCE_IDS = Array.from({ length: 12 }, (_, index) => `AC${index + 1}`)
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
      if (!Array.isArray(item.substitutes) || item.substitutes.length === 0) errors.push(`${item.ac} contract case has no declared substitutes`)
      continue
    }
    if (!item.requestTarget?.worldAlias || !item.requestTarget?.presentation) errors.push(`${item.ac} has no request target association`)
    if (kind === 'negative') continue
    if (!item.apiContext?.worldAlias || !item.apiContext?.timelineAlias || item.apiContext?.simNow == null) {
      errors.push(`${item.ac} has no API-confirmed context`)
    }
    if (!item.pageContext?.worldAlias || item.pageContext?.simNow == null) errors.push(`${item.ac} has no page context association`)
    if (item.apiContext?.worldAlias !== item.pageContext?.worldAlias
      || item.apiContext?.timelineAlias !== item.pageContext?.timelineAlias
      || item.apiContext?.spaceAlias !== item.pageContext?.spaceAlias
      || item.apiContext?.simNow !== item.pageContext?.simNow) {
      errors.push(`${item.ac} page context does not match the API-confirmed context`)
    }
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
    schema: `${PHASE1C_SCHEMA}-final-report`,
    title: 'Phase 1C world projection acceptance',
    summarizeCase: item => ({ ac: item?.ac, status: item?.status, substitutes: item?.substitutes ?? [] }),
    successMessage: 'All acceptance evidence associations and cleanup checks passed.',
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = process.env.PHASE1C_EVIDENCE_DIR ?? 'artifacts/phase1c-world-projection'
  const report = finalizeEvidence(directory)
  console.log(JSON.stringify(report, null, 2))
  if (report.status === 'failed') process.exitCode = 1
}
