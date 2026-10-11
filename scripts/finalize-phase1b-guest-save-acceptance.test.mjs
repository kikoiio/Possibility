import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACCEPTANCE_IDS, PHASE1B_SCHEMA, finalizeEvidence, validateEvidence } from './finalize-phase1b-guest-save-acceptance.mjs'

function fixture(overrides = {}) {
  return {
    schema: PHASE1B_SCHEMA,
    runId: 'fixture-run',
    gitSha: 'fixture-sha',
    startedAt: new Date().toISOString(),
    environment: { runner: 'test', viewports: ['desktop:1440x900'], apiMode: 'isolated', modelMode: 'deterministic' },
    cases: ACCEPTANCE_IDS.map(ac => ({
      ac, status: 'passed', summary: 'verified',
      source: { sessionId: `session-${ac}`, worldId: `source-${ac}`, generation: 1 },
      target: { userId: `user-${ac}`, username: `user-${ac}` },
      operation: { requestId: `request-${ac}`, executionId: `execution-${ac}`, epoch: 1 },
      result: { worldId: `result-${ac}`, uniqueResultCount: 1, writeConfirmed: true },
      evidence: [`cases/${ac}.json`], substitutes: ['deterministic-model'],
    })),
    cleanup: { servicesStopped: true, tempPathsRemoved: true, attempted: true, errors: [] },
    redaction: { status: 'passed', findings: [] },
    ...overrides,
  }
}

test('accepts complete, associated, cleaned and redacted evidence', () => {
  const result = validateEvidence(fixture(), 'fixture-sha')
  assert.deepEqual(result, { valid: true, errors: [] })
})

test('rejects stale SHA, duplicate results and unconfirmed cleanup', () => {
  const manifest = fixture({ cleanup: { servicesStopped: false, tempPathsRemoved: true, attempted: true, errors: ['worker still running'] } })
  manifest.cases[0].result.uniqueResultCount = 2
  const result = validateEvidence(manifest, 'current-sha')
  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /SHA|cleanup|unique result/)
})

test('rejects credentials and raw trace shaped evidence', () => {
  const manifest = fixture()
  manifest.cases[0].headers = { Authorization: 'Bearer secret' }
  const result = validateEvidence(manifest, 'fixture-sha')
  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /sensitive evidence fields/)
})

test('writes a final report for a valid evidence directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phase1b-finalizer-'))
  mkdirSync(join(directory, 'cases'))
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(fixture())}\n`)
  const report = finalizeEvidence(directory, { expectedSha: 'fixture-sha' })
  assert.equal(report.status, 'passed')
})
