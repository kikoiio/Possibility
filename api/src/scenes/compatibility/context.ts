import { and, eq } from 'drizzle-orm'
import {
  isSerializedVoxelDocument,
  isSerializedVoxelSpaces,
  type AssetManifest,
  type SceneBindingContext,
  type SceneSourceRef,
  type SceneValidationContext,
} from '@possibility/voxel-contract'
import { libraryManifest } from '../../voxel/library-manifest'
import type { Db } from '../../db/client'
import { sceneValidationPolicy, worlds, worldPersons } from '../../db/schema'
import { readCurrentScene, readCurrentTimelineScene, type StoredSceneDocument, type TimelineSceneScope } from '../repository'
import { stableJson } from './stable-json'

export interface SceneValidationAccess {
  /** Authoritative bindings resolved by the caller after access checks. */
  bindings: SceneBindingContext
  /** Authoritative timeline scene identity; omitted only by legacy A1 callers. */
  scope?: TimelineSceneScope
  /** Space selected by the caller when an operation is space-specific. */
  spaceId?: string
  /** Optional manifest/published fingerprints supplied by a trusted caller. */
  assets?: AssetManifest
  rulesVersion?: string
  assetManifestHash?: string
  templateCatalogHash?: string
  bindingHash?: string
  contextFingerprint?: string
}

async function hash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
  return [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, '0')).join('')
}

async function hashBindings(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)))
  return [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, '0')).join('')
}

/**
 * Build the public validation context after the service has resolved owner access.
 * This function does not perform authorization and never derives bindings from a
 * client payload. The caller supplies authoritative bindings explicitly.
 */
export async function loadSceneValidationContext(
  db: Db,
  worldId: string,
  source: SceneSourceRef,
  access: SceneValidationAccess,
): Promise<SceneValidationContext> {
  if (source.worldId !== worldId) throw new Error('场景来源不属于当前世界')
  if (access.scope && access.scope.worldId !== worldId) throw new Error('场景作用域不属于当前世界')
  if (access.scope && (source as SceneSourceRef & { timelineId?: string; representation?: string }).timelineId !== access.scope.timelineId) {
    throw new Error('场景来源不属于当前时间线')
  }
  if (access.scope && (source as SceneSourceRef & { representation?: string }).representation !== access.scope.representation) {
    throw new Error('场景来源表现与当前作用域不匹配')
  }
  if (access.spaceId && (source as SceneSourceRef & { spaceId?: string }).spaceId !== access.spaceId) {
    throw new Error('场景来源空间与当前作用域不匹配')
  }
  const policy = await db.select().from(sceneValidationPolicy)
    .where(eq(sceneValidationPolicy.id, 'active')).get()
  const assets = access.assets ?? libraryManifest()
  if (!assets) throw new Error('资产清单不可用')

  const assetManifestHash = access.assetManifestHash ?? policy?.assetManifestHash ?? await hash(assets)
  const templateCatalogHash = access.templateCatalogHash ?? policy?.templateCatalogHash ?? await hash('mist-manor-template-catalog-v1')
  const bindingHash = access.bindingHash ?? await hashBindings(access.bindings)
  const rulesVersion = access.rulesVersion ?? policy?.rulesVersion ?? 'voxel-scene-validation-v1'
  const contextFingerprint = access.contextFingerprint ?? await hash({
    rulesVersion, assetManifestHash, templateCatalogHash, bindingHash,
    ...(access.scope ? { scope: access.scope } : {}),
    ...(access.spaceId ? { spaceId: access.spaceId } : {}),
  })

  return {
    rulesVersion,
    assets,
    bindings: access.bindings,
    assetManifestHash,
    templateCatalogHash,
    bindingHash,
    contextFingerprint,
  }
}

function jsonArray(value: string | null | undefined): unknown[] {
  try {
    const parsed = JSON.parse(value ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

/**
 * 纯派生：从（候选或已存储）场景文档与世界成员/地点资料推导绑定上下文。
 * 与 DB 无关——loadWorldSceneBindings 用已存储场景调用，演示 seed 等新初始化
 * 路径用待写入的候选文档调用（此时库中尚无场景可读）。
 */
export function deriveSceneBindings(input: {
  document: StoredSceneDocument | null
  personIds: string[]
  locations: Array<{ name: string; stableId?: string }>
}): SceneBindingContext {
  const { personIds, locations } = input
  const spaces = input.document && isSerializedVoxelSpaces(input.document)
    ? input.document.spaces.map(space => ({ spaceId: space.id, document: space.document }))
    : input.document && isSerializedVoxelDocument(input.document) ? [{ spaceId: 'single', document: input.document }] : []
  const locationBindings: SceneBindingContext['locationBindings'] = []
  const personBindings: SceneBindingContext['personBindings'] = []
  const entries: SceneBindingContext['entries'] = []
  const protectedObjects: SceneBindingContext['protectedObjects'] = []
  const protectedPlacements: SceneBindingContext['protectedPlacements'] = []
  for (const space of spaces) {
    const document = space.document
    const objectIds = new Set((document.objects as Array<{ id: string }>).map(object => object.id))
    const placementIds = new Set(((document.assetPlacements ?? []) as Array<{ id?: string }>).flatMap(placement => placement.id ? [placement.id] : []))
    const locked = new Set((document.lockedObjectIds ?? []) as string[])
    for (const location of document.locations as Array<{ name: string; objectId?: string }>) {
      const worldLocation = locations.find(item => item.name === location.name)
      if (worldLocation && location.objectId) {
        locationBindings.push({ spaceId: space.spaceId, carrierId: location.objectId, location: worldLocation })
        if (objectIds.has(location.objectId)) protectedObjects.push({ spaceId: space.spaceId, objectId: location.objectId, reasons: [`地点「${location.name}」载体`] })
        else if (placementIds.has(location.objectId)) protectedPlacements.push({ spaceId: space.spaceId, placementId: location.objectId, reasons: [`地点「${location.name}」载体`] })
      }
    }
    for (const object of document.objects as Array<{ id: string; binding?: { kind?: string; personId?: string } }>) {
      if (locked.has(object.id)) protectedObjects.push({ spaceId: space.spaceId, objectId: object.id, reasons: ['锁定对象'] })
      if (object.binding?.kind === 'person' && object.binding.personId && personIds.some(personId => personId === object.binding?.personId)) {
        personBindings.push({ spaceId: space.spaceId, objectId: object.id, personId: object.binding.personId })
        protectedObjects.push({ spaceId: space.spaceId, objectId: object.id, reasons: ['人物载体'] })
      }
    }
    for (const entry of document.spaceEntries as Array<{ at: { x: number; y: number; z: number }; spaceId: string; carrierId?: string }>) {
      entries.push({ fromSpaceId: space.spaceId, at: entry.at, toSpaceId: entry.spaceId, ...(entry.carrierId ? { carrierId: entry.carrierId } : {}) })
      if (entry.carrierId && objectIds.has(entry.carrierId)) protectedObjects.push({ spaceId: space.spaceId, objectId: entry.carrierId, reasons: ['空间入口载体'] })
      else if (entry.carrierId && placementIds.has(entry.carrierId)) protectedPlacements.push({ spaceId: space.spaceId, placementId: entry.carrierId, reasons: ['空间入口载体'] })
    }
  }
  return {
    personIds,
    locations,
    protectedObjects,
    protectedPlacements,
    locationBindings,
    personBindings,
    entries,
  }
}

/**
 * Authoritative bindings derived from the owned world and its stored scene.
 * Never derived from request payloads. Person/location bindings come from the
 * world's own residents/locations matched against scene carriers; locked and
 * semantically bound objects/placements become protected with explicit reasons.
 */
export async function loadWorldSceneBindings(db: Db, worldId: string, scope?: TimelineSceneScope, _spaceId?: string): Promise<SceneBindingContext> {
  if (scope && scope.worldId !== worldId) throw new Error('场景作用域不属于当前世界')
  const world = await db.select({ locationsJson: worlds.locationsJson }).from(worlds).where(eq(worlds.id, worldId)).get()
  const people = await db.select({ personId: worldPersons.personId }).from(worldPersons).where(eq(worldPersons.worldId, worldId)).all()
  let scene: Awaited<ReturnType<typeof readCurrentScene>> = null
  try {
    scene = scope ? await readCurrentTimelineScene(db, scope) : await readCurrentScene(db, worldId)
  } catch (error) {
    // Let the compatibility decoder classify an unparsable stored document as corrupt.
    // Other failures (including a missing current revision index) still abort context loading.
    if (!(error instanceof Error) || error.message !== '场景文档损坏：无法解析已保存版本') throw error
  }
  if (scope && !scene) {
    const error = new Error('请求的时间线场景不存在') as Error & { code: string; status: number }
    error.code = 'scene-missing'
    error.status = 404
    throw error
  }
  const locations = jsonArray(world?.locationsJson).flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const value = item as { name?: unknown; stableId?: unknown }
    return typeof value.name === 'string' ? [{ name: value.name, ...(typeof value.stableId === 'string' ? { stableId: value.stableId } : {}) }] : []
  })
  return deriveSceneBindings({
    document: scene?.document ?? null,
    personIds: people.map(person => person.personId),
    locations,
  })
}
