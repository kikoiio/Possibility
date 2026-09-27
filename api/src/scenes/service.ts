import { applySceneOperations, findAsset, hashScene, validateScene } from '@possibility/scene-contract'
import type { SceneDocument, SceneOperation } from '@possibility/scene-contract'
import type { Db } from '../db/client'
import { contemporaryTheme } from '@possibility/scene-contract'
import { commitScene, readCurrentScene, readSceneRequest, readSceneVersion, SceneConflict } from './repository'

export function applyScenePatch(document: SceneDocument, operations: SceneOperation[], running: boolean) {
  if (running) for (const operation of operations) {
    if (operation.type === 'add_object' && operation.object.binding) throw new Error('运行中的世界不能增加模拟地点或居民')
    if (operation.type === 'remove_object') {
      const target = document.objects.find(object => object.id === operation.objectId)
      if (target?.binding) throw new Error('运行中的世界不能删除模拟地点或居民')
    }
    if (operation.type === 'update_object' && (operation.label !== undefined || operation.purpose !== undefined)) {
      const target = document.objects.find(object => object.id === operation.objectId)
      if (target?.binding) throw new Error('运行中的世界不能修改地点语义或居民身份')
    }
    if (operation.type === 'replace_asset') {
      const target = document.objects.find(object => object.id === operation.objectId)
      const replacement = findAsset(contemporaryTheme, operation.assetId)
      const current = target && findAsset(contemporaryTheme, target.assetId)
      const categoryAllowed = target?.binding?.kind === 'location'
        ? current?.category === 'building' && replacement?.category === 'building'
        : target?.binding?.kind === 'person'
          ? current?.category === 'person' && replacement?.category === 'person'
          : target?.binding === null
      if (!categoryAllowed) throw new Error('运行中的世界只能替换兼容的外观，并保留地点与居民身份')
    }
  }
  return applySceneOperations(document, operations, contemporaryTheme)
}

export async function saveSceneRevision(db: Db, input: { worldId: string; expectedVersion: number; requestId: string; operations: SceneOperation[]; running: boolean; summary?: string; kind?: string }) {
  const prior = await readSceneRequest(db, input.worldId, input.requestId)
  if (prior) {
    const priorRow = await readSceneVersion(db, input.worldId, prior.version)
    const parentVersion = priorRow?.version ? prior.version - 1 : 0
    const parent = parentVersion > 0 ? await readSceneVersion(db, input.worldId, parentVersion) : null
    const base: SceneDocument = parent?.document ?? { schemaVersion: 1, themeId: contemporaryTheme.id, size: prior.document.size, version: 0, terrain: [], paths: [], objects: [], lockedObjectIds: [], lockedAreas: [] }
    if (input.expectedVersion !== parentVersion) throw new SceneConflict('同一 request ID 不能用于不同的期望版本')
    const replay = applyScenePatch(base, input.operations, input.running)
    if (await hashScene({ ...replay.document, version: prior.version }) !== prior.contentHash) throw new SceneConflict('同一 request ID 不能提交不同场景内容')
    return prior
  }
  const current = await readCurrentScene(db, input.worldId)
  if (!current && input.expectedVersion !== 0) throw new SceneConflict()
  if (current && current.version !== input.expectedVersion) throw new SceneConflict()
  const base: SceneDocument = current?.document ?? { schemaVersion: 1, themeId: contemporaryTheme.id, size: { columns: 24, rows: 18 }, version: 0, terrain: [], paths: [], objects: [], lockedObjectIds: [], lockedAreas: [] }
  const next = applyScenePatch(base, input.operations, input.running)
  const result = validateScene(next.document, contemporaryTheme)
  if (!result.ok) throw new Error(result.issues.map(issue => `${issue.path}: ${issue.message}`).join('; '))
  return commitScene(db, { worldId: input.worldId, expectedVersion: input.expectedVersion, requestId: input.requestId, document: next.document, summary: input.summary ?? '场景已调整', kind: input.kind ?? 'edit' })
}

export async function restoreSceneVersion(db: Db, input: { worldId: string; expectedVersion: number; targetVersion: number; requestId: string }) {
  const target = await readSceneVersion(db, input.worldId, input.targetVersion)
  if (!target) throw new SceneConflict('找不到要恢复的场景版本')
  return commitScene(db, { worldId: input.worldId, expectedVersion: input.expectedVersion, requestId: input.requestId, document: target.document, summary: `恢复到场景 v${target.version}`, kind: 'restore' })
}
