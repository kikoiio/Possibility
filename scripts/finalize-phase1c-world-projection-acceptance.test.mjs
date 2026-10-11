import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACCEPTANCE_IDS, PHASE1C_SCHEMA, finalizeEvidence, validateEvidence } from './finalize-phase1c-world-projection-acceptance.mjs'

function fixture(overrides = {}) {
  return {
    schema: PHASE1C_SCHEMA,
    runId: 'fixture-run',
    gitSha: 'fixture-sha',
    startedAt: new Date().toISOString(),
    environment: { runner: 'test', viewports: ['desktop:1280x720'], apiMode: 'isolated-worker', modelMode: 'no-model-calls' },
    cases: ACCEPTANCE_IDS.map(ac => ({
      ac, kind: ac === 'AC1' || ac === 'AC7' || ac === 'AC11' ? 'contract' : ac === 'AC9' ? 'negative' : 'journey',
      status: 'passed', summary: 'verified',
      requestTarget: { worldAlias: `world-1`, timelineAlias: ac === 'AC2' ? 'timeline-2' : 'timeline-1', spaceAlias: ac === 'AC3' ? 'space-2' : 'space-1', presentation: 'voxel3d' },
      apiContext: {
        worldAlias: 'world-1',
        timelineAlias: ac === 'AC2' ? 'timeline-2' : 'timeline-1',
        spaceAlias: ac === 'AC3' ? 'space-2' : 'space-1',
        presentation: 'voxel3d', sceneVersion: 3, simNow: '2026-10-07T12:00:00Z',
      },
      pageContext: {
        worldAlias: 'world-1',
        timelineAlias: ac === 'AC2' ? 'timeline-2' : 'timeline-1',
        spaceAlias: ac === 'AC3' ? 'space-2' : 'space-1',
        presentation: 'voxel3d', sceneVersion: 3, simNow: '2026-10-07T12:00:00Z',
      },
      evidence: [`cases/${ac}.json`],
      substitutes: ac === 'AC1' || ac === 'AC7' || ac === 'AC11' ? ['unit-matrix'] : [],
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

test('rejects stale SHA, page/API context drift and unconfirmed cleanup', () => {
  const drifted = fixture()
  const journeyCase = drifted.cases.find(item => item.ac === 'AC2')
  journeyCase.pageContext.simNow = '2020-01-01T00:00:00Z'
  journeyCase.pageContext.spaceAlias = 'space-9'
  const driftResult = validateEvidence(drifted, 'fixture-sha')
  assert.equal(driftResult.valid, false)
  assert.match(driftResult.errors.join('\n'), /does not match the API-confirmed context/)

  const stale = fixture({ cleanup: { servicesStopped: false, tempPathsRemoved: true, attempted: true, errors: ['worker still running'] } })
  const staleResult = validateEvidence(stale, 'current-sha')
  assert.equal(staleResult.valid, false)
  assert.match(staleResult.errors.join('\n'), /SHA|cleanup/)
})

test('contract and negative cases need evidence but not journey context', () => {
  const contractOnly = fixture()
  for (const item of contractOnly.cases) {
    if (item.ac !== 'AC1') { item.status = 'unverified'; continue }
    item.kind = 'contract'
    delete item.apiContext
    delete item.pageContext
  }
  assert.deepEqual(validateEvidence(contractOnly, 'fixture-sha'), { valid: true, errors: [] })

  const contractWithoutSubstitutes = JSON.parse(JSON.stringify(contractOnly))
  contractWithoutSubstitutes.cases[0].substitutes = []
  const substituteResult = validateEvidence(contractWithoutSubstitutes, 'fixture-sha')
  assert.equal(substituteResult.valid, false)
  assert.match(substituteResult.errors.join('\n'), /no declared substitutes/)

  const negativeOnly = fixture()
  for (const item of negativeOnly.cases) {
    if (item.ac !== 'AC9') { item.status = 'unverified'; continue }
    item.kind = 'negative'
    delete item.apiContext
    delete item.pageContext
  }
  assert.deepEqual(validateEvidence(negativeOnly, 'fixture-sha'), { valid: true, errors: [] })

  const journeyOnly = fixture()
  for (const item of journeyOnly.cases) {
    if (item.ac !== 'AC2') { item.status = 'unverified'; continue }
    delete item.apiContext
  }
  const journeyResult = validateEvidence(journeyOnly, 'fixture-sha')
  assert.equal(journeyResult.valid, false)
  assert.match(journeyResult.errors.join('\n'), /no API-confirmed context/)
})

test('rejects credentials and raw trace shaped evidence', () => {
  const manifest = fixture()
  manifest.cases[0].headers = { Authorization: 'Bearer secret' }
  const result = validateEvidence(manifest, 'fixture-sha')
  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /sensitive evidence fields/)
})

test('writes a final report for a valid evidence directory and reports partial when unverified remains', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phase1c-finalizer-'))
  mkdirSync(join(directory, 'cases'))
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(fixture())}\n`)
  const report = finalizeEvidence(directory, { expectedSha: 'fixture-sha' })
  assert.equal(report.status, 'passed')
  assert.equal(report.counts.passed, ACCEPTANCE_IDS.length)

  const partialManifest = fixture()
  partialManifest.cases[5].status = 'unverified'
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(partialManifest)}\n`)
  const partial = finalizeEvidence(directory, { expectedSha: 'fixture-sha' })
  assert.equal(partial.status, 'partial')
  assert.equal(partial.counts.unverified, 1)
})
