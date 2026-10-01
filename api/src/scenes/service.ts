import { commitScene, readSceneVersion, SceneConflict } from './repository'
import type { Db } from '../db/client'

/** 场景服务(S2 起):2D operations 增量通道已退役,体素信封走 voxel-revision;此处只剩版本恢复 */
export async function restoreSceneVersion(db: Db, input: { worldId: string; expectedVersion: number; targetVersion: number; requestId: string }) {
  const target = await readSceneVersion(db, input.worldId, input.targetVersion)
  if (!target) throw new SceneConflict('找不到要恢复的场景版本')
  return commitScene(db, { worldId: input.worldId, expectedVersion: input.expectedVersion, requestId: input.requestId, document: target.document, summary: `恢复到场景 v${target.version}`, kind: 'restore' })
}
