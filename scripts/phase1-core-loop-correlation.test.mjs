import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateCoreJourneyCorrelation } from './phase1-core-loop-correlation.mjs'

const context = { worldId: 'world-1', timelineId: 'timeline-1', spaceId: 'exterior', simNow: '2026-10-02T12:00:00.000Z' }

function evidence(overrides = {}) {
  return {
    runId: 'github-123', requestId: 'request-1', context,
    apiTrace: [
      { method: 'POST', path: '/api/scene-drafts/voxel', status: 200, requestId: 'request-1' },
      { method: 'POST', path: '/api/worlds', status: 422, attempt: 1, requestId: 'request-1' },
      { method: 'POST', path: '/api/worlds', status: 200, attempt: 2, requestId: 'request-1', worldId: 'world-1', timelineId: 'timeline-1' },
      { method: 'GET', path: '/api/worlds/world-1/map/bootstrap', status: 200, ...context },
    ],
    page: { url: '/worlds/world-1', labels: ['已保存并恢复'] },
    ...overrides,
  }
}

describe('validateCoreJourneyCorrelation', () => {
  it('accepts one request linked from the blocked gate through save and authoritative bootstrap', () => {
    assert.deepEqual(validateCoreJourneyCorrelation(evidence(), 'github-123'), { passed: true, errors: [] })
  })

  it('rejects evidence mixed across run, request, or timeline scopes', () => {
    const mixed = evidence()
    mixed.runId = 'github-other'
    mixed.apiTrace[2].requestId = 'request-other'
    mixed.apiTrace[3].timelineId = 'timeline-other'
    const result = validateCoreJourneyCorrelation(mixed, 'github-123')
    assert.equal(result.passed, false)
    assert.match(result.errors.join(' '), /runId/)
    assert.match(result.errors.join(' '), /successful world create/)
    assert.match(result.errors.join(' '), /authoritative bootstrap/)
  })
})
