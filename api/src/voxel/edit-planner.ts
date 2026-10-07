import {
  validateEdit,
  type EditOperation, type ValidationIssue, type VoxelCoord, type VoxelDocument,
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

/** 严格解析编辑操作数组；结构不合法抛 EditPlannerError。
 *  LLM 边界容错:弱模型常把判别字段写成 type,归一为 kind 后再走严格校验(契约形状不变) */
export function parseEditOperations(content: string): EditOperation[] {
  const root = extractJson(content) as { ops?: unknown }
  if (!Array.isArray(root.ops)) throw new EditPlannerError('缺少 ops 数组')
  if (root.ops.length === 0) throw new EditPlannerError('ops 为空')
  if (root.ops.length > 1024) throw new EditPlannerError('ops 过多（>1024）')
  let expandedCount = 0
  const parsed = root.ops.flatMap((raw, i): EditOperation[] => {
    const op = raw as Record<string, unknown>
    if (op && op.kind === undefined) {
      // 弱模型判别字段变种:kind / type / op(契约形状不变,仅 LLM 边界归一)
      if (typeof op.type === 'string') op.kind = op.type
      else if (typeof op.op === 'string') op.kind = op.op
    }
    // Alternate block-placement shorthand emitted by several compatible models.
    if (op && op.kind === 'place-block' && typeof op.block === 'string' && isCoord(op.anchor)
      && !!op.size && typeof op.size === 'object') {
      const size = op.size as Record<string, unknown>
      if (Number.isInteger(size.width) && Number.isInteger(size.height) && Number.isInteger(size.depth)
        && Number(size.width) > 0 && Number(size.height) > 0 && Number(size.depth) > 0) {
        op.kind = 'fill'
        op.from = op.anchor
        op.to = {
          x: op.anchor.x + Number(size.width) - 1,
          y: op.anchor.y + Number(size.height) - 1,
          z: op.anchor.z + Number(size.depth) - 1,
        }
      }
    }
    // Region operations are block fills, even when the model incorrectly labels
    // them as place-object and attaches an objectId that cannot exist in the document.
    if (op && op.kind === 'place-object' && typeof op.block === 'string'
      && (isCoord(op.from) && isCoord(op.to) || isCoord(op.anchor) && !!op.size)) {
      op.kind = 'fill'
      if (!op.from && isCoord(op.anchor) && op.size && typeof op.size === 'object') {
        const size = op.size as Record<string, unknown>
        if (Number.isInteger(size.width) && Number.isInteger(size.height) && Number.isInteger(size.depth)
          && Number(size.width) > 0 && Number(size.height) > 0 && Number(size.depth) > 0) {
          op.from = op.anchor
          op.to = {
            x: op.anchor.x + Number(size.width) - 1,
            y: op.anchor.y + Number(size.height) - 1,
            z: op.anchor.z + Number(size.depth) - 1,
          }
        }
      }
    }
    // 弱模型操作名变种:place-block = set-block
    if (op && op.kind === 'place-block') op.kind = 'set-block'
    const bad = (why: string): never => { throw new EditPlannerError(`ops[${i}] 不合法：${why}`) }
    const coord = (value: unknown, prefix: string): VoxelCoord | null => {
      if (isCoord(value)) return value
      if (Array.isArray(value) && value.length === 3 && value.every(Number.isInteger)) {
        return { x: value[0], y: value[1], z: value[2] }
      }
      const x = op[`${prefix}x`]
      const y = op[`${prefix}y`]
      const z = op[`${prefix}z`]
      return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z)
        ? { x: x as number, y: y as number, z: z as number }
        : null
    }
    const expand = (operations: EditOperation[]): EditOperation[] => {
      expandedCount += operations.length
      if (expandedCount > 2048) return bad('展开后 ops 过多（>2048）')
      return operations
    }
    switch (op?.kind) {
      case 'set-block':
        if (typeof op.block !== 'string' || !op.block) return bad('set-block 需要 block')
        if (op.x1 !== undefined || op.x2 !== undefined || op.y2 !== undefined || op.z1 !== undefined || op.z2 !== undefined) {
          const from = coord(op.from ?? { x: op.x1, y: op.y1 ?? op.y, z: op.z1 }, 'from')
          const to = coord(op.to ?? { x: op.x2, y: op.y2 ?? op.y, z: op.z2 }, 'to')
          if (!from || !to) return bad('set-block 范围需要 x1/y1/z1 与 x2/y2/z2 坐标')
          if ((Math.abs(to.x - from.x) + 1) * (Math.abs(to.y - from.y) + 1) * (Math.abs(to.z - from.z) + 1) > 4096) {
            return bad('set-block 范围过大（>4096 格）')
          }
          return expand([{ kind: 'fill', from, to, block: op.block }])
        }
        {
          const at = coord(op.at, '')
          if (!at || typeof op.block !== 'string' || !op.block) return bad('set-block 需要 at 坐标与 block')
          return expand([{ kind: 'set-block', at, block: op.block }])
        }
      case 'fill':
        {
          const from = coord(op.from, 'from'), to = coord(op.to, 'to')
          if (!from || !to || typeof op.block !== 'string' || !op.block) return bad('fill 需要 from/to 与 block')
          if ((Math.abs(to.x - from.x) + 1) * (Math.abs(to.y - from.y) + 1) * (Math.abs(to.z - from.z) + 1) > 4096) {
            return bad('fill 范围过大（>4096 格）')
          }
          return expand([{ kind: 'fill', from, to, block: op.block }])
        }
      case 'place-line': {
        const from = coord(op.from, 'from'), to = coord(op.to, 'to')
        if (!from || !to || typeof op.block !== 'string' || !op.block) return bad('place-line 需要 from/to 与 block')
        const dx = Math.abs(to.x - from.x), dy = Math.abs(to.y - from.y), dz = Math.abs(to.z - from.z)
        if (Number(dx > 0) + Number(dy > 0) + Number(dz > 0) > 1) return bad('place-line 必须沿单一坐标轴')
        const length = Math.max(dx, dy, dz) + 1
        if (length > 256) return bad('place-line 过长（>256 格）')
        if (expandedCount + length > 2048) return bad('展开后 ops 过多（>2048）')
        return expand(Array.from({ length }, (_, step): EditOperation => ({
          kind: 'set-block', at: {
            x: from.x + Math.sign(to.x - from.x) * step,
            y: from.y + Math.sign(to.y - from.y) * step,
            z: from.z + Math.sign(to.z - from.z) * step,
          }, block: op.block as string,
        })))
      }
      case 'place-object': {
        // 弱模型常借用资产摆放的习惯:objectType 写成 assetId、rotation 用 0..3 四分之一圈
        // (契约 rotation 只收 90 的倍数,1/2/3 只能解读为四分之一圈,归一安全)
        const objectType = typeof op.objectType === 'string' && op.objectType ? op.objectType
          : typeof op.assetId === 'string' && op.assetId ? op.assetId
            : typeof op.object === 'string' && op.object ? op.object : null
        const rawRotation = op.rotation === undefined ? 0 : op.rotation
        const rotation = rawRotation === 1 || rawRotation === 2 || rawRotation === 3 ? rawRotation * 90 : rawRotation
        if (!objectType || !isCoord(op.anchor) || !isRotation(rotation)) return bad('place-object 需要 objectType/anchor/rotation')
        return expand([{
          kind: 'place-object', objectType, anchor: op.anchor, rotation,
          ...(typeof op.objectId === 'string' && op.objectId ? { objectId: op.objectId } : {}),
          ...(typeof op.label === 'string' && op.label ? { label: op.label } : {}),
        }])
      }
      case 'move-object':
        if (typeof op.objectId !== 'string' || !op.objectId || !isCoord(op.anchor)) return bad('move-object 需要 objectId 与 anchor')
        return expand([{ kind: 'move-object', objectId: op.objectId, anchor: op.anchor }])
      case 'remove-object':
        if (typeof op.objectId !== 'string' || !op.objectId) return bad('remove-object 需要 objectId')
        return expand([{ kind: 'remove-object', objectId: op.objectId }])
      case 'place-asset': {
        // 注意:资产 op 的 rotation 是 0..3 四分之一圈制,勿复用 isRotation 的角度制
        const rotation = op.rotation ?? 0
        if (typeof op.assetId !== 'string' || !op.assetId || !isCoord(op.anchor)) return bad('place-asset 需要 assetId 与 anchor')
        if (rotation !== 0 && rotation !== 1 && rotation !== 2 && rotation !== 3) return bad('place-asset 的 rotation 需要 0..3')
        return expand([{
          kind: 'place-asset', assetId: op.assetId, anchor: op.anchor, rotation,
          ...(typeof op.placementId === 'string' && op.placementId ? { placementId: op.placementId } : {}),
          ...(typeof op.seed === 'number' && Number.isFinite(op.seed) ? { seed: op.seed } : {}),
        }])
      }
      case 'move-asset': {
        if (typeof op.placementId !== 'string' || !op.placementId || !isCoord(op.anchor)) return bad('move-asset 需要 placementId 与 anchor')
        if (op.rotation !== undefined && op.rotation !== 0 && op.rotation !== 1 && op.rotation !== 2 && op.rotation !== 3) return bad('move-asset 的 rotation 需要 0..3')
        return expand([{
          kind: 'move-asset', placementId: op.placementId, anchor: op.anchor,
          ...(op.rotation !== undefined ? { rotation: op.rotation as 0 | 1 | 2 | 3 } : {}),
        }])
      }
      case 'remove-asset':
        if (typeof op.placementId !== 'string' || !op.placementId) return bad('remove-asset 需要 placementId')
        return expand([{ kind: 'remove-asset', placementId: op.placementId }])
      default:
        return bad(`未知操作 kind=${String(op?.kind)}`)
    }
  })
  const estimatedVoxelWork = parsed.reduce((total, operation) => {
    if (operation.kind !== 'fill') return total + 1
    return total + (Math.abs(operation.to.x - operation.from.x) + 1)
      * (Math.abs(operation.to.y - operation.from.y) + 1)
      * (Math.abs(operation.to.z - operation.from.z) + 1)
  }, 0)
  if (estimatedVoxelWork > 65_536) throw new EditPlannerError('编辑展开范围过大（>65536 格）')
  return parsed
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
