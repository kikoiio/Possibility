import {
  applyEdits, clampStyleRef, clampTerrainParams, createEmptyWorld, deserialize, generateTerrain,
  serialize, validateDocument, validateWalkability, writeTerrainCells,
  type EditOperation, type LocationBinding, type SpaceEntry, type StylePackRef,
  type TerrainParams, type VoxelDocument, type WorldTerrainMeta,
} from '@possibility/voxel-contract'
import type { ChatMessage } from '../llm/client'
import { EditPlannerError, parseEditOperations, type CompleteFn } from './edit-planner'
import { buildWorldGeneratorMessages } from './prompts'

export class WorldGeneratorError extends Error {
  constructor(message: string, public readonly issues: Array<{ code: string; message: string }> = []) {
    super(message)
    this.name = 'WorldGeneratorError'
  }
}

interface GeneratedWorldPayload {
  size?: { width?: number; height?: number; depth?: number }
  groundBlock?: string
  terrain?: unknown
  style?: unknown
  ops?: unknown[]
  placements?: unknown[]
  locations?: unknown[]
  spaceEntries?: unknown[]
  lockedObjectIds?: unknown[]
}

function extractPayload(content: string): GeneratedWorldPayload {
  const cleaned = content.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new WorldGeneratorError('输出中没有 JSON 对象')
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as GeneratedWorldPayload
  } catch {
    throw new WorldGeneratorError('JSON 解析失败')
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

/** 把 LLM 的建造脚本组装成 VoxelDocument（S3b:地形参数先铺地,再应用建筑 ops） */
export function assembleWorld(payload: GeneratedWorldPayload, theme: string, id: string): VoxelDocument {
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
    ops.push(...parseEditOperations(JSON.stringify({ ops: payload.ops })))
  }
  if (Array.isArray(payload.placements)) {
    ops.push(...parseEditOperations(JSON.stringify({
      ops: payload.placements.map((p) => ({ ...(p as object), kind: 'place-object' })),
    })))
  }

  let doc = createEmptyWorld({ width, height, depth }, theme, id)
  try {
    if (terrainMeta) {
      const generated = generateTerrain(doc.size, terrainMeta.params)
      doc = writeTerrainCells(doc, generated.cells).document
      if (generated.assetPlacements.length > 0) doc = { ...doc, assetPlacements: generated.assetPlacements }
    }
    doc = applyEdits(doc, ops).document
  } catch (error) {
    throw new WorldGeneratorError(`建造脚本应用失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (terrainMeta) doc = { ...doc, terrain: terrainMeta }
  if (styleRef) doc = { ...doc, style: styleRef }

  const objectIds = new Set(doc.objects.map((o) => o.id))
  const locations: LocationBinding[] = []
  if (Array.isArray(payload.locations)) {
    for (const raw of payload.locations) {
      const l = raw as Record<string, unknown>
      if (typeof l?.name !== 'string' || !l.name || typeof l.objectId !== 'string') continue
      if (!objectIds.has(l.objectId)) throw new WorldGeneratorError(`地点「${l.name}」绑定了不存在的物体 ${l.objectId}`)
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
  deps: { complete: CompleteFn; maxAttempts?: number; id?: string; buildMessages?: (desc: string, theme: string) => ChatMessage[] },
): Promise<VoxelDocument> {
  const maxAttempts = deps.maxAttempts ?? 3
  const buildMessages = deps.buildMessages ?? buildWorldGeneratorMessages
  const id = deps.id ?? `generated-${Date.now()}`
  let messages = buildMessages(sceneDescription, theme)
  let lastIssues: Array<{ code: string; message: string }> = []
  let lastError = '未知错误'

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const content = await deps.complete(messages)
    let doc: VoxelDocument
    try {
      doc = assembleWorld(extractPayload(content), theme, id)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      lastIssues = []
      messages = [...messages, { role: 'assistant', content }, { role: 'user', content: `上一次的世界无法组装（${lastError}）。请修正后重新返回完整世界 JSON。` }]
      continue
    }
    const issues = validateDocument(doc)
    // 结构校验过了才跑可行走性(世界可行走性是 S2b F5 的生成契约;结构坏了先修结构)
    if (issues.length === 0) issues.push(...validateWalkability(doc))
    if (issues.length === 0) {
      // 序列化 round-trip 自检（契约闭环：AI 输出即权威格式）
      deserialize(serialize(doc))
      return doc
    }
    lastIssues = issues
    const detail = issues.slice(0, 6).map((i) => `${i.code}${i.at ? `@(${i.at.x},${i.at.y},${i.at.z})` : ''}: ${i.message}`).join('；')
    messages = [...messages, { role: 'assistant', content }, { role: 'user', content: `上一次的世界未通过契约校验：${detail}。请修正后重新返回完整世界 JSON。` }]
  }
  throw new WorldGeneratorError(
    lastIssues.length > 0
      ? `世界生成 ${maxAttempts} 次仍未通过校验：${lastIssues[0].message}`
      : `世界生成 ${maxAttempts} 次仍无法组装：${lastError}`,
    lastIssues,
  )
}

export { EditPlannerError }
