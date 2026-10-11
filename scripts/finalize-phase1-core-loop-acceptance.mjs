import { createConnection } from 'node:net'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { validateCoreJourneyCorrelation } from './phase1-core-loop-correlation.mjs'

const outputRoot = resolve(process.env.PHASE1_BASELINE_OUTPUT_DIR ?? 'artifacts/phase1-core-loop')
const runId = process.env.PHASE1_BASELINE_RUN_ID ?? `github-${process.env.GITHUB_RUN_ID ?? 'local'}`
const runDir = join(outputRoot, runId)
const matrixPath = join(runDir, 'run.json')
const errors = []

function canConnect(port) {
  return new Promise(resolveResult => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(750)
    socket.once('connect', () => { socket.destroy(); resolveResult(true) })
    socket.once('error', () => resolveResult(false))
    socket.once('timeout', () => { socket.destroy(); resolveResult(false) })
  })
}

if (!existsSync(matrixPath)) throw new Error(`Missing browser matrix: ${matrixPath}`)
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'))
const counts = Object.fromEntries(['passed', 'failed', 'unverified'].map(status => [status, matrix.cases.filter(item => item.status === status).length]))
const correlationPath = join(runDir, 'correlation', 'BB-01.json')
try {
  const correlation = JSON.parse(readFileSync(correlationPath, 'utf8'))
  const trace = Array.isArray(correlation.apiTrace) ? correlation.apiTrace : []
  const correlationValidation = validateCoreJourneyCorrelation(correlation, runId)
  errors.push(...correlationValidation.errors.map(error => `Core journey correlation: ${error}.`))
  if (correlationValidation.passed) {
    const bb01 = matrix.cases.find(item => item.caseId === 'BB-01')
    if (bb01) {
      bb01.requestId = correlation.requestId
      bb01.context = correlation.context
      bb01.apiTrace = trace
      bb01.page = { ...bb01.page, url: correlation.page.url, labels: [...new Set([...(bb01.page?.labels ?? []), ...correlation.page.labels])] }
      bb01.evidencePaths = [...new Set([...(bb01.evidencePaths ?? []), 'correlation/BB-01.json'])]
      mkdirSync(join(runDir, 'cases'), { recursive: true })
      writeFileSync(join(runDir, 'cases', 'BB-01.json'), `${JSON.stringify({
        schema: `${matrix.schema}-case`, runId, caseId: 'BB-01', status: bb01.status,
        verified: bb01.status === 'passed', identity: bb01.identity, context: bb01.context,
        requestId: bb01.requestId, apiTrace: bb01.apiTrace, entry: bb01.entry,
        page: bb01.page, http: bb01.http, failure: bb01.failure,
      }, null, 2)}\n`)
    }
  }
} catch {
  errors.push('Core journey correlation evidence is missing or invalid.')
}
const responsiveDir = join(runDir, 'responsive')
const compatibilityResultsPath = join(runDir, 'compatibility-results.json')
let compatibilitySummary = { status: 'unverified', expected: 0, unexpected: null }
try {
  const results = JSON.parse(readFileSync(compatibilityResultsPath, 'utf8'))
  compatibilitySummary = {
    status: results.stats?.unexpected === 0 ? 'passed' : 'failed',
    expected: results.stats?.expected ?? 0,
    unexpected: results.stats?.unexpected ?? null,
  }
  if (compatibilitySummary.status !== 'passed' || compatibilitySummary.expected === 0) errors.push('Real compatibility browser suite did not pass or had no tests.')
} catch {
  errors.push('Real compatibility browser suite JSON evidence is missing.')
}
const responsiveCases = ['narrow-485', 'narrow-390'].map(name => {
  const resultPath = join(responsiveDir, `${name}-result.json`)
  const screenshotPath = join(responsiveDir, `${name}-fallback-ready.png`)
  try {
    const result = JSON.parse(readFileSync(resultPath, 'utf8'))
    if (result.status !== 'passed' || !existsSync(screenshotPath)) errors.push(`Responsive journey incomplete: ${name}`)
    return { name, width: result.viewport?.width ?? null, height: result.viewport?.height ?? null, status: result.status, steps: result.steps, screenshot: `responsive/${name}-fallback-ready.png` }
  } catch {
    errors.push(`Responsive journey evidence missing: ${name}`)
    return { name, width: null, height: null, status: 'unverified', reason: 'No successful browser journey record or screenshot.' }
  }
})
const gui = { status: 'unverified', reason: 'Phase 1 is a browser based web flow; the repository has no native GUI target for this acceptance stage.' }

const compatibilityTempPath = process.env.PLAYWRIGHT_COMPAT_PERSIST_TO
const compatibilityOutputDir = '/tmp/possibility-a1-compatibility-playwright-results'
if (existsSync(compatibilityOutputDir)) {
  try { cpSync(compatibilityOutputDir, join(runDir, 'compatibility-playwright-output'), { recursive: true }) }
  catch (error) { errors.push(`Could not preserve compatibility browser diagnostics: ${error instanceof Error ? error.message : String(error)}`) }
}
const activePorts = []
for (const port of [15173, 18787, 15198, 18798]) if (await canConnect(port)) activePorts.push(port)
if (activePorts.length) errors.push(`Acceptance services still listening on ports ${activePorts.join(', ')}`)

if (activePorts.length === 0) {
  const tempNames = readdirSync('/tmp').filter(name => name === 's02-playwright-results' || name === 'possibility-a1-compatibility-playwright-results' || name.startsWith('s02-wrangler-e2e-'))
  for (const name of tempNames) {
    try { rmSync(join('/tmp', name), { recursive: true, force: true }) }
    catch (error) { errors.push(`Could not remove /tmp/${name}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (compatibilityTempPath) {
    try { rmSync(compatibilityTempPath, { recursive: true, force: true }) }
    catch (error) { errors.push(`Could not remove compatibility fixture directory: ${error instanceof Error ? error.message : String(error)}`) }
  }
}

const remainingTemps = readdirSync('/tmp').filter(name => name === 's02-playwright-results' || name === 'possibility-a1-compatibility-playwright-results' || name.startsWith('s02-wrangler-e2e-'))
if (remainingTemps.length) errors.push(`Temporary paths remain: ${remainingTemps.join(', ')}`)
if (compatibilityTempPath && existsSync(compatibilityTempPath)) errors.push('Compatibility fixture directory remains.')
matrix.cleanup = {
  servicesStopped: activePorts.length === 0,
  tempPathsRemoved: remainingTemps.length === 0,
  attempted: true,
  errors,
}

const rows = matrix.cases.map(item => `| ${item.caseId} | ${item.status} |`).join('\n')
const summary = [
  `## Phase 1 core loop acceptance: ${runId}`,
  '',
  `Commit: \`${matrix.gitSha}\` · Cases: ${matrix.cases.length} · Passed: ${counts.passed} · Failed: ${counts.failed} · Unverified: ${counts.unverified}`,
  '',
  '### Responsive browser journeys',
  '',
  ...responsiveCases.map(item => `- ${item.name} (${item.width ?? '?'}×${item.height ?? '?'}): ${item.status}${item.screenshot ? ` · \`${item.screenshot}\`` : ` · ${item.reason}`}`),
  `- Native GUI: ${gui.status} · ${gui.reason}`,
  '',
  '### Real compatibility browser suite',
  '',
  `- ${compatibilitySummary.status}: ${compatibilitySummary.expected} tests; unexpected=${compatibilitySummary.unexpected ?? 'unknown'}. JSON: \`compatibility-results.json\``,
  '',
  `Cleanup: services stopped=${matrix.cleanup.servicesStopped}; temporary paths removed=${matrix.cleanup.tempPathsRemoved}${errors.length ? `; errors=${errors.join('; ')}` : ''}`,
  '',
  '| Case | Status |',
  '| --- | --- |',
  rows,
  '',
].join('\n')

mkdirSync(runDir, { recursive: true })
writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`)
writeFileSync(join(runDir, 'matrix.json'), `${JSON.stringify(matrix, null, 2)}\n`)
writeFileSync(join(runDir, 'cleanup.json'), `${JSON.stringify(matrix.cleanup, null, 2)}\n`)
writeFileSync(join(runDir, 'responsive-matrix.json'), `${JSON.stringify({ cases: responsiveCases, gui }, null, 2)}\n`)
writeFileSync(join(runDir, 'summary.md'), summary)
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' })

if (counts.failed || counts.unverified || errors.length) {
  throw new Error(`Acceptance matrix incomplete: ${counts.passed}/22 passed; ${errors.join('; ') || 'see summary for case outcomes'}`)
}
