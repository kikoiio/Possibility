import { applyEdits } from './edits'
import { AIR, getBlock, inBounds } from './sections'
import { applySceneRepairChangesToRaw } from './scene-envelope'
import { byteCount, createSceneWorkCounter, DEFAULT_SCENE_BUDGET, sceneBudget } from './scene-work'
import { validateSceneEnvelope } from './scene-validation'
import type {
  SceneCompatibilityEnvelope,
  SceneIssue,
  SceneRepairChange,
  SceneRepairResult,
  SceneStopReason,
  SceneValidationContext,
  SceneValidationReport,
  SceneWorkBudget,
  SceneWorkControl,
  StoredSceneDocument,
} from './scene-compatibility'
import type { AssetPlacement, EditOperation, VoxelCoord, VoxelDocument } from './types'

const clone = <T>(value: T): T => {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

const key = (at: VoxelCoord): string => `${at.x},${at.y},${at.z}`

function placementIds(issue: SceneIssue): string[] {
  const ids = new Set<string>()
  if (issue.placementId) ids.add(issue.placementId)
  const expression = /placements? ['"]([^'"]+)['"]/g
  for (const match of issue.summary.matchAll(expression)) ids.add(match[1])
  return [...ids]
}

function protectedPlacementIds(context: SceneValidationContext, spaceId: string): Set<string> {
  return new Set(context.bindings.protectedPlacements
    .filter((entry) => entry.spaceId === spaceId)
    .map((entry) => entry.placementId))
}

function protectedObjectIds(context: SceneValidationContext, spaceId: string): Set<string> {
  return new Set(context.bindings.protectedObjects
    .filter((entry) => entry.spaceId === spaceId)
    .map((entry) => entry.objectId))
}

function placementAnchor(placement: AssetPlacement): VoxelCoord {
  return { x: placement.anchor[0], y: placement.anchor[1], z: placement.anchor[2] }
}

function samePlacement(a: AssetPlacement | undefined, b: AssetPlacement | undefined): boolean {
  if (!a || !b) return a === b
  return a.id === b.id && a.assetId === b.assetId
    && a.rotation === b.rotation && a.seed === b.seed
    && a.anchor.every((value, index) => value === b.anchor[index])
}

function preservesProtected(
  before: SceneCompatibilityEnvelope,
  after: SceneCompatibilityEnvelope,
  context: SceneValidationContext,
): boolean {
  for (const beforeSpace of before.spaces) {
    const afterSpace = after.spaces.find((space) => space.spaceId === beforeSpace.spaceId)
    if (!afterSpace) return false
    for (const objectId of protectedObjectIds(context, beforeSpace.spaceId)) {
      const beforeObject = beforeSpace.document.objects.find((object) => object.id === objectId)
      const afterObject = afterSpace.document.objects.find((object) => object.id === objectId)
      if (JSON.stringify(beforeObject) !== JSON.stringify(afterObject)) return false
    }
    for (const placementId of protectedPlacementIds(context, beforeSpace.spaceId)) {
      const beforePlacement = beforeSpace.document.assetPlacements?.find((placement) => placement.id === placementId)
      const afterPlacement = afterSpace.document.assetPlacements?.find((placement) => placement.id === placementId)
      if (!samePlacement(beforePlacement, afterPlacement)) return false
    }
  }
  return true
}

/** Nearby collision candidates: horizontal distance 1..3, then dx/dz ascending. */
function nearbyAnchors(document: VoxelDocument, origin: VoxelCoord, limit: number): VoxelCoord[] {
  const result: VoxelCoord[] = []
  for (let radius = 1; radius <= 3 && result.length < Math.min(limit, 24); radius += 1) {
    for (let dx = -radius; dx <= radius && result.length < Math.min(limit, 24); dx += 1) {
      const remaining = radius - Math.abs(dx)
      const dzs = remaining === 0 ? [0] : [-remaining, remaining]
      for (const dz of dzs) {
        const candidate = { x: origin.x + dx, y: origin.y, z: origin.z + dz }
        if (inBounds(document.size, candidate)) result.push(candidate)
        if (result.length >= Math.min(limit, 24)) break
      }
    }
  }
  return result
}

function sameIssueIdentity(a: SceneIssue, b: SceneIssue): boolean {
  return a.code === b.code && a.spaceId === b.spaceId && a.objectId === b.objectId
    && a.placementId === b.placementId && a.reason === b.reason
    && key(a.at ?? { x: -1, y: -1, z: -1 }) === key(b.at ?? { x: -1, y: -1, z: -1 })
}

function strictlyImproves(before: SceneValidationReport, after: SceneValidationReport): boolean {
  return (after.status === 'invalid' || after.status === 'valid')
    && after.issueCount < before.issueCount
    && after.issues.every((issue) => before.issues.some((prior) => sameIssueIdentity(prior, issue)))
}

function isRepairablePlacementIssue(issue: SceneIssue): boolean {
  return issue.code === 'asset-overlap' || issue.code === 'out-of-bounds'
}

function isDecorativeAsset(context: SceneValidationContext, placement: AssetPlacement): boolean {
  const category = context.assets.assets[placement.assetId]?.category
  return category === 'vegetation' || category === 'decoration'
}

function protectedClearanceCell(
  document: VoxelDocument,
  context: SceneValidationContext,
  spaceId: string,
  at: VoxelCoord,
): boolean {
  const target = key(at)
  const objectCells = new Map(document.objectCells.map((entry) => [entry.objectId, entry.cells]))
  if (document.objectCells.some((entry) => entry.cells.some((cell) => key(cell) === target))) return true
  if ((document.assetPlacements ?? []).some((placement) => {
    const asset = context.assets.assets[placement.assetId]
    const [x, y, z] = placement.anchor
    const [width, depth] = asset?.footprint ?? [1, 1]
    const height = asset?.height ?? 1
    return at.x >= x && at.x < x + width && at.z >= z && at.z < z + depth
      && at.y >= y && at.y < y + height
  })) return true
  const protectedObjects = new Set([
    ...protectedObjectIds(context, spaceId),
    ...document.lockedObjectIds,
    ...context.bindings.locationBindings.filter((entry) => entry.spaceId === spaceId).map((entry) => entry.carrierId),
    ...context.bindings.personBindings.filter((entry) => entry.spaceId === spaceId).map((entry) => entry.objectId),
  ])
  const protectedPlacements = new Set([
    ...protectedPlacementIds(context, spaceId),
    ...context.bindings.entries.filter((entry) => entry.fromSpaceId === spaceId && entry.carrierId)
      .map((entry) => entry.carrierId!),
  ])
  if (document.objects.some((object) => protectedObjects.has(object.id)
    && (objectCells.get(object.id) ?? []).some((cell) => key(cell) === target
      || (cell.x === at.x && cell.z === at.z && cell.y === at.y + 1)))) return true
  if ((document.assetPlacements ?? []).some((placement) => {
    if (!protectedPlacements.has(placement.id ?? '')) return false
    const asset = context.assets.assets[placement.assetId]
    const [x, y, z] = placement.anchor
    const [width, depth] = asset?.footprint ?? [1, 1]
    const height = asset?.height ?? 1
    return at.x >= x && at.x < x + width && at.z >= z && at.z < z + depth
      && (at.y >= y && at.y < y + height || at.y === y - 1)
  })) return true
  if (context.bindings.entries.some((entry) => entry.fromSpaceId === spaceId
    && entry.at.x === at.x && entry.at.z === at.z
    && (entry.at.y === at.y || entry.at.y + 1 === at.y))) return true
  return false
}

function canClearHeadCell(
  issue: SceneIssue,
  space: SceneCompatibilityEnvelope['spaces'][number],
  context: SceneValidationContext,
): VoxelCoord | null {
  if (issue.code !== 'walk-clearance' || !issue.at
    || space.document.objectCells.some((entry) => entry.cells.some((cell) => key(cell) === key(issue.at!)))) return null
  if (space.document.size.height < 1) return null
  const head = { x: issue.at.x, y: issue.at.y + 1, z: issue.at.z }
  if (!inBounds(space.document.size, head) || getBlock(space.document, head) === AIR
    || protectedClearanceCell(space.document, context, space.spaceId, head)) return null
  if (space.document.objects.some((object) => {
    const cells = space.document.objectCells.find((entry) => entry.objectId === object.id)?.cells ?? []
    const lowest = Math.min(...cells.map((cell) => cell.y), object.anchor.y)
    return protectedObjectIds(context, space.spaceId).has(object.id)
      && head.x === object.anchor.x && head.z === object.anchor.z && head.y === lowest - 1
  })) return null
  return head
}

function materializeAssetEdit(
  envelope: SceneCompatibilityEnvelope,
  spaceId: string,
  operation: EditOperation,
): SceneCompatibilityEnvelope | null {
  const target = envelope.spaces.find((space) => space.spaceId === spaceId)
  if (!target) return null
  try {
    const source = operation.kind === 'move-asset' || operation.kind === 'remove-asset'
      ? target.document
      : clone(target.document)
    const result = applyEdits(source, [operation])
    return {
      // Candidate validation is read-only; preserve the large untouched envelope
      // instead of deep-cloning it for every nearby repair position.
      original: envelope.original,
      spaces: envelope.spaces.map((space) => ({
        spaceId: space.spaceId,
        document: space.spaceId === spaceId ? result.document : space.document,
      })),
      format: envelope.format,
      compatibilityChanges: envelope.compatibilityChanges,
    }
  } catch {
    return null
  }
}

function incomplete(report: SceneValidationReport, stopReason: SceneValidationReport['stopReason']): SceneValidationReport {
  return { ...report, status: 'incomplete', countIsExact: false, stopReason }
}

function applyRawChanges(
  original: StoredSceneDocument,
  changes: SceneRepairChange[],
): StoredSceneDocument | { status: string } {
  // The envelope patcher resolves placement IDs from a fresh decode. Apply legacy ID
  // assignments first so subsequent move/remove changes can resolve those IDs.
  const compatibility = changes.filter((change) => change.kind === 'assign-placement-id')
  const repairs = changes.filter((change) => change.kind !== 'assign-placement-id')
  const assigned = applySceneRepairChangesToRaw(original, compatibility)
  if ('status' in assigned) return assigned
  return applySceneRepairChangesToRaw(assigned, repairs)
}

/**
 * Plan conservative repairs for a decoded scene. Only known vegetation/decorative assets
 * may move or be removed. Every candidate is revalidated and must strictly reduce the
 * complete issue count; objects, blocks, bindings, and protected placements are untouched.
 */
export async function repairSceneCompatibility(
  envelope: SceneCompatibilityEnvelope,
  context: SceneValidationContext,
  budget: SceneWorkBudget,
  control: SceneWorkControl,
): Promise<SceneRepairResult> {
  const repairWorkLimit = sceneBudget({ maxRepairWorkUnits: budget.maxRepairWorkUnits })
    .maxRepairWorkUnits ?? DEFAULT_SCENE_BUDGET.maxRepairWorkUnits ?? 48_000_000
  // Validation keeps its shorter maxWallMs cap for each pass. The repair planner
  // itself owns the overall draft allowance, while the caller's abort signal still
  // fences any enclosing deadline (for example, an API draft that has less time left).
  const repairWallLimit = budget.maxDraftWallMs ?? budget.maxWallMs
  const plannerStartedAt = control.nowMs()
  const planner = createSceneWorkCounter({
    signal: control.signal,
    nowMs: control.nowMs,
    yieldControl: control.yieldControl,
    deadlineAt: plannerStartedAt + repairWallLimit,
    budget: { ...budget, maxRepairWorkUnits: repairWorkLimit, maxWorkUnits: repairWorkLimit, maxWallMs: repairWallLimit },
  })
  let current = clone(envelope) as SceneCompatibilityEnvelope
  const changes = clone(envelope.compatibilityChanges)
  // Stable placement IDs normalize legacy input; they are compatibility metadata,
  // not semantic repair operations and must not consume the repair-change quota.
  let repairChangeCount = changes.filter((change) => change.kind !== 'assign-placement-id').length
  const repairChangeLimit = budget.maxRepairChanges ?? Number.MAX_SAFE_INTEGER
  let candidateCount = 0
  let stopReason: SceneStopReason | null = null
  let report = await validateSceneEnvelope(current, context, budget, control, 'existing')
  planner.work(report.workUnitsUsed)

  // One planner counter owns the entire repair. Initial inspection and every
  // candidate revalidation are charged to it instead of resetting per candidate.
  const reportWithAggregateWork = (value: SceneValidationReport): SceneValidationReport => ({
    ...value,
    workUnitsUsed: planner.workUnits,
  })
  const blocked = (value: SceneValidationReport): SceneRepairResult => ({
    status: 'blocked', changes, report: reportWithAggregateWork(value),
  })
  const reserveCandidate = (): boolean => {
    if (candidateCount >= budget.maxRepairCandidates) {
      stopReason = 'attempt-limit'
      return false
    }
    candidateCount += 1
    return true
  }
  const validateCandidate = async (candidate: SceneCompatibilityEnvelope): Promise<SceneValidationReport | null> => {
    if (!planner.check()) {
      stopReason = planner.stopReason ?? 'work-limit'
      return null
    }
    const remainingWork = Math.max(0, repairWorkLimit - planner.workUnits)
    const candidateWorkLimit = Math.min(budget.maxWorkUnits, remainingWork)
    const candidateReport = await validateSceneEnvelope(
      candidate, context, { ...budget, maxWorkUnits: candidateWorkLimit }, control, 'repair',
    )
    if (!planner.work(candidateReport.workUnitsUsed)) {
      stopReason = planner.stopReason ?? 'work-limit'
      return incomplete(candidateReport, stopReason)
    }
    if (candidateReport.status === 'incomplete') {
      stopReason = candidateReport.stopReason ?? 'work-limit'
      return candidateReport
    }
    return candidateReport
  }

  if (planner.stopped) return blocked(incomplete(report, planner.stopReason ?? 'work-limit'))
  if (report.status === 'incomplete') return blocked(report)
  if (report.status === 'valid') {
    const candidate = applyRawChanges(envelope.original, changes)
    if ('status' in candidate) return blocked(report)
    if (byteCount(candidate) > budget.maxSerializedBytes) return blocked(incomplete(report, 'payload-limit'))
    return { status: 'ready', candidate, changes, report: reportWithAggregateWork(report) }
  }

  for (let pass = 0; pass < budget.maxRepairPasses; pass += 1) {
    if (!planner.check()) return blocked(incomplete(report, planner.stopReason ?? 'attempt-limit'))
    let accepted = false
    let halted = false

    for (const issue of report.issues) {
      if (halted) break
      if (!isRepairablePlacementIssue(issue) || !issue.spaceId) continue
      let acceptedIssue = false
      const space = current.spaces.find((entry) => entry.spaceId === issue.spaceId)
      if (!space || !space.document.assetPlacements) continue
      const protectedIds = protectedPlacementIds(context, issue.spaceId)
      const targets = placementIds(issue)
        .map((id) => space.document.assetPlacements?.find((placement) => placement.id === id))
        .filter((placement): placement is AssetPlacement => !!placement)
        .filter((placement) => !protectedIds.has(placement.id ?? '') && isDecorativeAsset(context, placement))

      for (const placement of targets) {
        if (halted || acceptedIssue) break
        const origin = placementAnchor(placement)
        for (const anchor of nearbyAnchors(space.document, origin, Math.max(1, budget.maxRepairCandidates))) {
          if (repairChangeCount >= repairChangeLimit) break
          if (!reserveCandidate()) { halted = true; break }
          if (anchor.x === origin.x && anchor.y === origin.y && anchor.z === origin.z) continue
          const candidate = materializeAssetEdit(current, issue.spaceId, {
            kind: 'move-asset', placementId: placement.id!, anchor,
          })
          if (!candidate || !preservesProtected(current, candidate, context)) continue
          const candidateReport = await validateCandidate(candidate)
          if (!candidateReport || candidateReport.status === 'incomplete') {
            report = candidateReport ?? incomplete(report, stopReason ?? 'work-limit')
            halted = true
            break
          }
          if (!strictlyImproves(report, candidateReport)) continue
          changes.push({
            id: `repair-move-asset:${issue.spaceId}:${placement.id}:${key(anchor)}`,
            spaceId: issue.spaceId,
            issueIds: [issue.id],
            kind: 'move-asset',
            placementId: placement.id!,
            from: origin,
            to: anchor,
            summary: `将装饰资产 '${placement.id}' 移到最近的安全位置`,
          })
          repairChangeCount += 1
          current = candidate
          report = candidateReport
          accepted = true
          acceptedIssue = true
          break
        }
        if (acceptedIssue) break

        if (halted) break
        if (repairChangeCount < repairChangeLimit) {
          if (!reserveCandidate()) { halted = true; break }
          const candidate = materializeAssetEdit(current, issue.spaceId, { kind: 'remove-asset', placementId: placement.id! })
          if (candidate && preservesProtected(current, candidate, context)) {
            const candidateReport = await validateCandidate(candidate)
            if (!candidateReport || candidateReport.status === 'incomplete') {
              report = candidateReport ?? incomplete(report, stopReason ?? 'work-limit')
              halted = true
              break
            }
            if ((candidateReport.status === 'invalid' || candidateReport.status === 'valid')
              && strictlyImproves(report, candidateReport)) {
              changes.push({
                id: `repair-remove-asset:${issue.spaceId}:${placement.id}`,
                spaceId: issue.spaceId,
                issueIds: [issue.id],
                kind: 'remove-asset',
                placementId: placement.id!,
                original: clone(placement),
                summary: `移除无法安全摆放的装饰资产 '${placement.id}'`,
              })
              repairChangeCount += 1
              current = candidate
              report = candidateReport
              accepted = true
              acceptedIssue = true
            }
          }
        }
        if (acceptedIssue) break
      }
      if (halted) break
    }

    if (halted) return blocked(incomplete(report, stopReason ?? report.stopReason ?? 'attempt-limit'))

    if (!accepted) {
      for (const issue of report.issues) {
        const space = issue.spaceId ? current.spaces.find((entry) => entry.spaceId === issue.spaceId) : undefined
        if (!space) continue
        const head = canClearHeadCell(issue, space, context)
        if (!head || repairChangeCount >= repairChangeLimit) continue
        if (!reserveCandidate()) { halted = true; break }
        const candidate = materializeAssetEdit(current, issue.spaceId!, { kind: 'set-block', at: head, block: AIR })
        if (!candidate || !preservesProtected(current, candidate, context)) continue
        const candidateReport = await validateCandidate(candidate)
        if (!candidateReport || candidateReport.status === 'incomplete') {
          report = candidateReport ?? incomplete(report, stopReason ?? 'work-limit')
          halted = true
          break
        }
        if (!strictlyImproves(report, candidateReport)) continue
        changes.push({
          id: `repair-clearance:${issue.spaceId}:${key(head)}`,
          spaceId: issue.spaceId!, issueIds: [issue.id], kind: 'set-block', at: head,
          fromBlock: getBlock(space.document, head), toBlock: AIR,
          summary: `移除真实通道净空头顶格 ${key(head)}`,
        })
        repairChangeCount += 1
        current = candidate
        report = candidateReport
        accepted = true
        break
      }
    }
    if (halted) return blocked(incomplete(report, stopReason ?? report.stopReason ?? 'attempt-limit'))

    if (!accepted) break
    if (report.status === 'valid') break
    await control.yieldControl()
  }

  if (report.status === 'valid') {
    const candidate = applyRawChanges(envelope.original, changes)
    if ('status' in candidate) return blocked(report)
    if (byteCount(candidate) > budget.maxSerializedBytes) return blocked(incomplete(report, 'payload-limit'))
    return { status: 'ready', candidate, changes, report: reportWithAggregateWork(report) }
  }
  return blocked(report)
}

export const planSceneRepair = repairSceneCompatibility
export const repairScene = repairSceneCompatibility
