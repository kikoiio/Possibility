export type ProvenancePermission = 'owner' | 'guest_sandbox' | 'admin_repair'
export type EvidenceCompleteness = 'complete' | 'partial' | 'unavailable'
export type SourceStatus = 'complete' | 'missing' | 'conflicting'
export type RecordKind = 'knowledge_fact' | 'memory' | 'dialogue_turn' | 'world_fact'

export interface RecordRef {
  kind: RecordKind
  id: string
  timelineId: string
}

export interface PersonLabel {
  personId: string | null
  name: string
}

export interface InformRequest {
  commandId: string
  worldId: string
  timelineId: string
  expectedVersion: number
  recipientId: string
  topic: string
  content: string
}

export interface MessageReceipt {
  receiptId: string
  commandId: string
  factRef: RecordRef
  worldId: string
  timelineId: string
  version: number
  simTime: string
  sender: PersonLabel | null
  recipient: PersonLabel
  topic: string
  content: string
}

export type ReceiptLookup =
  | { status: 'committed'; receipt: MessageReceipt }
  | { status: 'not_found' }

export interface ForkBoundary {
  timelineId: string
  maxVersion: number
  maxSimTime: string
  snapshotRef: string
}

export interface EvidenceScope {
  worldId: string
  timelineId: string
  residentId: string
  simNow: string
  revisionVersion: number
  repairWatermark: number
  principalKey: string
  permission: ProvenancePermission
  ancestors: ForkBoundary[]
}

export interface EvidenceTarget {
  worldId: string
  timelineId: string
  residentId: string
  simNow?: string
  revisionVersion?: number
}

export interface EvidenceQuery {
  receiptId?: string
  topic?: string
  fromSimTime?: string
  cursor?: string
  limit?: number
}

export type SourceView =
  | { status: 'visible'; sourceRef: string; label: string; content: string; simTime: string | null }
  | { status: 'missing' | 'restricted'; reason: string }

export interface EvidenceRecord {
  recordRef: RecordRef
  evidenceId: string
  topicKey: string
  topic: string
  content: string
  simTime: string | null
  version: number | null
  originTimelineId: string
  sender: PersonLabel | null
  recipientId: string
  reception: {
    state: 'established' | 'unresolved'
    status: SourceStatus
    refs: RecordRef[]
  }
  assertion: {
    state: 'unverified' | 'verified'
    status: SourceStatus
    refs: RecordRef[]
  }
  sourceViews: SourceView[]
  repairItemId: string | null
}

export interface TopicEvidenceGroup {
  topicKey: string
  label: string
  evidenceIds: string[]
  relation: 'single_account' | 'multiple_accounts' | 'documented_conflict'
  completeness: EvidenceCompleteness
}

export interface EvidenceSnapshot {
  snapshotId: string
  schemaVersion: 1
  scope: EvidenceScope
  query: EvidenceQuery
  records: EvidenceRecord[]
  groups: TopicEvidenceGroup[]
  completeness: EvidenceCompleteness
  gaps: string[]
  nextCursor: string | null
}

export type CandidateClause =
  | { kind: 'heard' | 'verified'; evidenceIds: string[] }
  | { kind: 'different_accounts'; topicKey: string; evidenceIds: string[] }
  | { kind: 'cannot_confirm'; topicKey: string | null }

export interface ResponseCandidate {
  contractVersion: 'message-provenance/v1'
  tone: 'plain' | 'warm' | 'cautious'
  clauses: CandidateClause[]
}

export interface GroundedStatement {
  statementId: string
  kind: CandidateClause['kind']
  text: string
  sourceRefs: string[]
}

export interface GroundedResponse {
  snapshotId: string
  body: string
  statements: GroundedStatement[]
  sources: SourceView[]
  mode: 'grounded' | 'fallback'
  fallbackReason: 'generation_failed' | 'unsupported_candidate' | 'incomplete_sources' | null
  canRetry: boolean
}

export type ResponseAttemptResult =
  | { status: 'pending'; responseId: string; attemptId: string; stage: 'reading' | 'generating' | 'validating' | 'saving' }
  | { status: 'completed'; responseId: string; attemptId: string; response: GroundedResponse }
  | { status: 'failed'; responseId: string; attemptId: string; reason: string; canRetry: boolean }

export interface RepairScope {
  worldId: string
  timelineId: string
  residentId: string
  recordKinds: Array<'knowledge_fact' | 'memory'>
  createdFrom?: string
  createdThrough?: string
  ruleVersion: 'message-provenance/v1'
}

export interface RepairCursor {
  kind: 'knowledge_fact' | 'memory'
  recordPosition: string | null
  sourcePosition: string | null
}

export interface RepairRun {
  runId: string
  scope: RepairScope
  scopeHash: string
  frozenBounds: { knowledgeFactRow: number; memoryRow: number; evidenceScope: EvidenceScope }
  status: 'pending' | 'running' | 'completed' | 'failed'
  cursor: RepairCursor | null
  counts: { scanned: number; linked: number; alreadyValid: number; insufficientEvidence: number; conflictingEvidence: number }
  batchSize: number
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface RepairItem {
  itemId: string
  runId: string
  record: RecordRef
  status: 'linked' | 'already_valid' | 'insufficient_evidence' | 'conflicting_evidence'
  sourceRefs: RecordRef[]
  linkIds: string[]
  reason: string
  originalDigest: string
  originalExcerpt: string
  committedSequence: number
}

export interface RepairItemsPage {
  items: RepairItem[]
  nextCursor: string | null
}
