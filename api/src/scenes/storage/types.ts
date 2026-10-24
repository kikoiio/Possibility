import type { SerializedVoxelDocument, SerializedVoxelSpaces } from '@wispiva/voxel-contract'
import type { worldSceneRevisions, worldScenes } from '../../db/schema'
import type { PendingSceneBindings, SceneWriteAuthority, SceneWriteProofRequest } from '../compatibility/write-proof'

/** 存储层文档（S2 起）:体素信封或多空间体素包;2D 场景已退役 */
export type StoredSceneDocument = SerializedVoxelDocument | SerializedVoxelSpaces

export interface StoredScene { document: StoredSceneDocument; version: number; contentHash: string; createdAt: string }

export class SceneConflict extends Error { constructor(message = '场景已被其他操作更新，请重新加载') { super(message); this.name = 'SceneConflict' } }

export interface TimelineSceneScope {
  worldId: string
  timelineId: string
  representation: string
}

export interface TimelineSceneRevisionRead extends StoredScene {
  id: string
  worldId: string
  timelineId: string
  representation: string
  requestId: string
  parentRevisionId: string | null
  summary: string
  kind: string
  validationJson: string | null
}

export type TimelineSceneIntegrityErrorCode =
  | 'unsupported-representation'
  | 'missing-head-revision'
  | 'invalid-cursor'
  | 'invalid-parent-chain'
  | 'unreconstructable-history'
  | 'invalid-json'
  | 'invalid-snapshot'
  | 'invalid-space-set'
  | 'hash-mismatch'

export class TimelineSceneIntegrityError extends Error {
  constructor(
    public readonly code: TimelineSceneIntegrityErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TimelineSceneIntegrityError'
  }
}

/** A revision returned by the lineage reader, with its visibility provenance. */
export interface TimelineSceneHistoryRevision extends TimelineSceneRevisionRead {
  /** `current` belongs to the selected line; `ancestor` is before a fork boundary. */
  source: 'current' | 'ancestor'
  sourceTimelineId: string
  /** True when this row is the first row inherited from its immediate parent line. */
  isForkBoundary: boolean
}

export interface TimelineSceneHistoryBoundary {
  fromTimelineId: string
  toTimelineId: string
  revisionId: string
}

export interface TimelineSceneHistoryPage {
  /** Newest first: selected line revisions followed by each ancestor at its cutoff. */
  revisions: TimelineSceneHistoryRevision[]
  /** Alias for callers that use the generic page vocabulary. */
  items: TimelineSceneHistoryRevision[]
  nextCursor: string | null
  hasMore: boolean
  boundaries: TimelineSceneHistoryBoundary[]
}

export interface TimelineSceneHistoryOptions {
  limit?: number
  cursor?: string | null
  /** Start at this revision on the selected line and omit newer rows. */
  cutoffRevisionId?: string
  /** Equivalent version form of cutoffRevisionId for the selected line. */
  cutoffVersion?: number
}

export type TimelineSceneCommitInput = {
  expectedVersion: number
  requestId: string
  document: StoredSceneDocument
  summary: string
  kind: string
  /** Explicit fork boundary. When omitted for a child first commit, the parent head is used. */
  parentRevisionId?: string | null
  authority?: SceneWriteAuthority
  compatibility?: SceneWriteProofRequest
  compatibilityCompletion?: { actorKey: string }
  compatibilityJson?: string | null
  allowBaseline?: boolean
} & ({ scope: TimelineSceneScope } | { worldId: string; timelineId: string; representation?: string })

export class TimelineSceneConflict extends SceneConflict {
  constructor(
    message: string,
    public readonly expectedVersion: number,
    public readonly currentVersion: number,
    public readonly currentRevisionId: string | null,
  ) {
    super(message)
    this.name = 'TimelineSceneConflict'
  }
}

export interface RestoreTimelineSceneInput {
  scope: TimelineSceneScope
  expectedVersion: number
  requestId: string
  /** Parent/ancestor timeline to restore. Defaults to scope.timelineId's parent. */
  ancestorScope?: TimelineSceneScope
  summary?: string
  kind?: string
}

export interface TimelineSceneForkStatementsInput {
  source: TimelineSceneScope
  target: TimelineSceneScope
  requestId: string
  createdAt?: string
}

export interface CloneSceneStatementsInput {
  sourceWorldId: string
  targetWorldId: string
  targetOwnerId: string
  /**
   * 目标世界（与场景同批创建、尚未落库）的待创建绑定快照（B30 同款口径）：
   * 克隆批内读库只能得到空集合，必须由调用方显式给出重映射后的成员与地点。
   */
  pendingBindings: PendingSceneBindings
  /** 源世界的当前场景指针；源世界无场景时传 null（此时 revisions 也必须为空）。 */
  pointer: typeof worldScenes.$inferSelect | null
  /** 源世界的全部场景修订。 */
  revisions: Array<typeof worldSceneRevisions.$inferSelect>
  /** 目标修订 id/请求 id 分配器（调用方掌握确定性重放口径）。 */
  revisionIdFor: (source: typeof worldSceneRevisions.$inferSelect) => Promise<string>
  requestIdFor: (source: typeof worldSceneRevisions.$inferSelect) => Promise<string>
  /** 身份重映射后的文档 JSON（人物/时间线引用已由调用方改写）。 */
  remapDocument: (documentJson: string) => string
  issuedAt?: string
}
