import {
  applyEdits, assetFootprintCells, clampStyleRef, clampTerrainParams, createBlockRegistry, createEmptyWorld, deserialize, generateTerrain,
  getBlock, getObjectTemplate, serialize, validateDocument, validateWalkability, writeTerrainCells,
  type AssetManifest, type EditOperation, type LocationBinding, type SpaceEntry, type StylePackRef,
  type TerrainParams, type VoxelCoord, type VoxelDocument, type WorldTerrainMeta,
} from '@possibility/voxel-contract'
import type { ChatMessage } from '../llm/client'
import { EditPlannerError, parseEditOperations, type CompleteFn } from './edit-planner'
import { buildWorldGeneratorMessages } from './prompts'
import { normalizePayloadSize, normalizeWorldDocument } from './normalize'

export class WorldGeneratorError extends Error {
  constructor(
    message: string,
    public readonly issues: Array<{ code: string; message: string }> = [],
    public readonly normalizationFixes: string[] = [],
    public readonly failureStage: 'payload' | 'assembly' | 'validation' | 'binding' | 'serialization' = 'assembly',
  ) {
    super(message)
    this.name = 'WorldGeneratorError'
  }
}

/** 可行走性 issue → 给 LLM 的修复方向(坐标已在 detail 里) */
const WALK_HINTS: Record<string, string> = {
  'walk-clearance': '把列出的通行格正上方方块挖掉或整体抬高,保证每个通行格上方连续 2 格是空气',
  'location-unbound': '为列出的每个世界地点增加独立的 place-object 或 assetPlacements 承载物，并在 locations 中逐字绑定地点名',
  'walk-connectivity': '检查被水/墙/围栏围死的区域,铺路或开门让室外能走到每个地点',
  'walk-stairs': '超过 1 格的高差处放台阶/楼梯,不要让人跳坎',
  'walk-gap': 'issue 的 at=(x,y,z) 是跳隙前严格可达的站位,不是待填方块;沿四个水平邻向检查一格 via=(x±1,y,z)/(x,y,z±1) 与同高两格外 across=(x±2,y,z)/(x,y,z±2)。湖岸或坡地应按地面高程接路、做缓坡/台阶或搭桥,确保有不依赖跳跃的步行绕路,不要只在 at 填方块',
  'walk-lighting': '室内/洞穴等封闭通行区域放发光方块(灯笼等)照明',
  'out-of-bounds': '所有 block、物体和资产的完整占地必须位于世界范围内',
}

interface GeneratedWorldPayload {
  size?: { width?: unknown; height?: unknown; depth?: unknown }
  groundBlock?: string
  terrain?: unknown
  style?: unknown
  ops?: unknown[]
  /** S2b:GLB 资产摆放(placements 优先);旧字段名 placements 已废弃,见 assembleWorld 报错 */
  assetPlacements?: unknown[]
  placements?: unknown[]
  locations?: unknown[]
  spaceEntries?: unknown[]
  lockedObjectIds?: unknown[]
}

const isCoord = (v: unknown): v is { x: number; y: number; z: number } => {
  const c = v as { x?: unknown; y?: unknown; z?: unknown } | null
  return !!c && Number.isInteger(c.x) && Number.isInteger(c.y) && Number.isInteger(c.z)
}

/** S2b:载荷 assetPlacements 逐条转 place-asset op(形状不合法即抛,走重试链) */
function assetPlacementOps(raw: unknown[]): EditOperation[] {
  return raw.map((entry, index): EditOperation => {
    const p = entry as Record<string, unknown>
    const bad = (why: string): never => { throw new WorldGeneratorError(`assetPlacements[${index}] 不合法：${why}`) }
    if (typeof p?.assetId !== 'string' || !p.assetId) return bad('需要 assetId')
    if (!isCoord(p.anchor)) return bad('anchor 需要 {x,y,z} 整数坐标')
    if (p.placementId !== undefined && (typeof p.placementId !== 'string' || !p.placementId)) return bad('placementId 需要非空字符串')
    if (p.id !== undefined && (typeof p.id !== 'string' || !p.id)) return bad('id 需要非空字符串')
    if (typeof p.placementId === 'string' && typeof p.id === 'string' && p.placementId !== p.id) {
      return bad('id 与 placementId 不一致')
    }
    const rawRotation = p.rotation ?? 0
    const normalizedRotation = rawRotation === 90 || rawRotation === 180 || rawRotation === 270
      ? rawRotation / 90
      : rawRotation
    if (normalizedRotation !== 0 && normalizedRotation !== 1 && normalizedRotation !== 2 && normalizedRotation !== 3) {
      return bad('rotation 需要 0..3(四分之一圈)')
    }
    if (p.seed !== undefined && (typeof p.seed !== 'number' || !Number.isFinite(p.seed))) return bad('seed 需要有限数')
    // Older model responses sometimes put voxel object templates in the GLB
    // assetPlacements list. Convert only known templates; unknown ids remain
    // asset references and are validated against the manifest as before.
    if (getObjectTemplate(p.assetId)) {
      const objectId = p.placementId ?? p.id
      return {
        kind: 'place-object', objectType: p.assetId, anchor: p.anchor,
        rotation: (normalizedRotation * 90) as 0 | 90 | 180 | 270,
        ...(typeof objectId === 'string' ? { objectId } : {}),
      }
    }
    return {
      kind: 'place-asset', assetId: p.assetId, anchor: p.anchor,
      rotation: normalizedRotation as 0 | 1 | 2 | 3,
      ...((p.placementId ?? p.id) ? { placementId: (p.placementId ?? p.id) as string } : {}),
      ...(typeof p.seed === 'number' ? { seed: p.seed } : {}),
    }
  })
}

const BUILDING_LOCATION = /咖啡馆|咖啡屋|咖啡店|住宅|民居|公寓|居民楼|住宅楼|店铺|商店|商铺|杂货铺|杂货店|邮局|图书馆|车站|学校|医院|诊所|旅馆|客栈|酒店|餐馆|饭店|餐厅|酒馆|酒吧|教堂|办公楼|厂房|工坊|工作室|\bcafe\b|\bcoffee ?shop\b|\bhouse\b|\bhome\b|\bresidence\b|\bapartment\b|\bshop\b|\bstore\b|\bpost ?office\b|\blibrary\b|\bstation\b|\bschool\b|\bhospital\b|\bclinic\b|\bhotel\b|\binn\b|\brestaurant\b|\boffice\b|\bfactory\b|\bworkshop\b/iu
const BUILDING_OBJECT_TYPES = new Set(['manor-main-house', 'manor-two-story-house', 'manor-greenhouse'])

function extractPayload(content: string): GeneratedWorldPayload {
  const cleaned = content.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new WorldGeneratorError('输出中没有 JSON 对象', [], [], 'payload')
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as GeneratedWorldPayload
  } catch {
    throw new WorldGeneratorError('JSON 解析失败', [], [], 'payload')
  }
}

/** 种子缺省时服务端分配(crypto 随机 31 位正整数;workers/Node 通用) */
function allocateSeed(): number {
  const buf = new Uint32Array(1)
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => void } }).crypto
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(buf)
  } else {
    buf[0] = Math.floor(Math.random() * 0x7fffffff)
  }
  return buf[0] & 0x7fffffff
}

/**
 * 生成后归一:整体悬空的物体/资产摆放逐格沉降直到落地(支撑规则与 validation 一致)。
 * 弱模型常把 anchor.y 放错(尤其带 terrain 时地面不在 y=0);意图显然是落地,与其烧重试不如确定性修复。
 */
export function settleFloatingObjects(doc: VoxelDocument, assets?: AssetManifest): { document: VoxelDocument; settled: string[] } {
  const registry = createBlockRegistry(doc.theme)
  const settled = new Set<string>()
  let next = doc
  const hasSupport = (cells: VoxelCoord[]): boolean => {
    if (cells.length === 0) return true
    const minY = Math.min(...cells.map(c => c.y))
    const own = new Set(cells.map(c => `${c.x},${c.y},${c.z}`))
    return cells.filter(c => c.y === minY).some(c => {
      if (c.y === 0) return true
      const below = { x: c.x, y: c.y - 1, z: c.z }
      if (own.has(`${below.x},${below.y},${below.z}`)) return false
      return !!registry.get(getBlock(next, below))?.solid
    })
  }
  for (const object of doc.objects) {
    for (let guard = 0; guard < doc.size.height; guard++) {
      const entry = next.objectCells.find(c => c.objectId === object.id)
      if (!entry || hasSupport(entry.cells)) break
      const current = next.objects.find(o => o.id === object.id)!
      if (current.anchor.y <= 0) break
      next = applyEdits(next, [{ kind: 'move-object', objectId: object.id, anchor: { ...current.anchor, y: current.anchor.y - 1 } }]).document
      settled.add(object.id)
    }
  }
  if (assets && next.assetPlacements && next.assetPlacements.length > 0) {
    const placements = next.assetPlacements.map((placement, index) => {
      const entry = assets.assets[placement.assetId]
      if (!entry) return placement
      let current = placement
      for (let guard = 0; guard < doc.size.height; guard++) {
        const anchor = { x: current.anchor[0], y: current.anchor[1], z: current.anchor[2] }
        if (anchor.y <= 0 || hasSupport(assetFootprintCells(entry, anchor, current.rotation))) break
        current = { ...current, anchor: [anchor.x, anchor.y - 1, anchor.z] }
        settled.add(current.id ?? `${current.assetId}#${index}`)
      }
      return current
    })
    next = { ...next, assetPlacements: placements }
  }
  return { document: next, settled: [...settled] }
}

/**
 * 物体重叠的确定性避让(2D resolveObjectOverlaps 的体素版):
 * 地点绑定物体优先保持原位;冲突物体在同层按曼哈顿距离就近搜索空位;找不到则保留原状交给校验重试。
 */
export function resolveObjectOverlaps(doc: VoxelDocument): { document: VoxelDocument; moved: string[] } {
  const bound = new Set(doc.locations.map(l => l.objectId))
  const key = (c: VoxelCoord) => `${c.x},${c.y},${c.z}`
  const occupied = new Map<string, string>()
  const moved: string[] = []
  let next = doc
  const ordered = [...doc.objects].sort((a, b) => Number(bound.has(b.id)) - Number(bound.has(a.id)))
  for (const object of ordered) {
    const entry = next.objectCells.find(c => c.objectId === object.id)
    const template = getObjectTemplate(object.objectType)
    if (!entry || !template) continue
    const claim = () => { for (const c of next.objectCells.find(c => c.objectId === object.id)?.cells ?? []) occupied.set(key(c), object.id) }
    if (!entry.cells.some(c => occupied.has(key(c)))) { claim(); continue }
    const minX = Math.min(...template.cells.map(c => c.offset.x)), maxX = Math.max(...template.cells.map(c => c.offset.x))
    const minY = Math.min(...template.cells.map(c => c.offset.y)), maxY = Math.max(...template.cells.map(c => c.offset.y))
    const minZ = Math.min(...template.cells.map(c => c.offset.z)), maxZ = Math.max(...template.cells.map(c => c.offset.z))
    let spot: VoxelCoord | null = null
    const maxR = Math.max(doc.size.width, doc.size.depth)
    outer: for (let r = 1; r <= maxR && !spot; r++) {
      for (let dx = -r; dx <= r && !spot; dx++) {
        for (let dz = -r; dz <= r && !spot; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          const ax = object.anchor.x + dx, az = object.anchor.z + dz
          if (ax + minX < 0 || ax + maxX >= doc.size.width || az + minZ < 0 || az + maxZ >= doc.size.depth) continue
          if (object.anchor.y + minY < 0 || object.anchor.y + maxY >= doc.size.height) continue
          const cells = template.cells.map(t => ({ x: ax + t.offset.x, y: object.anchor.y + t.offset.y, z: az + t.offset.z }))
          if (cells.some(c => occupied.has(key(c)))) continue
          spot = { x: ax, y: object.anchor.y, z: az }
          break outer
        }
      }
    }
    if (spot) {
      next = applyEdits(next, [{ kind: 'move-object', objectId: object.id, anchor: spot }]).document
      moved.push(object.id)
    }
    claim()
  }
  return { document: next, moved }
}

/** 把 LLM 的建造脚本组装成 VoxelDocument（S3b:地形参数先铺地,再应用建筑 ops） */
export function assembleWorld(payload: GeneratedWorldPayload, theme: string, id: string, assets?: AssetManifest): VoxelDocument {
  const size = payload.size
  if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height) || !Number.isInteger(size.depth)) {
    throw new WorldGeneratorError('缺少合法的 size')
  }
  const { width, height, depth } = size as { width: number; height: number; depth: number }
  if (width < 8 || depth < 8 || height < 4 || width > 256 || depth > 256 || height > 64) {
    throw new WorldGeneratorError(`世界尺寸 ${width}×${height}×${depth} 超出允许范围`)
  }

  // S3b:元数据解析(配额夹取放行 + 记录,不拒绝)
  let terrainMeta: WorldTerrainMeta | undefined
  if (payload.terrain !== undefined) {
    const { params, clamps } = clampTerrainParams(payload.terrain as TerrainParams, { width, height, depth }, allocateSeed())
    terrainMeta = { params, clamps }
  }
  let styleRef: StylePackRef | undefined
  if (payload.style !== undefined) {
    const { style, clamps } = clampStyleRef(payload.style)
    styleRef = { ...style, ...(clamps.length > 0 ? { clamps } : {}) }
  }

  const ground = typeof payload.groundBlock === 'string' && payload.groundBlock ? payload.groundBlock : 'grass'
  const ops: EditOperation[] = []
  // 无 terrain 参数时沿用既有 groundBlock 铺地(N1 等价);有 terrain 时由生成器铺地
  if (!terrainMeta) {
    ops.push({ kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: width - 1, y: 0, z: depth - 1 }, block: ground })
  }
  if (Array.isArray(payload.ops)) {
    ops.push(...parseEditOperations(JSON.stringify({ ops: payload.ops }), assets))
  }
  // 弱模型常把库内资产(GLB)当 place-object 输出:objectType 不是物体模板但命中资产清单时,
  // 确定性改写为 place-asset(角度制 → 四分之一圈);地点绑定若指向它,后续绑定校验会带名反馈重试
  if (assets) {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]
      if (op.kind === 'place-object' && !getObjectTemplate(op.objectType) && assets.assets[op.objectType]) {
        ops[i] = {
          kind: 'place-asset', assetId: op.objectType, anchor: op.anchor,
          rotation: (op.rotation / 90) as 0 | 1 | 2 | 3,
          ...(op.objectId ? { placementId: op.objectId } : {}),
        }
      }
      // 反向同样常见:物体模板 id 写进了 assetPlacements(四分之一圈 → 角度制)
      if (op.kind === 'place-asset' && !assets.assets[op.assetId] && getObjectTemplate(op.assetId)) {
        ops[i] = {
          kind: 'place-object', objectType: op.assetId, anchor: op.anchor,
          rotation: (op.rotation * 90) as 0 | 90 | 180 | 270,
          ...(op.placementId ? { objectId: op.placementId } : {}),
        }
      }
    }
  }
  if (Array.isArray(payload.placements)) {
    throw new WorldGeneratorError('字段 placements 已改名为 assetPlacements（GLB 资产摆放，形状 {assetId, anchor, rotation?, seed?}），请用新字段名重新返回')
  }
  if (Array.isArray(payload.assetPlacements)) {
    ops.push(...assetPlacementOps(payload.assetPlacements))
  }
  // 模型臆造的 objectType(既非模板也非资产):丢弃该 op;装饰少一件无感,
  // 若有地点绑定到它,下方绑定校验会带名反馈走重试链
  const knownOps = ops.filter(op => op.kind !== 'place-object' || !!getObjectTemplate(op.objectType))

  let doc = createEmptyWorld({ width, height, depth }, theme, id)
  const terrainPlacementIds = new Set<string>()
  try {
    if (terrainMeta) {
      const generated = generateTerrain(doc.size, terrainMeta.params)
      doc = writeTerrainCells(doc, generated.cells).document
      if (generated.assetPlacements.length > 0) {
        for (const p of generated.assetPlacements) { if (p.id) terrainPlacementIds.add(p.id) }
        doc = { ...doc, assetPlacements: generated.assetPlacements }
      }
    }
    doc = applyEdits(doc, knownOps).document
    doc = resolveObjectOverlaps(doc).document
    doc = settleFloatingObjects(doc, assets).document
    // 摆放冲突的确定性裁决:物体(承载地点绑定)> 模型显式摆放 > 地形撒布,后到者让位丢弃。
    // 装饰少一件无感,烧一轮 16k token 的重试太贵;物体重叠已先行确定性避让,实在避不开才留给校验重试
    if (assets && doc.assetPlacements && doc.assetPlacements.length > 0) {
      const cellsOf = (p: (typeof doc.assetPlacements)[number]): string[] => {
        const entry = assets.assets[p.assetId]
        if (!entry) return []
        return assetFootprintCells(entry, { x: p.anchor[0], y: p.anchor[1], z: p.anchor[2] }, p.rotation)
          .map(c => `${c.x},${c.y},${c.z}`)
      }
      const occupied = new Set(doc.objectCells.flatMap(o => o.cells.map(c => `${c.x},${c.y},${c.z}`)))
      const kept: typeof doc.assetPlacements = []
      const prioritized = [
        ...doc.assetPlacements.filter(p => !terrainPlacementIds.has(p.id ?? '')),
        ...doc.assetPlacements.filter(p => terrainPlacementIds.has(p.id ?? '')),
      ]
      for (const p of prioritized) {
        const cells = cellsOf(p)
        if (cells.some(c => occupied.has(c))) continue
        for (const c of cells) occupied.add(c)
        kept.push(p)
      }
      doc = { ...doc, assetPlacements: kept }
    }
  } catch (error) {
    throw new WorldGeneratorError(`建造脚本应用失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (terrainMeta) doc = { ...doc, terrain: terrainMeta }
  if (styleRef) doc = { ...doc, style: styleRef }

  const objectIds = new Set(doc.objects.map((o) => o.id))
  const placementIds = new Set((doc.assetPlacements ?? []).map(p => p.id).filter((v): v is string => Boolean(v)))
  const locations: LocationBinding[] = []
  if (Array.isArray(payload.locations)) {
    for (const raw of payload.locations) {
      const l = raw as Record<string, unknown>
      if (typeof l?.name !== 'string' || !l.name || typeof l.objectId !== 'string') continue
      if (!objectIds.has(l.objectId) && !placementIds.has(l.objectId)) {
        throw new WorldGeneratorError(
          `地点「${l.name}」绑定了不存在的承载物 ${l.objectId}。请先在该地点区域内实际放置独立且语义相符的 place-object 或 assetPlacements，再将 locations.objectId 精确设为该物体或摆放的 ID。`
          + `locations 可绑定 place-object 的物体`
          + `（${doc.objects.map(o => o.id).join('、') || '无'}）或 assetPlacements 的资产摆放 id`
          + `（${[...placementIds].join('、') || '无'}）`,
        )
      }
      locations.push({ name: l.name, objectId: l.objectId })
    }
  }
  const spaceEntries: SpaceEntry[] = []
  if (Array.isArray(payload.spaceEntries)) {
    for (const raw of payload.spaceEntries) {
      const s = raw as Record<string, unknown>
      const at = s?.at as { x?: unknown; y?: unknown; z?: unknown } | undefined
      if (typeof s?.spaceId !== 'string' || !s.spaceId || typeof s.label !== 'string'
        || !at || !Number.isInteger(at.x) || !Number.isInteger(at.y) || !Number.isInteger(at.z)) continue
      spaceEntries.push({ spaceId: s.spaceId, label: s.label, at: at as SpaceEntry['at'] })
    }
  }
  const lockedObjectIds = Array.isArray(payload.lockedObjectIds)
    ? payload.lockedObjectIds.filter((v): v is string => typeof v === 'string' && objectIds.has(v))
    : []
  return { ...doc, locations, spaceEntries, lockedObjectIds }
}

/**
 * AI 体素世界生成：场景描述 → LLM → VoxelDocument → validateDocument(+ 可行走性)，
 * 失败带 issue 重试，最多 maxAttempts 次（F3, N10;S2b F5: walkability 并入同一循环）。
 */
export async function generateWorld(
  sceneDescription: string,
  theme: string,
  deps: { complete: CompleteFn; maxAttempts?: number; id?: string; buildMessages?: (desc: string, theme: string) => ChatMessage[]; assets?: AssetManifest; requiredLocationNames?: string[] },
): Promise<VoxelDocument> {
  const maxAttempts = deps.maxAttempts ?? 3
  const buildMessages = deps.buildMessages ?? buildWorldGeneratorMessages
  const id = deps.id ?? `generated-${Date.now()}`
  let messages = buildMessages(sceneDescription, theme)
  let lastIssues: Array<{ code: string; message: string }> = []
  let lastError = '未知错误'
  let lastNormalizationFixes: string[] = []
  let lastFailureStage: WorldGeneratorError['failureStage'] = 'payload'

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const content = await deps.complete(messages)
    let doc: VoxelDocument
    lastNormalizationFixes = []
    try {
      const normalizedPayload = normalizePayloadSize(extractPayload(content))
      lastNormalizationFixes = normalizedPayload.fixes
      doc = assembleWorld(normalizedPayload.payload, theme, id, deps.assets)
      const normalizedWorld = normalizeWorldDocument(doc, deps.assets)
      doc = normalizedWorld.document
      lastNormalizationFixes = [...lastNormalizationFixes, ...normalizedWorld.fixes]
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      lastFailureStage = error instanceof WorldGeneratorError ? error.failureStage : 'assembly'
      lastIssues = []
      messages = [...messages, { role: 'assistant', content }, { role: 'user', content: `上一次的世界无法组装（${lastError}）。请修正后重新返回完整世界 JSON。` }]
      continue
    }
    const issues = validateDocument(doc, undefined, deps.assets)
    // 结构校验过了才跑可行走性(世界可行走性是 S2b F5 的生成契约;结构坏了先修结构)
    if (issues.length === 0) issues.push(...validateWalkability(doc))
    const boundNames = new Set(doc.locations.map(location => location.name))
    for (const name of new Set(deps.requiredLocationNames ?? [])) {
      if (!boundNames.has(name)) issues.push({ code: 'location-unbound', message: `必需地点「${name}」尚未绑定到场景物体` })
    }
    const carrierNames = new Map<string, string>()
    for (const location of doc.locations) {
      const previousName = carrierNames.get(location.objectId)
      if (previousName) {
        issues.push({ code: 'location-unbound', message: `地点「${previousName}」与「${location.name}」共用承载物「${location.objectId}」；每个地点必须绑定不同承载物` })
      } else carrierNames.set(location.objectId, location.name)
    }
    const requiredNames = new Set(deps.requiredLocationNames ?? [])
    const buildingCarrierIds = new Set([
      ...doc.objects.filter(object => BUILDING_OBJECT_TYPES.has(object.objectType)).map(object => object.id),
      ...(doc.assetPlacements ?? []).filter(placement => deps.assets?.assets[placement.assetId]?.category === 'building')
        .map(placement => placement.id).filter((id): id is string => Boolean(id)),
    ])
    for (const location of doc.locations) {
      if (requiredNames.has(location.name) && BUILDING_LOCATION.test(location.name)
        && !buildingCarrierIds.has(location.objectId)) {
        issues.push({ code: 'location-unbound', message: `建筑地点「${location.name}」必须绑定建筑物体或 building 类资产，不能绑定家具、装饰或植被` })
      }
    }
    if (issues.length === 0) {
      // 序列化 round-trip 自检（契约闭环：AI 输出即权威格式）
      try {
        deserialize(serialize(doc))
      } catch {
        throw new WorldGeneratorError('生成场景无法序列化', [], lastNormalizationFixes, 'serialization')
      }
      return doc
    }
    lastIssues = issues
    lastFailureStage = 'validation'
    const detail = issues.slice(0, 6).map((i) => `${i.code}${i.at ? `@(${i.at.x},${i.at.y},${i.at.z})` : ''}: ${i.message}`).join('；')
    // 可行走性语义错误给弱模型可操作的修复方向(机械错误已被确定性归一拦截,到这里的都是布局问题)
    const hints = [...new Set(issues.map(i => WALK_HINTS[i.code]).filter((h): h is string => Boolean(h)))]
    const clearanceCells = issues.filter(issue => issue.code === 'walk-clearance' && issue.at)
      .slice(0, 6).map(issue => `(${issue.at!.x},${issue.at!.y},${issue.at!.z})`)
    if (clearanceCells.length > 0) hints.push(`净空问题位于通行格 ${clearanceCells.join('、')};清除这些格子正上方 y+1 的普通方块；若该格属于地点承载物或资产，不要破坏它，改为另开净高至少 2 格的通路`)
    const connectivityTargets = issues.filter(issue => issue.code === 'walk-connectivity' && issue.at)
      .slice(0, 6).map(issue => {
        const object = doc.objects.find(candidate => candidate.anchor.x === issue.at!.x
          && candidate.anchor.y === issue.at!.y && candidate.anchor.z === issue.at!.z)
        const locations = object
          ? doc.locations.filter(binding => binding.objectId === object.id).map(binding => binding.name)
          : []
        const label = [object?.id, object?.objectType, ...locations].filter(Boolean).join('/') || '地点承载物'
        return `${label}@(${issue.at!.x},${issue.at!.y},${issue.at!.z})`
      })
    if (connectivityTargets.length > 0) {
      hints.push(`以下地点承载物不可从室外到达：${connectivityTargets.join('、')};保持物体及地点绑定不变，在每个物体一侧留出可站立位置，并清开墙体/围栏形成与室外连续、净高至少 2 格的路线`)
    }
    if (issues.some(issue => issue.code === 'out-of-bounds')) {
      const outOfBoundsDetails = issues.filter(issue => issue.code === 'out-of-bounds').slice(0, 8)
        .map(issue => `${issue.message}${issue.at ? `@(${issue.at.x},${issue.at.y},${issue.at.z})` : ''}`)
      hints.push(`本世界坐标范围为 x=0..${doc.size.width - 1}, y=0..${doc.size.height - 1}, z=0..${doc.size.depth - 1};以下位置或完整占地越界：${outOfBoundsDetails.join('；')}。根据对象/资产 footprint 将它们移回边界内；不要只移动 anchor 后再次输出同一布局`)
    }
    const hintText = hints.length > 0 ? `修复方向:${[...new Set(hints)].join('；')}。` : ''
    messages = [...messages, { role: 'assistant', content }, { role: 'user', content: `上一次的世界未通过契约校验：${detail}。${hintText}请修正后重新返回完整世界 JSON。` }]
  }
  throw new WorldGeneratorError(
    lastIssues.length > 0
      ? `世界生成 ${maxAttempts} 次仍未通过校验：${lastIssues[0].message}`
      : `世界生成 ${maxAttempts} 次仍无法组装：${lastError}`,
    lastIssues,
    lastNormalizationFixes,
    lastFailureStage,
  )
}

export { EditPlannerError }
