import {
  applyEdits,
  createEmptyWorld,
  createBlockRegistry,
  serialize,
  validateAssetManifest,
  validateDocument,
  type AssetManifest,
  type LocationBinding,
  type SerializedVoxelDocument,
  type VoxelDocument,
  type VoxelObject,
} from '@possibility/voxel-contract'

/** The small, server-owned input needed to make a fallback scene. */
export interface FallbackLocation {
  name: string
  description?: string
  /** An existing carrier id can be supplied by the server binding context. */
  objectId?: string
  carrierId?: string
  /** When supplied, the published asset is used as this location's carrier. */
  assetId?: string
}

export interface FallbackResident {
  personId: string
  name?: string
  locationName?: string
  objectId?: string
}

export interface FallbackSceneBindings {
  locations?: Array<{ name: string; objectId?: string; carrierId?: string; assetId?: string }>
  residents?: FallbackResident[]
  /** Compatibility with the server-side SceneBindingContext shape. */
  locationBindings?: Array<{ spaceId?: string; carrierId: string; location: { name: string } }>
  personBindings?: Array<{ spaceId?: string; objectId: string; personId: string }>
}

export interface FallbackSceneInput {
  world?: { id?: string; name?: string; description?: string; locations?: Array<FallbackLocation | string> }
  worldId?: string
  worldName?: string
  worldDescription?: string
  locations?: Array<FallbackLocation | string>
  residents?: FallbackResident[]
  bindings?: FallbackSceneBindings
  /** Published asset manifest. Asset ids in locations/requiredAssets must exist here. */
  assets?: AssetManifest | unknown
  assetManifest?: AssetManifest | unknown
  requiredAssets?: string[]
  spaceId?: string
  size?: { width?: number; height?: number; depth?: number }
}

export type FallbackFailureCode =
  | 'invalid-input'
  | 'no-locations'
  | 'binding-conflict'
  | 'asset-unavailable'
  | 'document-invalid'

export interface FallbackFailureIssue {
  code: FallbackFailureCode
  message: string
  field?: string
  value?: string
}

export interface FallbackFailure {
  ok: false
  source: 'fallback'
  code: FallbackFailureCode
  issues: FallbackFailureIssue[]
  explanation: string
}

export interface FallbackSceneSuccess {
  ok: true
  source: 'fallback'
  fallback: true
  document: SerializedVoxelDocument
  /** Stable hash of the serialized document. */
  contentHash: string
  /** Alias used by older callers that call this a document hash. */
  documentHash: string
  explanation: string
  warnings: string[]
  /** The single-space binding list used to build the document. */
  locationBindings: LocationBinding[]
}

export type FallbackSceneResult = FallbackSceneSuccess | FallbackFailure

const DEFAULT_SIZE = { width: 16, height: 8, depth: 16 } as const
const DEFAULT_SPACE = 'exterior'

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function stableToken(value: string, fallback: string): string {
  const token = value
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return token || fallback
}

/** FNV-style two-lane hash; no runtime crypto or random values are required. */
export function fallbackContentHash(serialized: string): string {
  const bytes = new TextEncoder().encode(serialized)
  let left = 0x811c9dc5
  let right = 0x9e3779b9
  for (const byte of bytes) {
    left = Math.imul(left ^ byte, 0x01000193)
    right = Math.imul(right ^ byte, 0x85ebca6b)
    right = Math.imul(right ^ (right >>> 13), 0xc2b2ae35)
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`
}

function failure(code: FallbackFailureCode, message: string, field?: string, value?: string): FallbackFailure {
  return { ok: false, source: 'fallback', code, issues: [{ code, message, ...(field ? { field } : {}), ...(value ? { value } : {}) }], explanation: message }
}

function inputLocations(input: FallbackSceneInput): FallbackLocation[] {
  const source = input.locations ?? input.world?.locations ?? []
  return source.map((value) => typeof value === 'string' ? { name: value } : value)
}

function manifest(input: FallbackSceneInput): AssetManifest | null {
  const raw = input.assets ?? input.assetManifest
  if (raw === undefined) return null
  const checked = validateAssetManifest(raw)
  return checked.ok ? checked.manifest : null
}

function bindingForLocation(input: FallbackSceneInput, location: FallbackLocation): FallbackLocation {
  const explicit = input.bindings?.locations?.find((candidate) => candidate.name === location.name)
  const context = input.bindings?.locationBindings?.find((candidate) => candidate.location.name === location.name)
  return {
    ...location,
    ...(explicit?.objectId || explicit?.carrierId ? { objectId: explicit.objectId ?? explicit.carrierId } : {}),
    ...(explicit?.assetId ? { assetId: explicit.assetId } : {}),
    ...(context ? { objectId: context.carrierId } : {}),
  }
}

function inputResidents(input: FallbackSceneInput): FallbackResident[] {
  const direct = input.residents ?? input.bindings?.residents ?? []
  const bound = input.bindings?.personBindings ?? []
  const byId = new Map(direct.map((resident) => [resident.personId, resident]))
  for (const resident of bound) {
    byId.set(resident.personId, { ...(byId.get(resident.personId) ?? { personId: resident.personId }), objectId: resident.objectId })
  }
  return [...byId.values()]
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function buildDocument(input: FallbackSceneInput, locations: FallbackLocation[], residents: FallbackResident[], assets: AssetManifest | null): { document: VoxelDocument; locationBindings: LocationBinding[] } {
  const requested = input.size ?? {}
  const markerCount = locations.filter((_, index) => index > 0).length + residents.length
  const width = Math.max(positiveInt(requested.width, DEFAULT_SIZE.width), 16 + markerCount * 4)
  const depth = Math.max(positiveInt(requested.depth, DEFAULT_SIZE.depth), DEFAULT_SIZE.depth)
  const height = Math.max(positiveInt(requested.height, DEFAULT_SIZE.height), DEFAULT_SIZE.height)
  let document = createEmptyWorld({ width, height, depth }, 'mist-manor', input.world?.id ?? input.worldId ?? 'fallback-world')

  // A full grass floor and a three-cell cobble road make the exterior immediately walkable.
  const roadFrom = { x: 0, y: 0, z: 1 }
  const roadTo = { x: width - 1, y: 0, z: 3 }
  const ops = [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: width - 1, y: 0, z: depth - 1 }, block: 'grass' },
    { kind: 'fill', from: roadFrom, to: roadTo, block: 'cobble' },
  ] as const
  document = applyEdits(document, [...ops]).document

  const locationBindings: LocationBinding[] = []
  const occupiedCarriers = new Set<string>()
  let markerIndex = 0
  for (const [index, location] of locations.entries()) {
    const explicitId = location.objectId ?? location.carrierId
    const carrierId = explicitId ?? `location-${stableToken(location.name, `spot-${index}`)}`
    const anchor = index === 0 && !location.assetId
      ? { x: 3, y: 1, z: 6 }
      : { x: 12 + markerIndex++ * 4, y: 1, z: 6 }
    if (location.assetId && assets) {
      const entry = assets.assets[location.assetId]
      const assetWidth = entry?.footprint[0] ?? 1
      const assetDepth = entry?.footprint[1] ?? 1
      const safeAnchor = { x: Math.min(anchor.x, width - assetWidth), y: 1, z: Math.min(anchor.z, depth - assetDepth) }
      document = applyEdits(document, [{ kind: 'place-asset', assetId: location.assetId, anchor: safeAnchor, rotation: 0, placementId: carrierId, seed: index }]).document
    } else {
      document = applyEdits(document, [{
        kind: 'place-object', objectType: index === 0 ? 'manor-main-house' : 'stone-lantern',
        anchor, rotation: 0, objectId: carrierId, label: location.name,
      }]).document
    }
    occupiedCarriers.add(carrierId)
    locationBindings.push({ name: location.name, objectId: carrierId })
  }

  const residentObjects: VoxelObject[] = []
  for (const resident of residents) {
    const objectId = resident.objectId ?? `resident-${stableToken(resident.personId, `person-${residentObjects.length}`)}`
    const anchor = { x: 12 + markerIndex++ * 4, y: 1, z: 2 }
    document = applyEdits(document, [{ kind: 'place-object', objectType: 'stone-lantern', anchor, rotation: 0, objectId, label: resident.name }]).document
    residentObjects.push({ id: objectId, objectType: 'stone-lantern', anchor, rotation: 0, ...(resident.name ? { label: resident.name } : {}), binding: { kind: 'person', personId: resident.personId } })
  }
  if (residentObjects.length > 0) {
    const residentIds = new Map(residentObjects.map((object) => [object.id, object]))
    document = { ...document, objects: document.objects.map((object) => residentIds.get(object.id) ?? object) }
  }
  return { document: { ...document, locations: locationBindings, lockedObjectIds: [...occupiedCarriers] }, locationBindings }
}

/** Construct a deterministic, enterable fallback scene without calling a provider. */
export function buildFallbackScene(input: FallbackSceneInput): FallbackSceneResult {
  const worldName = clean(input.world?.name ?? input.worldName) || '未命名世界'
  const locations = inputLocations(input).map((location) => bindingForLocation(input, location))
  if (locations.length === 0) return failure('no-locations', '保底场景至少需要一个世界地点。', 'locations')
  const invalidLocation = locations.find((location) => !clean(location.name))
  if (invalidLocation) return failure('invalid-input', '地点名称不能为空。', 'locations')

  const locationNames = new Set<string>()
  const carrierIds = new Set<string>()
  for (const [index, location] of locations.entries()) {
    const carrier = location.objectId ?? location.carrierId ?? `location-${stableToken(location.name, `spot-${index}`)}`
    if (locationNames.has(location.name) || carrierIds.has(carrier)) {
      return failure('binding-conflict', `地点绑定冲突：地点「${location.name}」或载体「${carrier}」重复。`, 'bindings', carrier)
    }
    locationNames.add(location.name)
    carrierIds.add(carrier)
  }

  const residents = inputResidents(input)
  const residentIds = new Set<string>()
  for (const resident of residents) {
    if (!clean(resident.personId) || residentIds.has(resident.personId)) return failure('binding-conflict', `居民绑定冲突：居民「${resident.personId}」重复。`, 'residents', resident.personId)
    const objectId = resident.objectId ?? `resident-${stableToken(resident.personId, 'person')}`
    if (carrierIds.has(objectId)) return failure('binding-conflict', `居民载体「${objectId}」与地点载体冲突。`, 'residents', objectId)
    residentIds.add(resident.personId)
    carrierIds.add(objectId)
    if (resident.locationName && !locationNames.has(resident.locationName)) return failure('binding-conflict', `居民「${resident.personId}」绑定了不存在的地点「${resident.locationName}」。`, 'residents', resident.locationName)
  }

  const requiredAssets = [...(input.requiredAssets ?? []), ...locations.flatMap((location) => location.assetId ? [location.assetId] : [])]
  const uniqueAssets = [...new Set(requiredAssets)]
  if (uniqueAssets.length > 0) {
    const assets = manifest(input)
    if (!assets) return failure('asset-unavailable', '保底场景需要资产，但当前资产清单不可用。', 'assets')
    const missing = uniqueAssets.find((assetId) => !assets.assets[assetId])
    if (missing) return failure('asset-unavailable', `保底场景所需资产「${missing}」不可用。`, 'assets', missing)
  }
  const assets = manifest(input)
  const built = buildDocument(input, locations, residents, assets)
  const issues = validateDocument(built.document, createBlockRegistry('mist-manor'), assets ?? undefined)
  if (issues.length > 0) {
    return {
      ok: false,
      source: 'fallback',
      code: 'document-invalid',
      issues: issues.map((issue) => ({ code: 'document-invalid', message: issue.message })),
      explanation: '保底场景未通过体素文档校验，未生成可保存结果。',
    }
  }
  const serialized = serialize(built.document)
  const contentHash = fallbackContentHash(serialized)
  return {
    ok: true,
    source: 'fallback',
    fallback: true,
    document: JSON.parse(serialized) as SerializedVoxelDocument,
    contentHash,
    documentHash: contentHash,
    explanation: `「${worldName}」已生成保底场景，包含固定入口、道路和最小建筑，可继续修复或编辑。`,
    warnings: ['当前场景来自确定性保底构造器。'],
    locationBindings: built.locationBindings,
  }
}

/** Name used by callers that model fallback as scene creation. */
export const createFallbackScene = buildFallbackScene
