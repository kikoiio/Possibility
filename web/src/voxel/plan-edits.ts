import { serialize, type EditOperation } from '@possibility/voxel-contract'
import type { VoxelEngine } from './engine'

/**
 * 共享 AI 编辑规划器：直连 /api/voxel/edit-plan。
 * /dev/voxel 与产品页 WorldCanvasPage 共用（S2b 从 dev-harness 提取）；
 * e2e 里由路由 stub 接管。
 */
export async function planEditsViaApi(engine: VoxelEngine, intent: string): Promise<EditOperation[]> {
  const doc = engine.world?.doc
  if (!doc) throw new Error('世界尚未加载')
  const res = await fetch('/api/voxel/edit-plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: `plan-${Date.now()}`, intent, document: serialize(doc) }),
  })
  const body = await res.json().catch(() => ({})) as { ops?: EditOperation[]; error?: string }
  if (!res.ok || !body.ops) throw new Error(body.error ?? `规划失败（${res.status}）`)
  return body.ops
}
