import { commitScene, readSceneVersion, SceneConflict } from './repository'
import type { Db } from '../db/client'
import type { SceneValidationAccess } from './compatibility/context'
import { inspectSceneCompatibility, SceneCompatibilityServiceError } from './compatibility/service'

/**
 * 场景服务(S2 起):2D operations 增量通道已退役,体素信封走 voxel-revision。
 * 历史恢复走完整 A1 流程:先对目标版本做完整诊断,有效目标才允许提交;
 * 无效目标返回 compatibility-required 交给兼容修复流程,未完成检查一律拒绝。
 */
export async function restoreSceneVersion(db: Db, input: {
  worldId: string
  expectedVersion: number
  targetVersion: number
  requestId: string
  access: SceneValidationAccess
}) {
  const inspection = await inspectSceneCompatibility(db, {
    worldId: input.worldId,
    target: { kind: 'history', version: input.targetVersion },
    access: input.access,
  })
  if (inspection.status === 'missing') throw new SceneConflict('找不到要恢复的场景版本')
  if (inspection.status !== 'ready') {
    throw new SceneCompatibilityServiceError(inspection.error.message, inspection.error.code, 422)
  }
  if (inspection.report.status === 'invalid') {
    throw new SceneCompatibilityServiceError('目标版本未通过完整校验，请先使用兼容修复流程', 'compatibility-required', 422, inspection.report)
  }
  if (inspection.report.status === 'incomplete') {
    throw new SceneCompatibilityServiceError('目标版本检查未完成，不能恢复', 'validation-incomplete', 422, inspection.report)
  }
  const target = await readSceneVersion(db, input.worldId, input.targetVersion)
  if (!target) throw new SceneConflict('找不到要恢复的场景版本')
  const audit = {
    purpose: 'restore-history' as const,
    source: inspection.source,
    basis: inspection.basis,
    changes: [],
    draftId: null,
    requestId: input.requestId,
  }
  return commitScene(db, {
    worldId: input.worldId,
    expectedVersion: input.expectedVersion,
    requestId: input.requestId,
    document: target.document,
    summary: `恢复到场景 v${target.version}`,
    kind: 'restore',
    compatibilityJson: JSON.stringify(audit),
  })
}
