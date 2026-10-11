import { describe, expect, it } from 'vitest'
import { sceneIssuePresentation } from './error-copy'

describe('sceneIssuePresentation', () => {
  it('maps blocking scene issues to actionable, readable guidance', () => {
    expect(sceneIssuePresentation('walk-connectivity')).toMatchObject({
      summary: expect.stringContaining('隔开'),
      impact: expect.stringContaining('不能'),
      action: 'repair',
      retryable: false,
    })
  })

  it('keeps incomplete checks retryable without leaking internal details', () => {
    const result = sceneIssuePresentation('deadline')
    expect(result).toMatchObject({ action: 'retry', retryable: true })
    expect(JSON.stringify(result)).not.toMatch(/uuid|asset|stack|secret/i)
  })

  it('uses safe fallback guidance for unknown codes', () => {
    expect(sceneIssuePresentation('internal-only-code')).toMatchObject({
      summary: '场景结构还需要调整。',
      action: 'repair',
    })
  })
})
