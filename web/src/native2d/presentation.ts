/**
 * N2D1 T18+T19：居民与地点表现、场景表现与世界昼夜。
 *
 * resolveResidentPlacement 按地点绑定解析居民定位：
 * - outdoor → 外景锚点区站位；interior → 内景空间站位（大厅居民只在大厅呈现）；
 * - unrepresented → 保留真实地点归属，point 为 null 并给出原因；
 * - locationName 为 null 或无匹配 binding → unknown，保留真实归属，不挪到其他地点。
 *
 * 站位分配：同一地点内按 personId 字典序稳定排序，依次分配该地点的
 * residentSlots（同输入同结果）；站位不足时多余居民保留真实地点，
 * point 为 null、status 为 unrepresented 并给出原因。布局（建筑位置）
 * 不参与定位：移动建筑不改变地点/personId 归属。
 *
 * buildPresentation 组合当前空间的 PresentedObject（建筑/静态物件/地点标记/
 * 可见居民）、PresentedLocation 列表与 timeOfDay：
 * - 居民素材按 personId 排序取模从 resident-a/b/c 稳定分配（同输入同结果）；
 * - timeOfDay 按 effectiveTimeZone(world.timeZone) 下 simNow 的小时推导——
 *   夜 20–6、黎明 6–9、昼 9–17、暮 17–20；simNow 为 null/非法 → 'unknown'；
 *   只用 Intl 按世界时区取小时，不依赖浏览器本地时区，与 formatWorldTime
 *   共用同一时间基准（页面文本与光照相位一致）。
 *
 * 纯函数模块：不修改传入的世界/场景/布局；只导入 ./types 类型、./assets
 * 常量与 ../lib/world-time 的时区工具，不导入 PixiJS。
 */

import type {
  LayoutState,
  PresentedLocation,
  PresentedObject,
  ResidentPlacement,
  SceneDefinition,
  ScenePresentation,
  TimeOfDay,
  WorldReadModel,
  WorldResident,
} from './types'
import { RESIDENT_ASSET_IDS } from './assets'
import { effectiveTimeZone } from '../lib/world-time'

/** 按 personId 字典序稳定排序（返回新数组，不改输入）。 */
function sortByPersonId(residents: readonly WorldResident[]): WorldResident[] {
  return [...residents].sort((a, b) =>
    a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0,
  )
}

/**
 * 解析单个居民的呈现定位。
 *
 * layout 仅承载建筑位置，不影响居民归属（契约约束：布局不承载世界事实）。
 */
export function resolveResidentPlacement(
  world: WorldReadModel,
  scene: SceneDefinition,
  layout: LayoutState,
  personId: string,
): ResidentPlacement {
  void layout

  const resident = world.residents.find((r) => r.personId === personId)
  if (!resident) {
    return {
      personId,
      status: 'unknown',
      spaceId: null,
      point: null,
      reason: '居民不在当前快照',
    }
  }

  const locationName = resident.locationName
  if (locationName === null) {
    return {
      personId,
      status: 'unknown',
      spaceId: null,
      point: null,
      reason: '世界快照未提供该居民的所在地点',
    }
  }

  const binding = scene.locationBindings.find((b) => b.sourceLocationName === locationName)
  if (!binding) {
    return {
      personId,
      status: 'unknown',
      spaceId: null,
      point: null,
      reason: `地点「${locationName}」未绑定到场景，保留真实归属`,
    }
  }

  const representation = binding.representation
  if (representation.kind === 'unrepresented') {
    return {
      personId,
      status: 'unrepresented',
      spaceId: null,
      point: null,
      reason: `地点「${locationName}」本期未提供可呈现的场景，仅保留在场信息`,
    }
  }

  // 同一地点内按 personId 稳定排序分配示意站位；站位是呈现示意，不是世界事实。
  const occupants = sortByPersonId(
    world.residents.filter((r) => r.locationName === locationName),
  )
  const index = occupants.findIndex((r) => r.personId === personId)
  const slots = representation.residentSlots
  if (index >= 0 && index < slots.length) {
    const slot = slots[index]
    return {
      personId,
      status: 'visible',
      spaceId: representation.spaceId,
      point: { x: slot.x, z: slot.z },
      reason: null,
    }
  }

  return {
    personId,
    status: 'unrepresented',
    spaceId: null,
    point: null,
    reason: `地点「${locationName}」示意站位不足（${occupants.length} 人 / ${slots.length} 位），保留真实归属`,
  }
}

/* -------------------------------------------------------------------------- */
/* T19：场景表现与世界昼夜                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 按有效世界时区下 simNow 的小时推导昼夜相位：
 * 夜 20–6、黎明 6–9、昼 9–17、暮 17–20。simNow 为 null/非法或小时不可解析
 * 时返回 'unknown'。timeZone 须先经 effectiveTimeZone 归一。
 */
function deriveTimeOfDay(simNow: string | null, timeZone: string): TimeOfDay {
  if (!simNow) return 'unknown'
  const instant = Date.parse(simNow)
  if (!Number.isFinite(instant)) return 'unknown'
  let hour: number
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant)
    hour = Number(parts.find((p) => p.type === 'hour')?.value)
  } catch {
    return 'unknown'
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return 'unknown'
  if (hour >= 20 || hour < 6) return 'night'
  if (hour < 9) return 'dawn'
  if (hour < 17) return 'day'
  return 'dusk'
}

/** 居民素材稳定分配：按 personId 排序取模 resident-a/b/c（同输入同结果）。 */
function residentAssetId(sortedPersonIds: readonly string[], personId: string): string {
  const index = sortedPersonIds.indexOf(personId)
  const slot = index >= 0 ? index : 0
  return RESIDENT_ASSET_IDS[slot % RESIDENT_ASSET_IDS.length]
}

/**
 * 组合当前空间的 ScenePresentation：建筑（当前空间的布局 placements）、
 * 静态物件、有锚点的地点标记与可见居民；附全部地点的 PresentedLocation
 * 列表与按世界时区推导的 timeOfDay。不修改任何输入。
 */
export function buildPresentation(
  world: WorldReadModel,
  scene: SceneDefinition,
  layout: LayoutState,
  spaceId: string,
): ScenePresentation {
  const space = scene.spaces.find((s) => s.id === spaceId)
  if (!space) {
    throw new Error(`场景 ${scene.id} 中不存在空间 ${spaceId}`)
  }

  const timeZone = effectiveTimeZone(world.timeZone)
  const timeOfDay = deriveTimeOfDay(world.simNow, timeZone)

  const buildingsById = new Map(scene.buildings.map((b) => [b.id, b]))
  const objects: PresentedObject[] = []

  // 建筑：仅当前空间的布局 placements。
  for (const placement of layout.placements) {
    if (placement.spaceId !== spaceId) continue
    const definition = buildingsById.get(placement.buildingId)
    if (!definition) continue
    objects.push({
      id: `building:${placement.buildingId}`,
      kind: 'building',
      assetId: definition.assetId,
      origin: { x: placement.origin.x, z: placement.origin.z },
      selection: { kind: 'building', buildingId: placement.buildingId },
    })
  }

  // 静态物件（装饰/阻挡）：仅当前空间。
  for (const object of space.staticObjects) {
    objects.push({
      id: `decoration:${object.id}`,
      kind: 'decoration',
      assetId: object.assetId,
      origin: { x: object.origin.x, z: object.origin.z },
      selection: null,
    })
  }

  // 地点标记：当前空间有锚点的绑定（outdoor/interior）。
  for (const binding of scene.locationBindings) {
    const representation = binding.representation
    if (representation.kind !== 'outdoor' && representation.kind !== 'interior') continue
    if (representation.spaceId !== spaceId) continue
    objects.push({
      id: `location:${binding.locationKey}`,
      kind: 'location',
      assetId: null,
      origin: { x: representation.anchor.x, z: representation.anchor.z },
      selection: { kind: 'location', locationKey: binding.locationKey },
    })
  }

  // 居民：解析全部定位，仅呈现属于当前空间的 visible 居民。
  const residentPlacements = world.residents.map((r) =>
    resolveResidentPlacement(world, scene, layout, r.personId),
  )
  const sortedPersonIds = sortByPersonId(world.residents).map((r) => r.personId)
  for (const placement of residentPlacements) {
    if (placement.status !== 'visible') continue
    if (placement.spaceId !== spaceId || placement.point === null) continue
    objects.push({
      id: `resident:${placement.personId}`,
      kind: 'resident',
      assetId: residentAssetId(sortedPersonIds, placement.personId),
      origin: { x: placement.point.x, z: placement.point.z },
      selection: { kind: 'resident', personId: placement.personId },
    })
  }

  // PresentedLocation：全部世界 locations + 全部 binding 的并集；
  // 世界里有但 binding 缺失的地点 → representation 'unknown'。
  const bindingsByName = new Map(scene.locationBindings.map((b) => [b.sourceLocationName, b]))
  const residentIdsAt = (locationName: string): string[] =>
    sortByPersonId(world.residents.filter((r) => r.locationName === locationName)).map(
      (r) => r.personId,
    )
  const locations: PresentedLocation[] = []
  const coveredNames = new Set<string>()
  for (const location of world.locations) {
    coveredNames.add(location.name)
    const binding = bindingsByName.get(location.name)
    locations.push({
      locationKey: binding?.locationKey ?? null,
      name: location.name,
      description: location.description,
      residentIds: residentIdsAt(location.name),
      representation: binding ? binding.representation.kind : 'unknown',
    })
  }
  for (const binding of scene.locationBindings) {
    if (coveredNames.has(binding.sourceLocationName)) continue
    locations.push({
      locationKey: binding.locationKey,
      name: binding.sourceLocationName,
      description: '',
      residentIds: residentIdsAt(binding.sourceLocationName),
      representation: binding.representation.kind,
    })
  }

  return {
    scope: world.scope,
    spaceId,
    simNow: world.simNow,
    timeZone,
    timeOfDay,
    objects,
    residents: world.residents,
    residentPlacements,
    locations,
  }
}
