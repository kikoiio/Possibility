import { serialize, type EditOperation, type SceneValidationBasis } from '@possibility/voxel-contract'
import type { SceneValidationReportView } from '@possibility/voxel-contract'
import { getToken } from '../api/client'
import type { VoxelEngine } from './engine'

export type EditPlanFailureKind = 'permission' | 'input' | 'budget' | 'config' | 'planning' | 'service' | 'compatibility' | 'conflict'

/** A1(B69):规划成功携带完整候选的预检依据,确认应用时消费同一 basis。 */
export interface EditPlan {
  ops: EditOperation[]
  previewBasis: (SceneValidationBasis & { candidateHash: string }) | null
}

export class EditPlanRequestError extends Error {
  constructor(
    message: string,
    readonly kind: EditPlanFailureKind,
    readonly retryable: boolean,
    readonly nextStep?: string,
    readonly errorCode?: string,
    readonly report?: SceneValidationReportView,
  ) {
    super(message)
    this.name = 'EditPlanRequestError'
  }
}

/**
 * 共享 AI 编辑规划器：直连 /api/voxel/edit-plan。
 * 产品世界画布与原世界补建页共用；每次请求都绑定可核验的世界 ID。
 * 开发 fixture 和未保存的新世界草稿不会调用此接口。
 * A1(W21):服务端模型前闸门的兼容阻断(422 compatibility-required / validation-incomplete)
 * 与依据冲突(409 conflict)按结构化 kind/errorCode 透出,不吞成通用错误。
 */
export async function planEditsViaApi(engine: VoxelEngine, worldId: string, intent: string): Promise<EditPlan> {
  const doc = engine.world?.doc
  if (!doc) throw new Error('世界尚未加载')
  const token = getToken()
  const res = await fetch('/api/voxel/edit-plan', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ worldId, requestId: `plan-${crypto.randomUUID()}`, intent, document: serialize(doc) }),
  })
  const body = await res.json().catch(() => ({})) as {
    ops?: EditOperation[]
    previewBasis?: EditPlan['previewBasis']
    error?: string
    kind?: EditPlanFailureKind
    retryable?: boolean
    nextStep?: string
    errorCode?: string
    report?: SceneValidationReportView
  }
  if (!res.ok || !body.ops) {
    const kind = body.kind ?? (res.status === 401 || res.status === 403 || res.status === 404 ? 'permission' : 'service')
    const retryable = body.retryable ?? (kind === 'service' || kind === 'planning')
    throw new EditPlanRequestError(body.error ?? `AI 改造请求失败（${res.status}）。`, kind, retryable, body.nextStep, body.errorCode, body.report)
  }
  return { ops: body.ops, previewBasis: body.previewBasis ?? null }
}
