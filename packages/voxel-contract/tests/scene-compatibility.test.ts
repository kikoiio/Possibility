import { describe, expect, it } from 'vitest'
import {
  parseSceneActions,
  parseSceneCompatibilityOutcome,
  parseSceneFallbackMarker,
  parseSceneRedactedSummary,
  serializeSceneCompatibilityOutcome,
  serializeSceneFallbackMarker,
} from '../src/scene-compatibility'

describe('scene compatibility outcome contract', () => {
  it('round-trips known actions and ignores unknown legacy fields/values', () => {
    const input = {
      actions: ['retry', 'use-fallback', 'retry', 'legacy-action', 4],
      fallback: true,
      summary: { redacted: true, source: 'fallback', providerCalls: 2, oldField: 'ignored' },
      oldField: { internalPrompt: 'must not be copied' },
    }

    const outcome = parseSceneCompatibilityOutcome(input)
    expect(outcome).toEqual({
      actions: ['retry', 'use-fallback'],
      fallback: true,
      summary: { redacted: true, source: 'fallback', providerCalls: 2 },
    })
    expect(serializeSceneCompatibilityOutcome(input)).toEqual(outcome)
    expect(JSON.parse(JSON.stringify(outcome))).toEqual(outcome)
  })

  it('accepts old fallback marker spellings without making unknown values truthy', () => {
    expect(parseSceneFallbackMarker(true)).toBe(true)
    expect(parseSceneFallbackMarker({ fallback: true, ignored: 'field' })).toBe(true)
    expect(parseSceneFallbackMarker({ used: true })).toBe(true)
    expect(parseSceneFallbackMarker({ source: 'fallback' })).toBe(true)
    expect(parseSceneFallbackMarker({ source: 'generated' })).toBe(false)
    expect(parseSceneFallbackMarker('fallback')).toBe(false)
    expect(serializeSceneFallbackMarker({ kind: 'fallback' })).toBe(true)
  })

  it('keeps summaries redacted and JSON serializable', () => {
    const summary = parseSceneRedactedSummary({
      redacted: false,
      contentHash: 'sha256:abc',
      issueCodes: ['walk-gap', 17, 'binding-mismatch'],
      normalizationFixes: [{ code: 'size', summary: 'clamped' }, { code: 'bad' }],
      providerCalls: 3,
      prompt: 'secret prompt should be dropped',
    })
    expect(summary).toEqual({
      redacted: true,
      contentHash: 'sha256:abc',
      issueCodes: ['walk-gap', 'binding-mismatch'],
      normalizationFixes: [{ code: 'size', summary: 'clamped' }],
      providerCalls: 3,
    })
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary)
  })

  it('filters duplicate and unsupported actions deterministically', () => {
    expect(parseSceneActions(['enter', 'repair', 'enter', 'unknown'])).toEqual(['enter', 'repair'])
    expect(parseSceneActions(undefined)).toEqual([])
  })
})
