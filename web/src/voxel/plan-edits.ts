import { serialize, type EditOperation } from '@possibility/voxel-contract'
import { getToken } from '../api/client'
import type { VoxelEngine } from './engine'

export type EditPlanFailureKind = 'permission' | 'input' | 'budget' | 'config' | 'planning' | 'service'

export class EditPlanRequestError extends Error {
  constructor(
    message: string,
    readonly kind: EditPlanFailureKind,
    readonly retryable: boolean,
    readonly nextStep?: string,
  ) {
    super(message)
    this.name = 'EditPlanRequestError'
  }
}

/**
 * 共享 AI 编辑规划器：直连 /api/voxel/edit-plan。
 * 产品世界画布与原世界补建页共用；每次请求都绑定可核验的世界 ID。
 * 开发 fixture 和未保存的新世界草稿不会调用此接口。
 */
export async function planEditsViaApi(engine: VoxelEngine, worldId: string, intent: string): Promise<EditOperation[]> {
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
    error?: string
    kind?: EditPlanFailureKind
    retryable?: boolean
    nextStep?: string
  }
  if (!res.ok || !body.ops) {
    const kind = body.kind ?? (res.status === 401 || res.status === 403 || res.status === 404 ? 'permission' : 'service')
    const retryable = body.retryable ?? (kind === 'service' || kind === 'planning')
    throw new EditPlanRequestError(body.error ?? `AI 改造请求失败（${res.status}）。`, kind, retryable, body.nextStep)
  }
  return body.ops
}
