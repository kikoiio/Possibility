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
import { readCurrentScene } from '../repository'

export interface SceneValidationAccess {
  /** Authoritative bindings resolved by the caller after access checks. */
  bindings: SceneBindingContext
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
  const policy = await db.select().from(sceneValidationPolicy)
    .where(eq(sceneValidationPolicy.id, 'active')).get()
  const assets = access.assets ?? libraryManifest()
  if (!assets) throw new Error('资产清单不可用')

  const assetManifestHash = access.assetManifestHash ?? policy?.assetManifestHash ?? await hash(assets)
  const templateCatalogHash = access.templateCatalogHash ?? policy?.templateCatalogHash ?? await hash('mist-manor-template-catalog-v1')
  const bindingHash = access.bindingHash ?? await hash(access.bindings)
  const rulesVersion = access.rulesVersion ?? policy?.rulesVersion ?? 'voxel-scene-validation-v1'
  const contextFingerprint = access.contextFingerprint ?? await hash({
    rulesVersion, assetManifestHash, templateCatalogHash, bindingHash,
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
 * Authoritative bindings derived from the owned world and its stored scene.
 * Never derived from request payloads. Person/location bindings come from the
 * world's own residents/locations matched against scene carriers; locked and
 * semantically bound objects/placements become protected with explicit reasons.
 */
export async function loadWorldSceneBindings(db: Db, worldId: string): Promise<SceneBindingContext> {
  const world = await db.select({ locationsJson: worlds.locationsJson }).from(worlds).where(eq(worlds.id, worldId)).get()
  const people = await db.select({ personId: worldPersons.personId }).from(worldPersons).where(eq(worldPersons.worldId, worldId)).all()
  const scene = await readCurrentScene(db, worldId)
  const locations = jsonArray(world?.locationsJson).flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const value = item as { name?: unknown; stableId?: unknown }
    return typeof value.name === 'string' ? [{ name: value.name, ...(typeof value.stableId === 'string' ? { stableId: value.stableId } : {}) }] : []
  })
  const spaces = scene && isSerializedVoxelSpaces(scene.document)
    ? scene.document.spaces.map(space => ({ spaceId: space.id, document: space.document }))
    : scene && isSerializedVoxelDocument(scene.document) ? [{ spaceId: 'single', document: scene.document }] : []
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
      if (object.binding?.kind === 'person' && object.binding.personId && people.some(person => person.personId === object.binding?.personId)) {
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
    personIds: people.map(person => person.personId),
    locations,
    protectedObjects,
    protectedPlacements,
    locationBindings,
    personBindings,
    entries,
  }
}
