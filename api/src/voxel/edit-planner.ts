import {
  getObjectTemplate,
  validateEdit,
  type AssetManifest, type EditOperation, type ValidationIssue, type VoxelCoord, type VoxelDocument,
} from '@possibility/voxel-contract'
import type { ChatMessage } from '../llm/client'
import { buildEditPlannerMessages as defaultBuildMessages } from './prompts'

export class EditPlannerError extends Error {
  constructor(
    message: string,
    public readonly issues: ValidationIssue[] = [],
  ) {
    super(message)
    this.name = 'EditPlannerError'
  }
}

export type CompleteFn = (messages: ChatMessage[]) => Promise<string>

// ── LLM 输出解析 ──────────────────────────────

function extractJson(content: string): unknown {
  const cleaned = content.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new EditPlannerError('输出中没有 JSON 对象')
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    throw new EditPlannerError('JSON 解析失败')
  }
}

const isCoord = (v: unknown): v is VoxelCoord => {
  const c = v as VoxelCoord
  return !!c && Number.isInteger(c.x) && Number.isInteger(c.y) && Number.isInteger(c.z)
}
const isRotation = (v: unknown): v is 0 | 90 | 180 | 270 => v === 0 || v === 90 || v === 180 || v === 270

function normalizedAnchor(op: Record<string, unknown>): VoxelCoord | null {
  if (isCoord(op.anchor)) return op.anchor
  const xyz = { x: op.x, y: op.y, z: op.z }
  return isCoord(xyz) ? xyz : null
}

function expectedPlacementSize(
  objectType: string,
  rotation: 0 | 90 | 180 | 270,
  assets?: AssetManifest,
): { width: number; height: number; depth: number } | null {
  const template = getObjectTemplate(objectType)
  if (template) {
    const offsets = template.cells.map(({ offset }) => {
      switch (rotation) {
        case 90: return { x: -offset.z, y: offset.y, z: offset.x }
        case 180: return { x: -offset.x, y: offset.y, z: -offset.z }
        case 270: return { x: offset.z, y: offset.y, z: -offset.x }
        default: return offset
      }
    })
    const extent = (axis: 'x' | 'y' | 'z') => Math.max(...offsets.map(point => point[axis]))
      - Math.min(...offsets.map(point => point[axis])) + 1
    return { width: extent('x'), height: extent('y'), depth: extent('z') }
  }
  const asset = assets?.assets[objectType]
  if (!asset) return null
  const [width, depth] = rotation === 90 || rotation === 270
    ? [asset.footprint[1], asset.footprint[0]]
    : asset.footprint
  return { width, height: Math.max(1, Math.ceil(asset.height)), depth }
}

function validateOptionalSize(
  size: unknown,
  expected: ReturnType<typeof expectedPlacementSize>,
  bad: (why: string) => never,
): void {
  if (size === undefined) return
  const value = size as { width?: unknown; height?: unknown; depth?: unknown } | null
  if (!value || !Number.isInteger(value.width) || !Number.isInteger(value.height) || !Number.isInteger(value.depth)
    || (value.width as number) < 1 || (value.width as number) > 256
    || (value.height as number) < 1 || (value.height as number) > 64
    || (value.depth as number) < 1 || (value.depth as number) > 256) {
    return bad('size 需要边界内的正整数 width/height/depth')
  }
  if (expected && (value.width !== expected.width || value.height !== expected.height || value.depth !== expected.depth)) {
    return bad(`size 与目录占地不一致（期望 ${expected.width}×${expected.height}×${expected.depth}）`)
  }
}

/** 严格解析编辑操作数组；结构不合法抛 EditPlannerError。
 *  LLM 边界容错:弱模型常把判别字段写成 type,归一为 kind 后再走严格校验(契约形状不变) */
export function parseEditOperations(content: string, assets?: AssetManifest): EditOperation[] {
  const root = extractJson(content) as { ops?: unknown }
  if (!Array.isArray(root.ops)) throw new EditPlannerError('缺少 ops 数组')
  if (root.ops.length === 0) throw new EditPlannerError('ops 为空')
  if (root.ops.length > 64) throw new EditPlannerError('ops 过多（>64）')
  return root.ops.map((raw, i): EditOperation => {
    const op = raw as Record<string, unknown>
    if (op && op.kind === undefined) {
      // 弱模型判别字段变种:kind / type / op(契约形状不变,仅 LLM 边界归一)
      if (typeof op.type === 'string') op.kind = op.type
      else if (typeof op.op === 'string') op.kind = op.op
    }
    // 弱模型操作名变种:place-block = set-block
    if (op && op.kind === 'place-block') op.kind = 'set-block'
    const bad = (why: string): never => { throw new EditPlannerError(`ops[${i}] 不合法：${why}`) }
    switch (op?.kind) {
      case 'set-block':
        if (!isCoord(op.at) || typeof op.block !== 'string' || !op.block) return bad('set-block 需要 at 坐标与 block')
        return { kind: 'set-block', at: op.at, block: op.block }
      case 'fill':
        if (!isCoord(op.from) || !isCoord(op.to) || typeof op.block !== 'string' || !op.block) return bad('fill 需要 from/to 与 block')
        return { kind: 'fill', from: op.from, to: op.to, block: op.block }
      case 'place-object': {
        // 弱模型常借用资产摆放的习惯:objectType 写成 assetId、rotation 用 0..3 四分之一圈
        // (契约 rotation 只收 90 的倍数,1/2/3 只能解读为四分之一圈,归一安全)
        const objectType = typeof op.objectType === 'string' && op.objectType ? op.objectType
          : typeof op.assetId === 'string' && op.assetId ? op.assetId
            : typeof op.object === 'string' && op.object ? op.object : null
        const rawRotation = op.rotation === undefined ? 0 : op.rotation
        const rotation = rawRotation === 1 || rawRotation === 2 || rawRotation === 3 ? rawRotation * 90 : rawRotation
        const anchor = normalizedAnchor(op)
        if (!objectType || !anchor || !isRotation(rotation)) return bad('place-object 需要目录 objectType/assetId、整数 anchor 坐标与合法 rotation')
        validateOptionalSize(op.size, expectedPlacementSize(objectType, rotation, assets), bad)
        return {
          kind: 'place-object', objectType, anchor, rotation,
          ...(typeof op.objectId === 'string' && op.objectId ? { objectId: op.objectId } : {}),
          ...(typeof op.label === 'string' && op.label ? { label: op.label } : {}),
        }
      }
      case 'move-object':
        if (typeof op.objectId !== 'string' || !op.objectId || !isCoord(op.anchor)) return bad('move-object 需要 objectId 与 anchor')
        return { kind: 'move-object', objectId: op.objectId, anchor: op.anchor }
      case 'remove-object':
        if (typeof op.objectId !== 'string' || !op.objectId) return bad('remove-object 需要 objectId')
        return { kind: 'remove-object', objectId: op.objectId }
      case 'place-asset': {
        // 注意:资产 op 的 rotation 是 0..3 四分之一圈制,勿复用 isRotation 的角度制
        const rotation = op.rotation ?? 0
        if (typeof op.assetId !== 'string' || !op.assetId || !isCoord(op.anchor)) return bad('place-asset 需要 assetId 与 anchor')
        if (rotation !== 0 && rotation !== 1 && rotation !== 2 && rotation !== 3) return bad('place-asset 的 rotation 需要 0..3')
        return {
          kind: 'place-asset', assetId: op.assetId, anchor: op.anchor, rotation,
          ...(typeof op.placementId === 'string' && op.placementId ? { placementId: op.placementId } : {}),
          ...(typeof op.seed === 'number' && Number.isFinite(op.seed) ? { seed: op.seed } : {}),
        }
      }
      case 'move-asset': {
        if (typeof op.placementId !== 'string' || !op.placementId || !isCoord(op.anchor)) return bad('move-asset 需要 placementId 与 anchor')
        if (op.rotation !== undefined && op.rotation !== 0 && op.rotation !== 1 && op.rotation !== 2 && op.rotation !== 3) return bad('move-asset 的 rotation 需要 0..3')
        return {
          kind: 'move-asset', placementId: op.placementId, anchor: op.anchor,
          ...(op.rotation !== undefined ? { rotation: op.rotation as 0 | 1 | 2 | 3 } : {}),
        }
      }
      case 'remove-asset':
        if (typeof op.placementId !== 'string' || !op.placementId) return bad('remove-asset 需要 placementId')
        return { kind: 'remove-asset', placementId: op.placementId }
      default:
        return bad(`未知操作 kind=${String(op?.kind)}`)
    }
  })
}

/**
 * AI 对话式编辑规划：意图 + 当前世界 → EditOperation[]。
 * 输出先过 validateEdit，失败带 issue 重试，最多 maxAttempts 次（N10）。
 */
export async function planEdits(
  doc: VoxelDocument,
  intent: string,
  deps: { complete: CompleteFn; maxAttempts?: number; buildMessages?: (doc: VoxelDocument, intent: string) => ChatMessage[] },
): Promise<EditOperation[]> {
  const maxAttempts = deps.maxAttempts ?? 3
  const buildMessages = deps.buildMessages ?? ((d, i) => defaultBuildMessages(d, i))
  let messages = buildMessages(doc, intent)
  let lastIssues: ValidationIssue[] = []
  let lastError = '未知错误'

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const content = await deps.complete(messages)
    let ops: EditOperation[]
    try {
      ops = parseEditOperations(content)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      lastIssues = []
      messages = [...messages, { role: 'assistant', content }, { role: 'user', content: `上一次的输出无法解析（${lastError}）。请只返回 {"ops":[...]} JSON。` }]
      continue
    }
    const issues = validateEdit(doc, ops)
    if (issues.length === 0) return ops
    lastIssues = issues
    const detail = issues.slice(0, 5).map((i) => `${i.code}${i.at ? `@(${i.at.x},${i.at.y},${i.at.z})` : ''}: ${i.message}`).join('；')
    messages = [...messages, { role: 'assistant', content }, { role: 'user', content: `上一次的操作未通过世界校验：${detail}。请修正后重新返回完整 {"ops":[...]}。` }]
  }
  throw new EditPlannerError(
    lastIssues.length > 0
      ? `编辑规划 ${maxAttempts} 次仍未通过校验：${lastIssues[0].message}`
      : `编辑规划 ${maxAttempts} 次仍无法解析：${lastError}`,
    lastIssues,
  )
}
