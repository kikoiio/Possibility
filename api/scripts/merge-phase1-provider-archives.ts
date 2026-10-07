import { readFileSync, writeFileSync } from 'node:fs'

type Call = { scenario: string; status: number | null; usage: unknown; generatedContent: string }
type Archive = {
  workflowRunId: string
  provider: { model: string; mode?: string }
  scope: { replay: boolean }
  scenarios: { id: string; valid: boolean }[]
  singleSpace: { saved: boolean }
  repair: { selected: boolean; saved: boolean }
  requests: { calls: Call[]; actualProviderRequests: number; reconciled: boolean }
}
const CASES = ['official-example', 'custom-1', 'custom-2', 'custom-3', 'original-world-repair']

/** Keep each case's complete response sequence from one successful real run.
 * This creates input for zero-model regression, never evidence of a new live run. */
export function mergeProviderArchives(archives: Archive[]) {
  const selected = new Map<string, Archive>()
  const model = archives[0]?.provider?.model
  if (!model || archives.length < 2) throw new Error('At least two real provider archives are required')
  for (const archive of archives) {
    if (!/^\d+$/.test(archive.workflowRunId) || archive.scope?.replay !== false
      || archive.provider.model !== model || !archive.requests.reconciled
      || archive.requests.actualProviderRequests < 1) {
      throw new Error('Source must be a reconciled real-provider run with the same model')
    }
    for (const scenario of archive.scenarios) {
      if (CASES.includes(scenario.id) && scenario.valid
        && (scenario.id !== 'official-example' || archive.singleSpace.saved)) {
        selected.set(scenario.id, archive)
      }
    }
    if (archive.repair.selected && archive.repair.saved) selected.set('original-world-repair', archive)
  }
  const calls: (Call & { sourceRun: string })[] = []
  const sourceScenarioRuns: Record<string, string> = {}
  for (const scenario of CASES) {
    const archive = selected.get(scenario)
    if (!archive) throw new Error(`Missing successful real source for ${scenario}`)
    const sequence = archive.requests.calls.filter(call => call.scenario === scenario)
    if (sequence.length < 1 || sequence.length > 5
      || sequence.some(call => call.status !== 200 || typeof call.generatedContent !== 'string' || !call.generatedContent.trim())) {
      throw new Error(`Invalid response sequence for ${scenario}`)
    }
    sourceScenarioRuns[scenario] = archive.workflowRunId
    calls.push(...sequence.map(call => ({ ...call, sourceRun: archive.workflowRunId })))
  }
  return {
    schema: 'phase1-recorded-composite-v1',
    workflowRunId: `composite-${[...new Set(Object.values(sourceScenarioRuns))].join('-')}`,
    provider: { model },
    sourceScenarioRuns,
    scope: { compositeRecordedInput: true, newRealProviderEvidence: false },
    requests: { calls },
  }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/merge-phase1-provider-archives.ts')) {
  const [output, ...sources] = process.argv.slice(2)
  if (!output || sources.length < 2) throw new Error('Usage: merge-phase1-provider-archives.ts OUTPUT ARCHIVE ARCHIVE [...]')
  const composite = mergeProviderArchives(sources.map(path => JSON.parse(readFileSync(path, 'utf8')) as Archive))
  writeFileSync(output, `${JSON.stringify(composite)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ sourceScenarioRuns: composite.sourceScenarioRuns, replayCalls: composite.requests.calls.length, actualProviderRequests: 0 })}\n`)
}
