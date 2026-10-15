import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACCEPTANCE_IDS, PHASE2B_SCHEMA, finalizeEvidence, validateEvidence } from './finalize-phase2b-time-status-acceptance.mjs'

function fixture(overrides = {}) {
  return {
    schema: PHASE2B_SCHEMA, runId: 'fixture-run', gitSha: 'fixture-sha', startedAt: new Date().toISOString(),
    environment: { runner: 'test', browser: 'stub', modelMode: 'no-model-calls' },
    cases: ACCEPTANCE_IDS.map((ac, index) => ({
      ac, kind: index === 10 ? 'contract' : index === 8 ? 'negative' : 'journey', status: 'passed', summary: 'verified', evidence: [`cases/${ac}.json`],
      requestTarget: { worldAlias: 'world-1', timelineAlias: 'timeline-main' },
      apiContext: { worldAlias: 'world-1', timelineAlias: 'timeline-main', simNow: '2026-10-13T00:00:00Z' },
      pageContext: { worldAlias: 'world-1', timelineAlias: 'timeline-main', simNow: '2026-10-13T00:00:00Z' },
      substitutes: index === 10 ? ['unit-matrix'] : [],
    })),
    cleanup: { attempted: true, servicesStopped: true, tempPathsRemoved: true, errors: [] },
    redaction: { status: 'passed', findings: [] },
    ...overrides,
  }
}

test('accepts associated, redacted and cleaned evidence', () => {
  assert.deepEqual(validateEvidence(fixture(), 'fixture-sha'), { valid: true, errors: [] })
})

test('rejects stale SHA, context drift, credentials and unconfirmed cleanup', () => {
  const drifted = fixture()
  drifted.cases[0].pageContext.simNow = '2020-01-01T00:00:00Z'
  drifted.cases[1].headers = { Authorization: 'Bearer secret' }
  drifted.cleanup.servicesStopped = false
  const result = validateEvidence(drifted, 'current-sha')
  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /SHA|context|sensitive|cleanup/)
})

test('writes a partial final report when browser cases remain unverified', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phase2b-finalizer-'))
  mkdirSync(join(directory, 'cases'))
  const manifest = fixture()
  manifest.cases[11].status = 'unverified'
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
  const report = finalizeEvidence(directory, { expectedSha: 'fixture-sha' })
  assert.equal(report.status, 'partial')
  assert.equal(report.counts.unverified, 1)
})
