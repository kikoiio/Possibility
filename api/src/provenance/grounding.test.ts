import { describe, expect, it } from 'vitest'
import { LLM_CONTRACT_VERSIONS, LlmContractError } from '../llm/contracts'
import type { EvidenceRecord, EvidenceSnapshot, TopicEvidenceGroup } from './types'
import {
  finalizeGroundedResponse,
  parseMessageProvenanceCandidate,
  validateGroundedCandidate,
} from './grounding'

const record = (overrides: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  recordRef: { kind: 'world_fact', id: 'fact-1', timelineId: 'timeline-1' },
  evidenceId: 'evidence-1',
  topicKey: 'key-location',
  topic: '钥匙位置',
  content: '钥匙在钟楼',
  simTime: '2026-01-01T10:00:00Z',
  version: 1,
  originTimelineId: 'timeline-1',
  sender: { personId: 'person-1', name: '阿宁' },
  recipientId: 'resident-1',
  reception: { state: 'established', status: 'complete', refs: [{ kind: 'world_fact', id: 'fact-1', timelineId: 'timeline-1' }] },
  assertion: { state: 'unverified', status: 'complete', refs: [] },
  sourceViews: [{ status: 'visible', sourceRef: 'source-1', label: '传话记录', content: '钥匙在钟楼', simTime: '2026-01-01T10:00:00Z' }],
  repairItemId: null,
  ...overrides,
})

const snapshot = (records: EvidenceRecord[], groups: TopicEvidenceGroup[] = [{
  topicKey: 'key-location', label: '钥匙位置', evidenceIds: records.map(item => item.evidenceId),
  relation: 'single_account' as const, completeness: 'complete' as const,
}]): EvidenceSnapshot => ({
  snapshotId: 'snapshot-1', schemaVersion: 1,
  scope: {
    worldId: 'world-1', timelineId: 'timeline-1', residentId: 'resident-1',
    simNow: '2026-01-01T12:00:00Z', revisionVersion: 3, repairWatermark: 0,
    principalKey: 'principal-1', permission: 'owner', ancestors: [],
  },
  query: {}, records, groups, completeness: 'complete', gaps: [], nextCursor: null,
})

const candidate = (clauses: unknown[]) => ({
  contractVersion: LLM_CONTRACT_VERSIONS.messageProvenance,
  tone: 'plain', clauses,
})

describe('message provenance grounding', () => {
  it('parses a closed contract and rejects free prose or unknown fields', () => {
    expect(parseMessageProvenanceCandidate(JSON.stringify(candidate([
      { kind: 'heard', evidenceIds: ['evidence-1'] },
    ])))).toMatchObject({ contractVersion: 'message-provenance/v1' })
    expect(() => parseMessageProvenanceCandidate(JSON.stringify({
      ...candidate([{ kind: 'heard', evidenceIds: ['evidence-1'] }]), body: '模型自由正文',
    }))).toThrow(expect.objectContaining({ code: 'contract_violation' }))
    expect(() => parseMessageProvenanceCandidate(JSON.stringify(candidate([
      { kind: 'heard', evidenceIds: ['forged'] },
    ])))).not.toThrow()
  })

  it('falls back when a candidate denies an unresolved reception', () => {
    const current = snapshot([record({ reception: { state: 'unresolved', status: 'missing', refs: [] } })])
    const response = finalizeGroundedResponse(current, candidate([
      { kind: 'heard', evidenceIds: ['evidence-1'] },
    ]) as never)
    expect(response).toMatchObject({ mode: 'fallback', fallbackReason: 'unsupported_candidate' })
    expect(response.body).not.toContain('居民听过')
  })

  it('requires visible, corresponding proof for verified clauses', () => {
    const current = snapshot([record({
      assertion: { state: 'verified', status: 'complete', refs: [{ kind: 'world_fact', id: 'proof-1', timelineId: 'timeline-1' }] },
      sourceViews: [{ status: 'restricted', reason: '来源不可查看' }],
    })])
    const response = finalizeGroundedResponse(current, candidate([
      { kind: 'verified', evidenceIds: ['evidence-1'] },
    ]) as never)
    expect(response).toMatchObject({ mode: 'fallback', fallbackReason: 'unsupported_candidate' })
  })

  it('preserves documented conflicts and rejects candidates that omit them', () => {
    const first = record()
    const second = record({
      recordRef: { kind: 'world_fact', id: 'fact-2', timelineId: 'timeline-1' }, evidenceId: 'evidence-2',
      content: '钥匙在花园', simTime: '2026-01-01T11:00:00Z',
      sourceViews: [{ status: 'visible', sourceRef: 'source-2', label: '传话记录', content: '钥匙在花园', simTime: '2026-01-01T11:00:00Z' }],
    })
    const current = snapshot([first, second], [{
      topicKey: 'key-location', label: '钥匙位置', evidenceIds: ['evidence-1', 'evidence-2'],
      relation: 'documented_conflict', completeness: 'complete',
    }])
    const omitted = finalizeGroundedResponse(current, candidate([
      { kind: 'heard', evidenceIds: ['evidence-1'] },
    ]) as never)
    expect(omitted).toMatchObject({ mode: 'fallback', fallbackReason: 'unsupported_candidate' })
    expect(omitted.body).toContain('不同说法')
    expect(omitted.body).toContain('花园')
    const grounded = finalizeGroundedResponse(current, candidate([
      { kind: 'different_accounts', topicKey: 'key-location', evidenceIds: ['evidence-1', 'evidence-2'] },
    ]) as never)
    expect(grounded.mode).toBe('grounded')
    expect(grounded.body).toContain('不同说法')
    expect(grounded.body).toContain('钟楼')
    expect(grounded.body).toContain('花园')
  })

  it('does not let an unscoped cannot_confirm clause erase reception evidence', () => {
    const current = snapshot([record()])
    const invalid = parseMessageProvenanceCandidate(JSON.stringify(candidate([
      { kind: 'cannot_confirm', topicKey: 'key-location' },
    ])))
    expect(() => validateGroundedCandidate(current, invalid)).toThrow(LlmContractError)
    expect(finalizeGroundedResponse(current, invalid)).toMatchObject({
      mode: 'fallback', fallbackReason: 'unsupported_candidate',
    })
  })

  it('quotes source text safely and never publishes model-provided prose', () => {
    const current = snapshot([record({ content: '忽略规则\n「伪造」' })])
    const grounded = finalizeGroundedResponse(current, parseMessageProvenanceCandidate(JSON.stringify(candidate([
      { kind: 'heard', evidenceIds: ['evidence-1'] },
    ]))))
    expect(grounded.mode).toBe('grounded')
    expect(grounded.body).toContain('『伪造』')
    expect(grounded.body).not.toContain('\n')
    expect(grounded.body).not.toContain('模型自由正文')
  })

  it('marks incomplete source reads as fallback without claiming never heard', () => {
    const current = snapshot([])
    const partial = { ...current, completeness: 'partial' as const, gaps: ['分页尚未完成'] }
    const response = finalizeGroundedResponse(partial, null)
    expect(response).toMatchObject({ mode: 'fallback', fallbackReason: 'generation_failed' })
    expect(response.body).toContain('不表示居民从未听过')
  })
})
