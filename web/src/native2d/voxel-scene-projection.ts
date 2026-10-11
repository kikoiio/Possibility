/**
 * 阶段 1C：真实 API 体素场景文档 → native2d 场景投影桥。
 *
 * 输入是一次授权读取得到的选定空间文档（含完整多空间信封）与同一 snapshot
 * 转换出的 WorldReadModel；输出 native2d 所需的 SceneDefinition 与
 * ScenePresentation，或结构化 unsupported。全部为纯函数：
 * - 主题/资产注册表只接受文档声明且登记过的主题；未知主题返回 unsupported，
 *   绝不回退到静态庄园样板。
 * - 空间边界、行走格、物件、地点绑定、入口信息均从文档本身推导；
 *   相同输入产生相同输出，不写入布局或世界。
 * - 无法映射到 2D 素材的物体/资产摆放被跳过（不渲染也不阻挡）；其地点
 *   保留为 unrepresented，不虚构位置。
 */

import type { VoxelCoord } from '@possibility/voxel-contract'
import { ASSET_MANIFEST, BUILDING_ENTRY_OFFSETS } from './assets'
import { createInitialLayout } from './layout-validation'
import { buildPresentation } from './presentation'
import { projectEnvironmentFor2d } from './projection'
import type {
  BuildingDefinition,
  GridPoint,
  LocationBinding,
  SceneDefinition,
  ScenePresentation,
  SpaceDefinition,
  StaticSceneObject,
  WorldReadModel,
} from './types'
import { projectEnvironmentFacts } from '../scene/life/environment'
import { resolveSpaceContext } from '../voxel/space-context'

/** 允许 2D 投影的主题：登记表来自冻结的素材清单，不由客户端凭空扩展。 */
export const SUPPORTED_NATIVE2D_THEMES = ['mist-manor'] as const

export function supportsNative2dTheme(theme: string | undefined | null): boolean {
  return typeof theme === 'string' && (SUPPORTED_NATIVE2D_THEMES as readonly string[]).includes(theme)
}

/** 读取信封声明的主题（多空间包取首个空间文档的主题）。 */
export function themeOfEnvelope(envelope: ProjectableSceneEnvelope): string | null {
  return envelope.format === 'voxel-spaces'
    ? envelope.spaces[0]?.document.theme ?? null
    : envelope.theme
}

/** 体素物体模板 → 2D 素材映射；未登记的模板不渲染也不阻挡。 */
const OBJECT_TYPE_TO_2D_ASSET: Readonly<Record<string, string>> = {
  'manor-main-house': 'main-house',
  'manor-two-story-house': 'main-house',
  'manor-greenhouse': 'greenhouse',
  tree: 'tree',
}

const BUILDING_2D_ASSETS: ReadonlySet<string> = new Set(['main-house', 'greenhouse'])

/** 投影桥只依赖文档的这些结构性字段；序列化信封与反序列化文档均可直接传入。 */
export interface ProjectableVoxelDocument {
  readonly format?: 'voxel-document'
  readonly theme: string
  readonly size: { width: number; height: number; depth: number }
  readonly objects: readonly { id: string; objectType: string; anchor: VoxelCoord }[]
  readonly objectCells?: readonly { objectId: string; cells: readonly VoxelCoord[] }[]
  readonly locations?: readonly { name: string; objectId: string }[]
  readonly spaceEntries?: readonly { spaceId: string; label: string; at: VoxelCoord }[]
}

export type ProjectableSceneEnvelope =
  | { readonly format: 'voxel-spaces'; readonly spaces: readonly { readonly id: string; readonly document: ProjectableVoxelDocument }[] }
  | ProjectableVoxelDocument

export interface VoxelSceneProjectionInput {
  /** 完整场景信封（单空间文档或多空间包）。 */
  envelope: ProjectableSceneEnvelope
  /** 本次呈现的选定空间 id。 */
  spaceId: string
  /** 与场景文档同一次读取得到的世界读模型。 */
  world: WorldReadModel
  sceneId: string
  sceneVersion: number
}

export type VoxelSceneProjection =
  | { kind: 'ok'; scene: SceneDefinition; presentation: ScenePresentation }
  | { kind: 'unsupported'; code: string; reason: string }

interface Carrier {
  readonly id: string
  readonly docId: string
  readonly objectType: string | null
  readonly asset2d: string | null
  readonly anchor: GridPoint
  readonly cells: readonly GridPoint[]
}

interface ProjectedSpaceDoc {
  readonly id: string
  readonly document: ProjectableVoxelDocument
  readonly kind: 'exterior' | 'interior' | 'unknown'
}

function asGridPoint(coord: VoxelCoord | [number, number, number]): GridPoint {
  const [x, , z] = Array.isArray(coord) ? coord : [coord.x, coord.y, coord.z]
  return { x, z }
}

function cellKey(point: GridPoint): string {
  return `${point.x},${point.z}`
}

function listSpaces(envelope: ProjectableSceneEnvelope): ProjectedSpaceDoc[] {
  if (envelope.format === 'voxel-spaces') {
    return envelope.spaces.map(space => ({
      id: space.id,
      document: space.document,
      // 文档契约未声明空间元数据字段，但新文档可能携带；解析器按可选元数据读取。
      kind: resolveSpaceContext(space.document as unknown as Parameters<typeof resolveSpaceContext>[0], space.id).kind,
    }))
  }
  return [{ id: 'exterior', document: envelope, kind: 'exterior' }]
}

function objectCellsOf(document: ProjectableVoxelDocument, objectId: string): readonly GridPoint[] {
  const entry = document.objectCells?.find(item => item.objectId === objectId)
  return entry ? entry.cells.map(asGridPoint) : []
}

/** 每个文档的承载者：可渲染/可绑定地点的物体；资产摆放仅作 GLB 候选，不映射 2D。 */
function carriersOf(doc: ProjectedSpaceDoc): Carrier[] {
  const carriers: Carrier[] = []
  for (const object of doc.document.objects) {
    const asset2d = OBJECT_TYPE_TO_2D_ASSET[object.objectType] ?? null
    const cells = objectCellsOf(doc.document, object.id)
    carriers.push({
      id: object.id,
      docId: doc.id,
      objectType: object.objectType,
      asset2d,
      anchor: asGridPoint(object.anchor),
      cells: cells.length > 0 ? cells : [asGridPoint(object.anchor)],
    })
  }
  return carriers
}

/** 物体的内部空间：文档 spaceEntry 落在该物体占地（或其外一圈）内即视为入口。 */
function interiorSpaceOf(carrier: Carrier, doc: ProjectedSpaceDoc): string | null {
  const occupied = new Set(carrier.cells.map(cellKey))
  for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    occupied.add(cellKey({ x: carrier.anchor.x + dx, z: carrier.anchor.z + dz }))
  }
  for (const entry of doc.document.spaceEntries ?? []) {
    if (entry.spaceId === doc.id) continue
    if (occupied.has(cellKey(asGridPoint(entry.at)))) return entry.spaceId
  }
  return null
}

function projectedCells(carrier: Carrier): Set<string> {
  return new Set(carrier.cells.map(cellKey))
}

interface SpaceGeometry {
  readonly bounds: { width: number; depth: number }
  readonly blocked: ReadonlySet<string>
  readonly walkable: readonly GridPoint[]
}

function geometryOf(doc: ProjectedSpaceDoc, carriers: readonly Carrier[]): SpaceGeometry | null {
  const width = doc.document.size?.width
  const depth = doc.document.size?.depth
  if (!Number.isFinite(width) || !Number.isFinite(depth) || (width ?? 0) < 1 || (depth ?? 0) < 1) return null
  const bounds = { width: width as number, depth: depth as number }
  const blocked = new Set<string>()
  for (const carrier of carriers) {
    if (!carrier.asset2d) continue
    for (const cell of projectedCells(carrier)) blocked.add(cell)
  }
  const walkable: GridPoint[] = []
  for (let x = 0; x < bounds.width; x += 1) {
    for (let z = 0; z < bounds.depth; z += 1) {
      const key = cellKey({ x, z })
      if (blocked.has(key)) continue
      // 室内空间的外圈在体素文档里通常是墙体；2D 示意图同样不让行走格贴边。
      if (doc.kind === 'interior' && (x === 0 || z === 0 || x === bounds.width - 1 || z === bounds.depth - 1)) continue
      walkable.push({ x, z })
    }
  }
  return { bounds, blocked, walkable }
}

/** 地点站位：锚点周围优先取未阻挡的邻格，稳定排序；不足 4 个时如实减少。 */
function residentSlotsNear(anchor: GridPoint, geometry: SpaceGeometry): GridPoint[] {
  const candidates: readonly GridPoint[] = [
    { x: anchor.x + 1, z: anchor.z },
    { x: anchor.x - 1, z: anchor.z },
    { x: anchor.x, z: anchor.z + 1 },
    { x: anchor.x, z: anchor.z - 1 },
    { x: anchor.x + 1, z: anchor.z + 1 },
    { x: anchor.x - 1, z: anchor.z - 1 },
  ]
  const slots = candidates.filter(point =>
    point.x >= 0 && point.z >= 0
    && point.x < geometry.bounds.width && point.z < geometry.bounds.depth
    && !geometry.blocked.has(cellKey(point)))
  return slots.slice(0, 4)
}

function insideBounds(point: GridPoint, geometry: SpaceGeometry): boolean {
  return point.x >= 0 && point.z >= 0 && point.x < geometry.bounds.width && point.z < geometry.bounds.depth
}

interface CarrierLookup {
  byLocationName: (name: string) => Carrier | null
  interiorTargetOf: (carrier: Carrier) => string | null
}

function buildCarrierLookup(docs: readonly ProjectedSpaceDoc[], carriersByDoc: ReadonlyMap<string, Carrier[]>): CarrierLookup {
  const byName = new Map<string, Carrier>()
  const interiorByCarrierId = new Map<string, string>()
  for (const doc of docs) {
    const carriers = carriersByDoc.get(doc.id) ?? []
    for (const binding of doc.document.locations ?? []) {
      const carrier = carriers.find(item => item.id === binding.objectId)
      if (carrier && !byName.has(binding.name)) byName.set(binding.name, carrier)
    }
    for (const carrier of carriers) {
      const interior = interiorSpaceOf(carrier, doc)
      if (interior) interiorByCarrierId.set(`${doc.id}\u001f${carrier.id}`, interior)
    }
  }
  return {
    byLocationName: name => byName.get(name) ?? null,
    interiorTargetOf: carrier => interiorByCarrierId.get(`${carrier.docId}\u001f${carrier.id}`) ?? null,
  }
}

/** 内部空间的呈现锚点：优先取指回入口所在空间的 spaceEntry，否则取中心格。 */
function interiorAnchorOf(interior: ProjectedSpaceDoc, fromSpaceId: string, geometry: SpaceGeometry): GridPoint {
  const backEntry = (interior.document.spaceEntries ?? []).find(entry => entry.spaceId === fromSpaceId)
  const candidate = backEntry ? asGridPoint(backEntry.at) : null
  if (candidate && insideBounds(candidate, geometry)) return candidate
  return { x: Math.floor(geometry.bounds.width / 2), z: Math.floor(geometry.bounds.depth / 2) }
}

/**
 * 把一次授权读取得到的选定空间文档投影为 native2d 场景与表现。
 * 相同输入产生相同输出；不发起请求、不写入布局或世界。
 */
export function projectVoxelSpaceScene(input: VoxelSceneProjectionInput): VoxelSceneProjection {
  if (!supportsNative2dTheme(themeOfEnvelope(input.envelope))) {
    return {
      kind: 'unsupported',
      code: 'theme-unsupported',
      reason: '这种 2D 表现还没有适配该世界的场景主题，请改用 3D 视图。',
    }
  }

  const docs = listSpaces(input.envelope)
  const selected = docs.find(doc => doc.id === input.spaceId)
    ?? (input.envelope.format === 'voxel-spaces' ? undefined : docs[0])
  if (!selected) {
    return {
      kind: 'unsupported',
      code: 'space-missing',
      reason: '所选空间在当前场景中不存在，请回到可用空间后重试。',
    }
  }

  const carriersByDoc = new Map<string, Carrier[]>(docs.map(doc => [doc.id, carriersOf(doc)]))
  const carriers = carriersByDoc.get(selected.id) ?? []
  const geometry = geometryOf(selected, carriers)
  if (!geometry || geometry.walkable.length === 0) {
    return {
      kind: 'unsupported',
      code: 'space-unreadable',
      reason: '这个空间暂时无法生成可读的 2D 布局，请改用 3D 视图。',
    }
  }

  const lookup = buildCarrierLookup(docs, carriersByDoc)
  const buildings: BuildingDefinition[] = []
  const bindings: LocationBinding[] = []
  const locationKeysByCarrier = new Map<string, string[]>()
  for (const location of input.world.locations) {
    const carrier = lookup.byLocationName(location.name)
    if (!carrier) continue
    const keys = locationKeysByCarrier.get(`${carrier.docId}\u001f${carrier.id}`) ?? []
    keys.push(location.name)
    locationKeysByCarrier.set(`${carrier.docId}\u001f${carrier.id}`, keys)
  }

  for (const carrier of carriers) {
    if (!carrier.asset2d || !ASSET_MANIFEST[carrier.asset2d]) continue
    if (!BUILDING_2D_ASSETS.has(carrier.asset2d)) continue
    const interiorSpaceId = lookup.interiorTargetOf(carrier)
    const docSpaces = input.envelope.format === 'voxel-spaces' ? input.envelope.spaces : []
    // 只有信封里真实存在目标空间时才登记为可进入的室内建筑。
    const knownInterior = docSpaces.length > 0 && interiorSpaceId != null
      && docSpaces.some(space => space.id === interiorSpaceId)
    buildings.push({
      id: carrier.id,
      assetId: carrier.asset2d,
      spaceId: selected.id,
      initialOrigin: { ...carrier.anchor },
      entryOffset: BUILDING_ENTRY_OFFSETS[carrier.asset2d] ?? { x: 0, z: 1 },
      locationKeys: locationKeysByCarrier.get(`${carrier.docId}\u001f${carrier.id}`) ?? [],
      interiorSpaceId: knownInterior ? interiorSpaceId : null,
    })
  }

  let resolvableBindings = 0
  for (const location of input.world.locations) {
    const carrier = lookup.byLocationName(location.name)
    if (!carrier) {
      bindings.push({
        locationKey: location.name,
        sourceLocationName: location.name,
        representation: { kind: 'unrepresented', buildingId: null },
      })
      continue
    }
    const interiorSpaceId = lookup.interiorTargetOf(carrier)
    if (interiorSpaceId) {
      const interiorDoc = docs.find(doc => doc.id === interiorSpaceId)
      if (interiorDoc) {
        const interiorGeometry = geometryOf(interiorDoc, carriersByDoc.get(interiorDoc.id) ?? [])
        if (interiorGeometry && interiorGeometry.walkable.length > 0) {
          const anchor = interiorAnchorOf(interiorDoc, carrier.docId, interiorGeometry)
          resolvableBindings += 1
          bindings.push({
            locationKey: location.name,
            sourceLocationName: location.name,
            representation: {
              kind: 'interior',
              spaceId: interiorSpaceId,
              entryBuildingId: carrier.id,
              anchor,
              residentSlots: residentSlotsNear(anchor, interiorGeometry),
            },
          })
          continue
        }
      }
    }
    const anchor = carrier.anchor
    if (insideBounds(anchor, geometry)) {
      resolvableBindings += 1
      bindings.push({
        locationKey: location.name,
        sourceLocationName: location.name,
        representation: {
          kind: 'outdoor',
          spaceId: selected.id,
          anchor: { ...anchor },
          residentSlots: residentSlotsNear(anchor, geometry),
        },
      })
      continue
    }
    bindings.push({
      locationKey: location.name,
      sourceLocationName: location.name,
      representation: { kind: 'unrepresented', buildingId: null },
    })
  }

  if (input.world.locations.length > 0 && resolvableBindings === 0) {
    return {
      kind: 'unsupported',
      code: 'locations-unprojectable',
      reason: '这个空间的地点无法映射到 2D 示意图，请改用 3D 视图。',
    }
  }

  const staticObjects: StaticSceneObject[] = []
  for (const carrier of carriers) {
    if (!carrier.asset2d || !ASSET_MANIFEST[carrier.asset2d]) continue
    if (BUILDING_2D_ASSETS.has(carrier.asset2d)) continue
    for (const [index, cell] of carrier.cells.entries()) {
      if (!insideBounds(cell, geometry)) continue
      staticObjects.push({
        id: index === 0 ? carrier.id : `${carrier.id}-${index}`,
        assetId: carrier.asset2d,
        origin: { ...cell },
        blocksMovement: true,
      })
    }
  }

  const space: SpaceDefinition = {
    id: selected.id,
    kind: selected.kind === 'interior' ? 'interior' : 'exterior',
    bounds: { ...geometry.bounds },
    walkableCells: geometry.walkable,
    staticObjects,
    overview: {
      focus: {
        x: Math.floor(geometry.bounds.width / 2),
        z: Math.floor(geometry.bounds.depth / 2),
      },
      paddingPx: 96,
      maxZoom: selected.kind === 'interior' ? 3 : 2,
    },
    connectivityRoot: geometry.walkable[0] ?? null,
  }

  const scene: SceneDefinition = {
    id: input.sceneId,
    version: input.sceneVersion,
    defaultSpaceId: selected.id,
    spaces: [space],
    buildings,
    locationBindings: bindings,
    assetManifest: ASSET_MANIFEST,
  }

  const layout = createInitialLayout(scene, input.world.scope)
  const environmentProjection = projectEnvironmentFacts((input.world.environment ?? []).map(fact => ({
    factType: 'environment' as const,
    value: { location: fact.locationName, condition: fact.condition, value: fact.value },
  })))
  const presentation = {
    ...buildPresentation(input.world, scene, layout, selected.id),
    environment: projectEnvironmentFor2d(environmentProjection),
  }
  return { kind: 'ok', scene, presentation }
}
