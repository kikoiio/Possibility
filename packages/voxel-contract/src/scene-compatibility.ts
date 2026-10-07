import type { AssetManifest } from './assets'
import type { AssetPlacement, EditOperation, VoxelCoord, VoxelDocument } from './types'
import type { SerializedVoxelDocument, SerializedVoxelSpaces } from './serialize'

/** Serialized scene documents accepted by the voxel storage and transport layers. */
export type SceneDocument = SerializedVoxelDocument | SerializedVoxelSpaces
/** Server-side name for the same stored document union; kept out of the public API package. */
export type StoredSceneDocument = SceneDocument

/** The scene being inspected. World identity is supplied by service-layer inputs. */
export type SceneTarget =
  | { kind: 'current' }
  | { kind: 'history'; version: number; targetRevisionId?: string }

export type CompatibilityPurpose = 'repair-current' | 'restore-history'

export type SceneCandidate =
  | {
      kind: 'operations'
      spaceId?: string
      operations: EditOperation[]
      id?: string
      source?: SceneSourceRef
      label?: string
      explanation?: string
    }
  | {
      kind: 'document'
      spaceId?: string
      document: unknown
      id?: string
      source?: SceneSourceRef
      label?: string
      explanation?: string
    }

export interface SceneSourceRef {
  worldId: string
  version: number
  contentHash: string
  /** X1 scene identity. Absent only for legacy world-scoped A1 records. */
  timelineId?: string
  representation?: string
  /** Optional selected space identity for space-specific inspection/repair. */
  spaceId?: string
  /** Stable revision identity, including when the visible source is an ancestor. */
  targetRevisionId?: string
}

export interface SceneValidationBasis {
  expectedCurrentVersion: number
  currentContentHash: string
  source: SceneSourceRef
  candidateHash: string | null
  rulesVersion: string
  assetManifestHash: string
  templateCatalogHash: string
  bindingHash: string
  contextFingerprint: string
  baseline: {
    id: string
    status: string
    sceneVersion: number
    contentHash: string
  } | null
}

export interface SceneBindingContext {
  personIds: string[]
  locations: Array<{ name: string; stableId?: string }>
  protectedObjects: Array<{ spaceId: string; objectId: string; reasons: string[] }>
  protectedPlacements: Array<{ spaceId: string; placementId: string; reasons: string[] }>
  locationBindings: Array<{
    spaceId: string
    carrierId: string
    location: { name: string; stableId?: string }
  }>
  personBindings: Array<{ spaceId: string; objectId: string; personId: string }>
  entries: Array<{
    fromSpaceId: string
    at: VoxelCoord
    toSpaceId: string
    carrierId?: string
  }>
}

export interface SceneValidationContext {
  rulesVersion: string
  assets: AssetManifest
  bindings: SceneBindingContext
  assetManifestHash: string
  templateCatalogHash: string
  bindingHash: string
  contextFingerprint: string
}

export type SceneCompatibilityFormat = 'single' | 'spaces'

export interface SceneCompatibilityEnvelope {
  original: StoredSceneDocument
  spaces: Array<{ spaceId: string; document: VoxelDocument }>
  format: SceneCompatibilityFormat
  compatibilityChanges: SceneRepairChange[]
}

export type SceneDecodeResult =
  | { status: 'ready'; envelope: SceneCompatibilityEnvelope }
  | { status: 'unsupported' | 'corrupt'; issues: SceneIssue[] }

/** Compatibility aliases used by callers that name the envelope operation explicitly. */
export type SceneCompatibilityDecodeResult = SceneDecodeResult
export type SceneCompatibilityEnvelopeDecodeResult = SceneDecodeResult

export type SceneIssueOrigin = 'existing' | 'edit' | 'repair'
export type SceneIssueCategory =
  | 'format'
  | 'structure'
  | 'asset'
  | 'binding'
  | 'connection'
  | 'walkability'
export type SceneIssueCode =
  | 'invalid-envelope'
  | 'invalid-document'
  | 'unsupported-format'
  | 'unsupported-version'
  | 'unsupported-size'
  | 'scene-missing'
  | 'scene-corrupt'
  | 'scene-invalid'
  | 'asset-collision'
  | 'asset-unsupported'
  | 'asset-overlap'
  | 'asset-unsupported'
  | 'walk-clearance'
  | 'walk-connectivity'
  | 'walk-lighting'
  | 'walk-stairs'
  | 'walk-gap'
  | 'binding-mismatch'
  | 'missing-location'
  | 'missing-resident'
  | 'connection-invalid'
  | 'context-unavailable'
  | 'budget-exceeded'
  | 'cancelled'
  | 'deadline'
  | string

export interface SceneIssue {
  id: string
  code: SceneIssueCode
  origin: SceneIssueOrigin
  category: SceneIssueCategory
  spaceId: string | null
  objectId?: string
  placementId?: string
  at?: VoxelCoord
  summary: string
  suggestion: string
  blocking: true
  reason?: 'collision' | 'unsupported'
  relatedObjectIds?: string[]
  relatedPlacementIds?: string[]
  /** Legacy transport spelling; new reports use summary. */
  message?: string
}

export interface SceneRuleNote {
  code: 'furniture-cavity'
  spaceId: string
  objectId: string
  at: VoxelCoord
  message: string
}

export type SceneStopReason =
  | 'unsupported-size'
  | 'work-limit'
  | 'visit-limit'
  | 'issue-limit'
  | 'attempt-limit'
  | 'deadline'
  | 'cancelled'
  | 'context-unavailable'
  | 'payload-limit'
  | 'space-limit'
  | 'workspace-limit'

export interface SceneValidationReport {
  status: 'valid' | 'invalid' | 'incomplete'
  issues: SceneIssue[]
  issueCount: number
  countIsExact: boolean
  stopReason: SceneStopReason | null
  checkedSpaceIds: string[]
  pendingSpaceIds: string[]
  workUnitsUsed: number
  /** Deterministic algorithm workspace accounting; excludes JS runtime/process RSS. */
  workspaceBytesUsed?: number
  /** Number of cells actually visited by the walkability floods in this report. */
  visitedCellsUsed?: number
  elapsedMs: number
  ruleNotes: { items: SceneRuleNote[]; total: number; hasMore: boolean }
}

/** Compatibility spelling retained for existing consumers. */
export type SceneCompatibilityReport = SceneValidationReport
export type SceneReport = SceneValidationReport

export interface SceneWorkBudget {
  maxWorkUnits: number
  maxVisitedPerFlood: number
  maxCollectedIssues: number
  maxRepairCandidates: number
  maxRepairPasses: number
  maxWallMs: number
  maxWorkspaceBytes: number
  maxSerializedBytes: number
  maxSpaces: number
  /** Optional tighter repair-specific limits used by the pure repair planner. */
  maxRepairChanges?: number
  /** Aggregate work cap across initial inspection and every repair-candidate revalidation. */
  maxRepairWorkUnits?: number
  maxDraftWallMs?: number
}

export interface SceneWorkControl {
  signal: AbortSignal
  nowMs(): number
  yieldControl(): Promise<void>
}

/** Compatibility aliases for early callers; new code should use SceneWorkBudget/SceneWorkControl. */
export type SceneBudget = SceneWorkBudget
export type SceneControl = Partial<SceneWorkControl> & {
  budget?: Partial<SceneWorkBudget>
  deadlineAt?: number
  onStop?: (reason: SceneStopReason) => void
  now?: () => number
}

export type SceneRepairChange =
  | {
      id: string
      spaceId: string
      issueIds: string[]
      summary: string
      kind: 'move-asset'
      placementId: string
      from: VoxelCoord
      to: VoxelCoord
    }
  | {
      id: string
      spaceId: string
      issueIds: string[]
      summary: string
      kind: 'remove-asset'
      placementId: string
      original: AssetPlacement
    }
  | {
      id: string
      spaceId: string
      issueIds: string[]
      summary: string
      kind: 'set-block'
      at: VoxelCoord
      fromBlock: string
      toBlock: string
    }
  | {
      id: string
      spaceId: string
      issueIds: string[]
      summary: string
      kind: 'assign-placement-id'
      placementIndex: number
      placementId: string
    }

export type SceneRepairResult =
  | {
      status: 'ready'
      candidate: StoredSceneDocument
      changes: SceneRepairChange[]
      report: SceneValidationReport
    }
  | {
      status: 'blocked'
      changes: SceneRepairChange[]
      report: SceneValidationReport
    }

export interface SceneCompatibilityDraft {
  id: string
  draftRequestId: string
  actorKey: string
  worldId: string
  purpose: CompatibilityPurpose
  target: SceneTarget
  basis: SceneValidationBasis
  status: 'building' | 'ready' | 'blocked' | 'cancelled' | 'superseded'
  candidate: StoredSceneDocument | null
  changes: SceneRepairChange[]
  report: SceneValidationReport | null
  createdAt: string
  updatedAt: string
}

export interface CreateCompatibilityDraftInput {
  draftRequestId: string
  worldId: string
  purpose: CompatibilityPurpose
  target: SceneTarget
  expectedCurrentVersion: number
}

export interface ConfirmCompatibilityInput {
  worldId: string
  draftId: string
  requestId: string
  expectedCurrentVersion: number
  expectedAttempt: number
}

export interface SceneRepairAudit {
  purpose: CompatibilityPurpose
  source: SceneSourceRef
  basis: SceneValidationBasis
  changes: SceneRepairChange[]
  draftId: string
  requestId: string
}

export interface SceneCommitResult {
  worldId: string
  version: number
  contentHash: string
  requestId: string
  document: StoredSceneDocument
  outcome: 'repaired-current' | 'restored-history'
  audit: SceneRepairAudit
}

export interface SceneCompatibilityRequest {
  worldId: string
  requestId: string
  actorKey: string
  draftId: string
  requestFingerprint: string
  attempt: number
  state: 'submitting' | 'not-committed' | 'completed'
  leaseToken: string | null
  leaseUntil: string | null
  resultVersion: number | null
  failureCode: SceneCompatibilityErrorCode | null
  createdAt: string
  updatedAt: string
}

export type SceneCompatibilityRequestView =
  | { status: 'completed'; attempt: number; result: SceneCommitResult }
  | { status: 'submitting'; attempt: number; retryAllowed: false }
  | { status: 'not-committed'; attempt: number; nextAttempt: number; retryAllowed: true }
  | {
      status: 'not-committed'
      attempt: number
      retryAllowed: false
      error: SceneCompatibilityFailure
    }
  | { status: 'missing'; retryAllowed: false }
  | { status: 'unknown'; retryAllowed: false }

export type SceneCompatibilityErrorCode =
  | 'world-unavailable'
  | 'authentication-required'
  | 'edit-forbidden'
  | 'scene-missing'
  | 'scene-corrupt'
  | 'format-unsupported'
  | 'context-unavailable'
  | 'validation-incomplete'
  | 'scene-invalid'
  | 'compatibility-required'
  | 'draft-blocked'
  | 'draft-unavailable'
  | 'repair-not-required'
  | 'scene-changed'
  | 'basis-changed'
  | 'request-mismatch'
  | 'preflight-required'
  | 'storage-failure'
  | 'result-unknown'
  | 'service-busy'

export interface SceneCompatibilityFailure {
  code: SceneCompatibilityErrorCode
  message: string
  action: 'sign-in' | 'recheck' | 'review-repair' | 'query-result' | 'retry-same-request' | 'return'
  report?: SceneValidationReport
}

export type SceneIssuePage = {
  items: SceneIssue[]
  offset: number
  limit: number
  total: number
  countIsExact: boolean
  hasMore: boolean
}

export type SceneRepairChangePage = {
  items: SceneRepairChange[]
  offset: number
  limit: number
  total: number
  hasMore: boolean
}

export type SceneValidationReportView = Omit<SceneValidationReport, 'issues'> & {
  issues: SceneIssuePage
}

export type SceneRepairAuditView = Omit<SceneRepairAudit, 'changes'> & {
  changes: SceneRepairChangePage
}

export interface SceneCompatibilityDraftView {
  id: string
  worldId: string
  purpose: CompatibilityPurpose
  target: SceneTarget
  basis: SceneValidationBasis
  status: SceneCompatibilityDraft['status']
  previewSpaces: { spaceId: string; name: string }[]
  canConfirm: boolean
  changes: SceneRepairChangePage
  report: SceneValidationReportView | null
  createdAt: string
  updatedAt: string
}

export type SceneCommitReceipt = Omit<SceneCommitResult, 'document' | 'audit'> & {
  source: SceneSourceRef
  rulesVersion: string
}

export type SceneCompatibilityFailureView = Omit<SceneCompatibilityFailure, 'report'> & {
  report?: SceneValidationReportView
}

export type SceneCompatibilityRequestResponse =
  | { status: 'completed'; attempt: number; result: SceneCommitReceipt }
  | { status: 'submitting'; attempt: number; retryAllowed: false }
  | { status: 'not-committed'; attempt: number; nextAttempt: number; retryAllowed: true }
  | {
      status: 'not-committed'
      attempt: number
      retryAllowed: false
      error: SceneCompatibilityFailureView
    }
  | { status: 'missing' | 'unknown'; retryAllowed: false }

export interface SceneInspectionResultReady {
  status: 'ready'
  source: SceneSourceRef
  basis: SceneValidationBasis
  report: SceneValidationReport
  canCreateRepairDraft: boolean
}

export type SceneInspectionResult =
  | SceneInspectionResultReady
  | { status: 'missing' | 'corrupt' | 'unsupported'; error: SceneCompatibilityFailure }

export type SceneEditPreflightResult =
  | { status: 'valid'; basis: SceneValidationBasis & { candidateHash: string }; report: SceneValidationReport }
  | { status: 'invalid' | 'incomplete'; report: SceneValidationReport }
  | { status: 'compatibility-required'; report: SceneValidationReport }

/** Public aliases for the remaining lifecycle DTOs used by older callers. */
export type SceneDraftRequest = CreateCompatibilityDraftInput
export type SceneConfirmRequest = ConfirmCompatibilityInput
export type SceneAuditRequest = SceneRepairAudit
export type SceneCommitRequest = ConfirmCompatibilityInput
export type SceneValidationIssue = SceneIssue
export type SceneVoxelValidationIssue = SceneIssue

export interface SceneHttpError {
  code: SceneCompatibilityErrorCode
  message: string
  requestId?: string
  issues?: SceneIssue[]
  retryable?: boolean
  details?: Record<string, unknown>
}

export interface SceneHttpErrorView {
  errorCode: SceneCompatibilityErrorCode
  error: string
  requestId?: string
  issues?: SceneIssuePage
  retryable?: boolean
}
