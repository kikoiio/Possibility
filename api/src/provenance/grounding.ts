import {
  contractViolation,
  LLM_CONTRACT_VERSIONS,
  parseContractObject,
  requireString,
} from '../llm/contracts'
import type {
  CandidateClause,
  EvidenceRecord,
  EvidenceSnapshot,
  GroundedResponse,
  GroundedStatement,
  ResponseCandidate,
  SourceView,
  TopicEvidenceGroup,
} from './types'

const CONTRACT_VERSION = LLM_CONTRACT_VERSIONS.messageProvenance
const MAX_CLAUSES = 50
const MAX_EVIDENCE_IDS = 128
const MAX_ID_LENGTH = 256
const MAX_TOPIC_LENGTH = 256
const MAX_BODY_LENGTH = 16 * 1024

type FallbackReason = NonNullable<GroundedResponse['fallbackReason']>

function objectKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const allowed = new Set(expected)
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  if (unknown.length) contractViolation(CONTRACT_VERSION, `${field} 含有未知字段`)
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      contractViolation(CONTRACT_VERSION, `${field}.${key} 缺失`)
    }
  }
}
function asObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return contractViolation(CONTRACT_VERSION, `${field} 必须是对象`)
  }
  return value as Record<string, unknown>
}
function parseIdList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EVIDENCE_IDS) {
    return contractViolation(CONTRACT_VERSION, `${field} 必须是 1-${MAX_EVIDENCE_IDS} 项数组`)
  }
  const ids = value.map((item, index) => requireString(item, `${field}[${index}]`, CONTRACT_VERSION, MAX_ID_LENGTH))
  if (new Set(ids).size !== ids.length) contractViolation(CONTRACT_VERSION, `${field} 不能包含重复来源`)
  return ids
}

function parseClause(value: unknown, index: number): CandidateClause {
  const clause = asObject(value, `clauses[${index}]`)
  const kind = requireString(clause.kind, `clauses[${index}].kind`, CONTRACT_VERSION, 32)
  if (kind === 'heard' || kind === 'verified') {
    objectKeys(clause, ['kind', 'evidenceIds'], `clauses[${index}]`)
    return { kind, evidenceIds: parseIdList(clause.evidenceIds, `clauses[${index}].evidenceIds`) }
  }
  if (kind === 'different_accounts') {
    objectKeys(clause, ['kind', 'topicKey', 'evidenceIds'], `clauses[${index}]`)
    return {
      kind,
      topicKey: requireString(clause.topicKey, `clauses[${index}].topicKey`, CONTRACT_VERSION, MAX_TOPIC_LENGTH),
      evidenceIds: parseIdList(clause.evidenceIds, `clauses[${index}].evidenceIds`),
    }
  }
  if (kind === 'cannot_confirm') {
    objectKeys(clause, ['kind', 'topicKey'], `clauses[${index}]`)
    if (clause.topicKey !== null && typeof clause.topicKey !== 'string') {
      return contractViolation(CONTRACT_VERSION, `clauses[${index}].topicKey 必须是字符串或 null`)
    }
    return {
      kind,
      topicKey: clause.topicKey === null
        ? null
        : requireString(clause.topicKey, `clauses[${index}].topicKey`, CONTRACT_VERSION, MAX_TOPIC_LENGTH),
    }
  }
  return contractViolation(CONTRACT_VERSION, `clauses[${index}].kind 不受支持`)
}

/** Parse the closed JSON contract emitted by the message provenance model. */
export function parseMessageProvenanceCandidate(raw: unknown): ResponseCandidate {
  const value = typeof raw === 'string' ? parseContractObject(raw, CONTRACT_VERSION) : asObject(raw, 'candidate')
  objectKeys(value, ['contractVersion', 'tone', 'clauses'], 'candidate')
  const contractVersion = requireString(value.contractVersion, 'contractVersion', CONTRACT_VERSION, 64)
  if (contractVersion !== CONTRACT_VERSION) contractViolation(CONTRACT_VERSION, 'contractVersion 不匹配')
  const tone = requireString(value.tone, 'tone', CONTRACT_VERSION, 16)
  if (tone !== 'plain' && tone !== 'warm' && tone !== 'cautious') {
    contractViolation(CONTRACT_VERSION, 'tone 不受支持')
  }
  if (!Array.isArray(value.clauses) || value.clauses.length === 0 || value.clauses.length > MAX_CLAUSES) {
    contractViolation(CONTRACT_VERSION, `clauses 必须是 1-${MAX_CLAUSES} 项数组`)
  }
  return {
    contractVersion: CONTRACT_VERSION,
    tone,
    clauses: value.clauses.map((clause, index) => parseClause(clause, index)),
  }
}

function evidenceById(snapshot: EvidenceSnapshot): Map<string, EvidenceRecord> {
  return new Map(snapshot.records.map(record => [record.evidenceId, record]))
}

function groupByTopic(snapshot: EvidenceSnapshot): Map<string, TopicEvidenceGroup> {
  return new Map(snapshot.groups.map(group => [group.topicKey, group]))
}

function visibleSource(record: EvidenceRecord): boolean {
  return record.sourceViews.some(source => source.status === 'visible')
}

function hasCorrespondingVisibleProof(record: EvidenceRecord): boolean {
  return record.sourceViews.some(source => source.status === 'visible'
    && record.assertion.refs.some(ref => ref.id === source.sourceRef))
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every(id => right.includes(id))
}

/**
 * Validate a candidate against one immutable evidence snapshot. This check is
 * deliberately stricter than the JSON parser: an evidence id must exist in
 * this snapshot and each clause must match the kind of proof it claims.
 */
export function validateGroundedCandidate(snapshot: EvidenceSnapshot, candidate: ResponseCandidate): void {
  const parsed = parseMessageProvenanceCandidate(candidate)
  const records = evidenceById(snapshot)
  const groups = groupByTopic(snapshot)
  const coveredConflictTopics = new Set<string>()
  let substantiveClause = false

  for (const clause of parsed.clauses) {
    if (clause.kind === 'heard' || clause.kind === 'verified') {
      substantiveClause = true
      for (const evidenceId of clause.evidenceIds) {
        const record = records.get(evidenceId)
        if (!record) contractViolation(CONTRACT_VERSION, `${clause.kind} 引用了不属于本次快照的来源`)
        if (clause.kind === 'heard') {
          if (record.reception.state !== 'established' || record.reception.refs.length === 0) {
            contractViolation(CONTRACT_VERSION, 'heard 必须有已成立的接收依据')
          }
        } else {
          if (record.assertion.state !== 'verified' || record.assertion.status !== 'complete'
            || record.assertion.refs.length === 0 || !hasCorrespondingVisibleProof(record)) {
            contractViolation(CONTRACT_VERSION, 'verified 必须有可见且对应的内容证实依据')
          }
        }
      }
      continue
    }

    if (clause.kind === 'different_accounts') {
      substantiveClause = true
      const group = groups.get(clause.topicKey)
      if (!group || group.relation === 'single_account' || !sameIds(clause.evidenceIds, group.evidenceIds)) {
        contractViolation(CONTRACT_VERSION, 'different_accounts 必须覆盖本次读取的全部同主题说法')
      }
      for (const evidenceId of clause.evidenceIds) {
        if (!records.has(evidenceId)) contractViolation(CONTRACT_VERSION, 'different_accounts 引用了不存在的来源')
        const record = records.get(evidenceId) as EvidenceRecord
        if (record.reception.state !== 'established' || !visibleSource(record)) {
          contractViolation(CONTRACT_VERSION, 'different_accounts 必须引用可查看的接收记录')
        }
      }
      if (group.relation === 'documented_conflict') coveredConflictTopics.add(group.topicKey)
      continue
    }

    const cannotClause = clause as Extract<CandidateClause, { kind: 'cannot_confirm' }>
    const group = cannotClause.topicKey === null ? undefined : groups.get(cannotClause.topicKey)
    if (cannotClause.topicKey !== null && !group) {
      contractViolation(CONTRACT_VERSION, 'cannot_confirm 的主题不在本次快照中')
    }
    if (group) {
      const groupRecords = group.evidenceIds.map(id => records.get(id)).filter((record): record is EvidenceRecord => Boolean(record))
      const hasUnconfirmed = groupRecords.some(record => record.assertion.state !== 'verified' || record.assertion.status !== 'complete')
      const hasHeardCoverage = parsed.clauses.some(other =>
        (other.kind === 'heard' || other.kind === 'verified')
          && other.evidenceIds.some(id => group.evidenceIds.includes(id)))
      if (!hasUnconfirmed || (groupRecords.some(record => record.reception.state === 'established') && !hasHeardCoverage)) {
        contractViolation(CONTRACT_VERSION, 'cannot_confirm 不能掩盖已有接收记录或已证实内容')
      }
    } else if (snapshot.completeness === 'complete' && snapshot.records.length > 0 && substantiveClause) {
      contractViolation(CONTRACT_VERSION, 'cannot_confirm 缺少可核对主题')
    }
  }

  // A documented conflict cannot be silently dropped from a response that
  // cites this snapshot: doing so would turn two unverified accounts into one.
  for (const group of snapshot.groups) {
    if (group.relation === 'documented_conflict' && !coveredConflictTopics.has(group.topicKey)) {
      contractViolation(CONTRACT_VERSION, '候选遗漏了快照中的未解决分歧')
    }
  }

  if (!substantiveClause && snapshot.records.some(record => record.reception.state === 'established')) {
    contractViolation(CONTRACT_VERSION, '不能用 cannot_confirm 否认已有接收经历')
  }
}

function cleanText(value: string, maxLength = 512): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[「」]/g, mark => mark === '「' ? '『' : '』')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned
}

function renderSourceLabel(record: EvidenceRecord): string {
  const sender = record.sender?.name ? cleanText(record.sender.name, 80) : '一位居民'
  const time = record.simTime ? `在${cleanText(record.simTime, 80)}` : '在记录时间'
  return `${sender}${time}传达`
}

function renderHeard(record: EvidenceRecord): string {
  return `记录显示居民听过${renderSourceLabel(record)}的内容：「${cleanText(record.content)}」。这证明曾接收过传话，不单独证明内容为真。`
}

function renderVerified(record: EvidenceRecord): string {
  return `已有来源证实${renderSourceLabel(record)}的内容：「${cleanText(record.content)}」。`
}

function renderDifferent(group: TopicEvidenceGroup, records: EvidenceRecord[]): string {
  const accounts = records.map(record => `${renderSourceLabel(record)}「${cleanText(record.content)}」`)
  const relation = group.relation === 'documented_conflict' ? '不同说法' : '多条传话记录'
  return `关于${cleanText(group.label, 120)}，记录保留了${relation}：${accounts.join('；')}。这些说法尚未确认哪一种成立。`
}

function collectSources(records: EvidenceRecord[]): SourceView[] {
  const seen = new Set<string>()
  const result: SourceView[] = []
  for (const record of records) {
    for (const source of record.sourceViews) {
      const key = source.status === 'visible' ? `visible:${source.sourceRef}` : `${source.status}:${source.reason}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(source)
    }
  }
  return result
}

function fallbackBody(snapshot: EvidenceSnapshot): string {
  const received = snapshot.records.filter(record => record.reception.state === 'established')
  if (snapshot.completeness !== 'complete') {
    if (received.length === 0) {
      return '当前来源范围不完整，无法确认居民是否听过这件事；这不表示居民从未听过。'
    }
    const visible = received.filter(visibleSource)
    const detail = visible.length ? `记录显示居民至少听过${renderSourceLabel(visible[0])}的传话。` : '已有接收记录，但相关来源内容当前不可完整查看。'
    return `${detail}当前来源范围不完整，无法确认全部说法或内容是否属实。`
  }
  if (received.length === 0) {
    return '在本次核对范围内，没有找到可确认的传话记录；这不表示居民从未听过。'
  }
  const conflictGroups = snapshot.groups.filter(group => group.relation === 'documented_conflict')
  if (conflictGroups.length) {
    const byId = evidenceById(snapshot)
    const conflicts = conflictGroups.map(group => renderDifferent(group,
      group.evidenceIds.map(id => byId.get(id)).filter((record): record is EvidenceRecord => Boolean(record))))
    return `${conflicts.join(' ')} 当前无法确认哪一种说法成立。`
  }
  const visible = received.filter(visibleSource)
  if (visible.length) {
    return `${visible.map(renderHeard).join(' ')} 当前没有足够来源确认全部内容。`
  }
  return '记录显示居民有过接收经历，但来源内容无法完整查看，当前不能确认具体说法。'
}

function fallbackSources(snapshot: EvidenceSnapshot): SourceView[] {
  return collectSources(snapshot.records)
}

function fallback(snapshot: EvidenceSnapshot, reason: FallbackReason): GroundedResponse {
  return {
    snapshotId: snapshot.snapshotId,
    body: fallbackBody(snapshot),
    statements: [],
    sources: fallbackSources(snapshot),
    mode: 'fallback',
    fallbackReason: reason,
    canRetry: true,
  }
}

/**
 * Turn a validated candidate into a publishable response. Model-provided
 * prose is intentionally absent from ResponseCandidate; every sentence here
 * is assembled from the immutable snapshot and controlled connectors.
 */
export function finalizeGroundedResponse(
  snapshot: EvidenceSnapshot,
  candidate: ResponseCandidate | null,
  failureReason: FallbackReason = 'generation_failed',
): GroundedResponse {
  if (!candidate) return fallback(snapshot, failureReason)
  if (snapshot.completeness !== 'complete') return fallback(snapshot, 'incomplete_sources')

  try {
    const normalized = parseMessageProvenanceCandidate(candidate)
    validateGroundedCandidate(snapshot, normalized)
    const records = evidenceById(snapshot)
    const groups = groupByTopic(snapshot)
    const statements: GroundedStatement[] = []
    const citedRecords: EvidenceRecord[] = []
    const bodies: string[] = []
    normalized.clauses.forEach((clause, index) => {
      if (clause.kind === 'heard' || clause.kind === 'verified') {
        const clauseRecords = clause.evidenceIds.map(id => records.get(id) as EvidenceRecord)
        citedRecords.push(...clauseRecords)
        const text = clauseRecords.map(record => clause.kind === 'heard' ? renderHeard(record) : renderVerified(record)).join(' ')
        bodies.push(text)
        statements.push({ statementId: `${clause.kind}:${index}`, kind: clause.kind, text, sourceRefs: [...clause.evidenceIds] })
      } else if (clause.kind === 'different_accounts') {
        const group = groups.get(clause.topicKey) as TopicEvidenceGroup
        const groupRecords = clause.evidenceIds.map(id => records.get(id) as EvidenceRecord)
        citedRecords.push(...groupRecords)
        const text = renderDifferent(group, groupRecords)
        bodies.push(text)
        statements.push({ statementId: `different_accounts:${index}`, kind: clause.kind, text, sourceRefs: [...clause.evidenceIds] })
      } else {
        const cannotClause = clause as Extract<CandidateClause, { kind: 'cannot_confirm' }>
        const group = cannotClause.topicKey === null ? undefined : groups.get(cannotClause.topicKey)
        const text = group
          ? `关于${cleanText(group.label, 120)}，目前没有足够来源确认内容是否属实。`
          : '目前没有足够来源确认这件事。'
        const groupRecords = group ? group.evidenceIds.map(id => records.get(id)).filter((record): record is EvidenceRecord => Boolean(record)) : []
        citedRecords.push(...groupRecords)
        bodies.push(text)
        statements.push({ statementId: `cannot_confirm:${index}`, kind: clause.kind, text, sourceRefs: [] })
      }
    })
    const body = bodies.join(' ')
    if (!body || body.length > MAX_BODY_LENGTH) return fallback(snapshot, 'unsupported_candidate')
    return {
      snapshotId: snapshot.snapshotId,
      body,
      statements,
      sources: collectSources(citedRecords),
      mode: 'grounded',
      fallbackReason: null,
      canRetry: true,
    }
  } catch {
    return fallback(snapshot, 'unsupported_candidate')
  }
}
