import { getObjectTemplate } from './catalog'
import type { AssetManifest } from './assets'
import { createBlockRegistry } from './registry'
import { rotatedOffsets } from './edits'
import { byteCount, createSceneWorkCounter } from './scene-work'
import { getBlock, inBounds } from './sections'
import { validateDocument } from './validation'
import { validateWalkabilityWithStatsAsync } from './walkability'
import type {
  SceneCompatibilityEnvelope, SceneIssue, SceneRuleNote, SceneStopReason, SceneValidationContext,
  SceneValidationReport, SceneWorkBudget, SceneWorkControl,
} from './scene-compatibility'
import type { BlockRegistry, VoxelCoord, VoxelDocument } from './types'

const key = (at: VoxelCoord): string => `${at.x},${at.y},${at.z}`
const clean = (value: string): string => value.replace(/\s+/g, ' ').trim()

type RawIssue = { code: string; message: string; at?: VoxelCoord }

function categoryFor(code: string): SceneIssue['category'] {
  if (code.startsWith('walk-')) return 'walkability'
  if (code === 'unknown-asset' || code === 'asset-overlap' || code.startsWith('asset-')) return 'asset'
  if (code.includes('location') || code === 'locked-violation' || code.startsWith('binding')) return 'binding'
  if (code.includes('connect') || code.includes('entry') || code.includes('space')) return 'connection'
  return 'structure'
}

function suggestionFor(code: string): string {
  if (code === 'asset-overlap') return '调整资产位置或旋转，确认不与其他资产、物体重叠。'
  if (code === 'unknown-asset') return '补齐已发布的资产清单，或移除无法识别的资产摆放。'
  if (code === 'floating-object') return '为物体补充可靠支撑，不要直接猜测移动语义物体。'
  if (code === 'walk-clearance') return '保持真实入口和走廊净高至少两格；家具内部腔体仅作分类说明。'
  if (code === 'walk-connectivity') return '为绑定物体提供可达站位，并保留入口与保护对象。'
  if (code === 'walk-lighting') return '补充室内光源或调整遮挡，确保可行走区域照明达标。'
  if (code === 'walk-stairs') return '补齐台阶或安全坡道，避免不可攀登的人工高差。'
  if (code === 'walk-gap') return '补齐地面缺口或提供不依赖跳跃的绕行路径。'
  if (code === 'location-unbound' || code === 'missing-location') return '将地点绑定到当前空间中存在的物体或资产摆放。'
  if (code === 'invalid-meta') return '修正元数据形状后重新校验。'
  if (code === 'out-of-bounds') return '将对象、资产或入口移回当前空间边界内。'
  if (code === 'object-overlap') return '拆分重叠占据格，保留语义对象身份。'
  return '修正该空间的结构或绑定资料后重新校验。'
}

function identityFromMessage(message: string): { objectId?: string; placementId?: string } {
  return {
    objectId: message.match(/(?:object|objects) ['\"]([^'\"]+)['\"]/)?.[1],
    placementId: message.match(/(?:placement|placements) ['\"]([^'\"]+)['\"]/)?.[1],
  }
}

function assetReason(raw: RawIssue): SceneIssue['reason'] | undefined {
  if (raw.code !== 'asset-overlap') return undefined
  return /support|悬空|beneath/i.test(raw.message) ? 'unsupported' : 'collision'
}

function makeIssue(raw: RawIssue, spaceId: string | null, origin: SceneIssue['origin'], ordinal: number): SceneIssue {
  const identity = identityFromMessage(raw.message)
  const location = raw.at ? key(raw.at) : 'none'
  const id = [raw.code, origin, spaceId ?? 'scene', identity.objectId ?? '', identity.placementId ?? '', location, ordinal].join('|')
  const reason = assetReason(raw)
  return {
    id,
    code: raw.code,
    origin,
    category: categoryFor(raw.code),
    spaceId,
    ...(identity.objectId ? { objectId: identity.objectId } : {}),
    ...(identity.placementId ? { placementId: identity.placementId } : {}),
    ...(raw.at ? { at: raw.at } : {}),
    summary: clean(raw.message),
    suggestion: suggestionFor(raw.code),
    blocking: true,
    ...(reason ? { reason } : {}),
  }
}

function uniqueIssue(code: string, message: string, at?: VoxelCoord): RawIssue {
  return { code, message, ...(at ? { at } : {}) }
}

function notesForFurniture(spaceId: string, doc: VoxelDocument): SceneRuleNote[] {
  const notes: SceneRuleNote[] = []
  const cellsByObject = new Map(doc.objectCells.map((entry) => [entry.objectId, entry.cells]))
  for (const object of doc.objects) {
    const template = getObjectTemplate(object.objectType)
    if (!template?.nonWalkableCavities?.length) continue
    const templateOffsets = template.cells.map((cell) => cell.offset)
    const rotated = rotatedOffsets(templateOffsets, object.rotation)
    const expected = new Set(rotated.map((offset) => key({
      x: object.anchor.x + offset.x, y: object.anchor.y + offset.y, z: object.anchor.z + offset.z,
    })))
    const rotateCavity = (cavity: VoxelCoord): VoxelCoord => {
      const raw = templateOffsets.map(({ x, y, z }) => {
        if (object.rotation === 90) return { x: -z, y, z: x }
        if (object.rotation === 180) return { x: -x, y, z: -z }
        if (object.rotation === 270) return { x: z, y, z: -x }
        return { x, y, z }
      })
      const minX = Math.min(...raw.map((offset) => offset.x))
      const minZ = Math.min(...raw.map((offset) => offset.z))
      const rotatedCavity = object.rotation === 90 ? { x: -cavity.z, y: cavity.y, z: cavity.x }
        : object.rotation === 180 ? { x: -cavity.x, y: cavity.y, z: -cavity.z }
          : object.rotation === 270 ? { x: cavity.z, y: cavity.y, z: -cavity.x } : cavity
      return { x: rotatedCavity.x - minX, y: rotatedCavity.y, z: rotatedCavity.z - minZ }
    }
    const actualCells = cellsByObject.get(object.id)
    if (!actualCells || actualCells.length !== template.cells.length || ![...expected].every((cell) => actualCells.some((actual) => key(actual) === cell))) continue
    for (const cavity of template.nonWalkableCavities) {
      const offset = rotateCavity(cavity)
      const at = { x: object.anchor.x + offset.x, y: object.anchor.y + offset.y, z: object.anchor.z + offset.z }
      if (!inBounds(doc.size, at) || expected.has(key(at)) || getBlock(doc, at) !== 'air') continue
      const below = { x: at.x, y: at.y - 1, z: at.z }
      const above = { x: at.x, y: at.y + 1, z: at.z }
      const actual = new Set(actualCells.map(key))
      if (!actual.has(key(below)) || !actual.has(key(above))) continue
      notes.push({ code: 'furniture-cavity', spaceId, objectId: object.id, at, message: `物体 '${object.id}' 的模板内部开放格已核实为家具腔体，不是通行入口。` })
    }
  }
  return notes
}

function bindingIssues(spaces: Array<{ spaceId: string; document: VoxelDocument }>, context: SceneValidationContext): Array<{ spaceId: string | null; issue: RawIssue }> {
  const result: Array<{ spaceId: string | null; issue: RawIssue }> = []
  const byId = new Map(spaces.map((space) => [space.spaceId, space]))
  const bindings = context.bindings
  for (const expected of bindings.locationBindings) {
    const space = byId.get(expected.spaceId)
    const matches = space?.document.locations.filter((location) => location.name === expected.location.name && location.objectId === expected.carrierId) ?? []
    if (matches.length !== 1) result.push({ spaceId: expected.spaceId, issue: uniqueIssue('binding-mismatch', `地点 '${expected.location.name}' 未唯一绑定到载体 '${expected.carrierId}'`, undefined) })
  }
  for (const expected of bindings.personBindings) {
    const space = byId.get(expected.spaceId)
    const object = space?.document.objects.find((candidate) => candidate.id === expected.objectId)
    if (!object || object.binding?.kind !== 'person' || object.binding.personId !== expected.personId) {
      result.push({ spaceId: expected.spaceId, issue: uniqueIssue('binding-mismatch', `人物 '${expected.personId}' 的绑定载体 '${expected.objectId}' 缺失或不一致`, object?.anchor) })
    }
  }
  for (const protectedObject of bindings.protectedObjects) {
    const space = byId.get(protectedObject.spaceId)
    const object = space?.document.objects.find((candidate) => candidate.id === protectedObject.objectId)
    if (!object) result.push({ spaceId: protectedObject.spaceId, issue: uniqueIssue('binding-mismatch', `受保护物体 '${protectedObject.objectId}' 不存在` ) })
  }
  for (const protectedPlacement of bindings.protectedPlacements) {
    const space = byId.get(protectedPlacement.spaceId)
    const placement = space?.document.assetPlacements?.find((candidate) => candidate.id === protectedPlacement.placementId)
    if (!placement) result.push({ spaceId: protectedPlacement.spaceId, issue: uniqueIssue('binding-mismatch', `受保护资产摆放 '${protectedPlacement.placementId}' 不存在` ) })
  }
  return result
}

function connectionIssues(spaces: Array<{ spaceId: string; document: VoxelDocument }>, context: SceneValidationContext): Array<{ spaceId: string | null; issue: RawIssue }> {
  const result: Array<{ spaceId: string | null; issue: RawIssue }> = []
  const byId = new Map(spaces.map((space) => [space.spaceId, space]))
  for (const entry of context.bindings.entries) {
    const source = byId.get(entry.fromSpaceId)
    const target = byId.get(entry.toSpaceId)
    if (!source || !target) {
      result.push({ spaceId: entry.fromSpaceId, issue: uniqueIssue('connection-invalid', `入口目标空间 '${entry.toSpaceId}' 不存在`, entry.at) })
      continue
    }
    const matching = source.document.spaceEntries.filter((candidate) => candidate.spaceId === entry.toSpaceId && key(candidate.at) === key(entry.at))
    if (matching.length !== 1 || !inBounds(source.document.size, entry.at)) {
      result.push({ spaceId: entry.fromSpaceId, issue: uniqueIssue('connection-invalid', `跨空间入口未在坐标 ${key(entry.at)} 正确声明`, entry.at) })
    }
    if (entry.carrierId && !source.document.objects.some((object) => object.id === entry.carrierId)
      && !(source.document.assetPlacements ?? []).some((placement) => placement.id === entry.carrierId)) {
      result.push({ spaceId: entry.fromSpaceId, issue: uniqueIssue('connection-invalid', `入口载体 '${entry.carrierId}' 不存在`, entry.at) })
    }
  }
  return result
}

function contextAssetManifest(context: SceneValidationContext): AssetManifest {
  return context.assets
}

/** Validate every space and return an exact count only after complete traversal. */
export async function validateSceneEnvelope(
  envelope: SceneCompatibilityEnvelope,
  context: SceneValidationContext,
  budget: SceneWorkBudget,
  control: SceneWorkControl,
  origin: SceneIssue['origin'] = 'existing',
): Promise<SceneValidationReport> {
  // Snapshot a possibly computed operation deadline exactly once; nested walkability
  // checks in this same validation share it, while later repair validations get fresh caps.
  const workControl = { ...control }
  const started = workControl.nowMs()
  const counter = createSceneWorkCounter({ ...workControl, budget })
  const issues: SceneIssue[] = []
  const notes: SceneRuleNote[] = []
  const checkedSpaceIds: string[] = []
  let pendingSpaceIds = envelope.spaces.map((space) => space.spaceId)
  let stop: SceneStopReason | null = null
  let ordinal = 0
  let visitedCellsUsed = 0
  let workspaceBytesUsed = 0
  let workAtLastYield = 0
  let yieldedAt = workControl.nowMs()

  const add = (raw: RawIssue, spaceId: string | null): boolean => {
    if (issues.length >= budget.maxCollectedIssues) {
      counter.stop('issue-limit')
      stop = 'issue-limit'
      return false
    }
    issues.push(makeIssue(raw, spaceId, origin, ordinal++))
    return true
  }
  const tick = async (units = 1): Promise<boolean> => {
    if (!counter.work(units)) return false
    if (counter.workUnits - workAtLastYield >= 512 || workControl.nowMs() - yieldedAt >= 8) {
      await workControl.yieldControl()
      workAtLastYield = counter.workUnits
      yieldedAt = workControl.nowMs()
    }
    return !counter.shouldStop()
  }

  try {
    if (!counter.addBytes(byteCount(envelope.original))) stop = 'payload-limit'
    if (envelope.spaces.length > budget.maxSpaces) stop = 'space-limit'
    if (context.assets === undefined) stop = 'context-unavailable'
    for (const space of envelope.spaces) {
      if (stop || checkedSpaceIds.length >= budget.maxSpaces || !(await tick())) break
      const registry: BlockRegistry = createBlockRegistry(space.document.theme)
      const structural = validateDocument(space.document, registry, contextAssetManifest(context))
      for (const issue of structural) {
        if (!(await tick()) || !add(issue, space.spaceId)) break
      }
      if (stop || counter.shouldStop()) break
      if (!(await tick())) {
        stop = counter.stopReason === 'cancelled' ? 'cancelled'
          : counter.stopReason === 'deadline' ? 'deadline' : 'work-limit'
        break
      }
      const furnitureNotes = notesForFurniture(space.spaceId, space.document)
      const declaredEntryCells = new Set([
        ...space.document.spaceEntries.map(entry => key(entry.at)),
        ...context.bindings.entries.filter(entry => entry.fromSpaceId === space.spaceId).map(entry => key(entry.at)),
      ])
      const verifiedFurnitureCavities = new Set(furnitureNotes
        .filter(note => note.at && !declaredEntryCells.has(key(note.at)))
        .map(note => key(note.at!)))
      let walkabilityWorkReported = 0
      const walking = await validateWalkabilityWithStatsAsync(
        space.document, registry, {
          maxVisited: budget.maxVisitedPerFlood,
          maxWorkspaceBytes: budget.maxWorkspaceBytes,
        }, {
          ...workControl,
          consumeWork: (units: number) => {
            walkabilityWorkReported += units
            return counter.work(units)
          },
          consumeWorkspace: (bytes: number) => {
            workspaceBytesUsed = Math.max(workspaceBytesUsed, bytes)
            return bytes <= budget.maxWorkspaceBytes
          },
        },
      )
      visitedCellsUsed += walking.visitedCells
      workspaceBytesUsed = Math.max(workspaceBytesUsed, walking.workspaceBytesPeak)
      if (!counter.work(walking.workUnits - walkabilityWorkReported)) {
        stop = counter.stopReason === 'cancelled' ? 'cancelled'
          : counter.stopReason === 'deadline' ? 'deadline'
            : counter.stopReason === 'workspace-limit' ? 'workspace-limit' : 'work-limit'
        break
      }
      if (workspaceBytesUsed > budget.maxWorkspaceBytes) {
        stop = 'workspace-limit'
        break
      }
      if (!walking.complete) {
        stop = walking.stopReason === 'cancelled' ? 'cancelled'
          : walking.stopReason === 'deadline' ? 'deadline'
            : walking.stopReason === 'workspace-limit' ? 'workspace-limit'
              : walking.stopReason === 'work-limit' ? 'work-limit' : 'visit-limit'
        break
      }
      for (const issue of walking.issues) {
        // A physically exact, non-entry template cavity is explanatory metadata, not a
        // one-cell passage. Suppress only the clearance false positive at that exact cell.
        if (issue.code === 'walk-clearance' && issue.at && verifiedFurnitureCavities.has(key(issue.at))) continue
        if (!(await tick()) || !add(issue, space.spaceId)) break
      }
      notes.push(...furnitureNotes)
      checkedSpaceIds.push(space.spaceId)
      pendingSpaceIds = pendingSpaceIds.filter((id) => id !== space.spaceId)
    }
    if (!stop && pendingSpaceIds.length === 0) {
      for (const result of [...bindingIssues(envelope.spaces, context), ...connectionIssues(envelope.spaces, context)]) {
        if (!(await tick()) || !add(result.issue, result.spaceId)) break
      }
    }
  } catch (error) {
    stop = 'context-unavailable'
    add(uniqueIssue('invalid-envelope', `场景资料无法完成解析:${error instanceof Error ? error.message : '未知错误'}`), null)
  }

  if (!stop && counter.shouldStop()) {
    const reason = counter.stopReason
    stop = reason === 'cancelled' ? 'cancelled'
      : reason === 'deadline' ? 'deadline'
        : reason === 'payload-limit' ? 'payload-limit'
          : reason === 'workspace-limit' ? 'workspace-limit'
            : reason === 'visit-limit' ? 'visit-limit' : 'work-limit'
  }
  if (workControl.signal.aborted) stop = 'cancelled'
  const complete = stop === null && pendingSpaceIds.length === 0
  return {
    status: complete ? (issues.length === 0 ? 'valid' : 'invalid') : 'incomplete',
    issues,
    issueCount: issues.length,
    countIsExact: complete,
    stopReason: stop,
    checkedSpaceIds,
    pendingSpaceIds,
    workUnitsUsed: counter.workUnits,
    workspaceBytesUsed,
    visitedCellsUsed,
    elapsedMs: Math.max(0, workControl.nowMs() - started),
    ruleNotes: { items: notes.slice(0, 64), total: notes.length, hasMore: notes.length > 64 },
  }
}
