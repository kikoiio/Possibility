import { applyEdits } from './edits'
import { applySceneRepairChangesToRaw } from './scene-envelope'
import { createSceneWorkCounter } from './scene-work'
import { validateSceneEnvelope } from './scene-validation'
import type {
  SceneCompatibilityEnvelope,
  SceneIssue,
  SceneRepairChange,
  SceneRepairResult,
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
const compareCoord = (a: VoxelCoord, b: VoxelCoord): number => a.x - b.x || a.y - b.y || a.z - b.z
const distance = (a: VoxelCoord, b: VoxelCoord): number => (
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z)
)

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

/** Generate nearest anchors in stable lexicographic order without random sampling. */
function nearbyAnchors(document: VoxelDocument, origin: VoxelCoord, limit: number): VoxelCoord[] {
  const maxRadius = document.size.width + document.size.height + document.size.depth
  const result: VoxelCoord[] = []
  for (let radius = 0; radius <= maxRadius && result.length < limit; radius += 1) {
    for (let x = 0; x < document.size.width && result.length < limit; x += 1) {
      for (let y = 0; y < document.size.height && result.length < limit; y += 1) {
        for (let z = 0; z < document.size.depth && result.length < limit; z += 1) {
          const candidate = { x, y, z }
          if (distance(origin, candidate) === radius) result.push(candidate)
        }
      }
    }
  }
  return result.sort((a, b) => distance(origin, a) - distance(origin, b) || compareCoord(a, b))
}

function isRepairablePlacementIssue(issue: SceneIssue): boolean {
  return issue.code === 'asset-overlap' || issue.code === 'out-of-bounds'
}

function isDecorativeAsset(context: SceneValidationContext, placement: AssetPlacement): boolean {
  const category = context.assets.assets[placement.assetId]?.category
  return category === 'vegetation' || category === 'decoration'
}

function materializeAssetEdit(
  envelope: SceneCompatibilityEnvelope,
  spaceId: string,
  operation: EditOperation,
): SceneCompatibilityEnvelope | null {
  const target = envelope.spaces.find((space) => space.spaceId === spaceId)
  if (!target) return null
  try {
    const result = applyEdits(clone(target.document), [operation])
    return {
      original: clone(envelope.original) as StoredSceneDocument,
      spaces: envelope.spaces.map((space) => ({
        spaceId: space.spaceId,
        document: space.spaceId === spaceId ? result.document : clone(space.document),
      })),
      format: envelope.format,
      compatibilityChanges: clone(envelope.compatibilityChanges),
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
  const planner = createSceneWorkCounter({ ...control, budget })
  let current = clone(envelope) as SceneCompatibilityEnvelope
  const changes = clone(envelope.compatibilityChanges)
  let report = await validateSceneEnvelope(current, context, budget, control, 'existing')

  if (report.status === 'incomplete') return { status: 'blocked', changes, report }
  if (report.status === 'valid') {
    const candidate = applyRawChanges(envelope.original, changes)
    if ('status' in candidate) return { status: 'blocked', changes, report }
    return { status: 'ready', candidate, changes, report }
  }

  for (let pass = 0; pass < budget.maxRepairPasses; pass += 1) {
    if (!planner.check()) return { status: 'blocked', changes, report: incomplete(report, planner.stopReason ?? 'attempt-limit') }
    let accepted = false

    for (const issue of report.issues) {
      if (!isRepairablePlacementIssue(issue) || !issue.spaceId) continue
      const space = current.spaces.find((entry) => entry.spaceId === issue.spaceId)
      if (!space || !space.document.assetPlacements) continue
      const protectedIds = protectedPlacementIds(context, issue.spaceId)
      const targets = placementIds(issue)
        .map((id) => space.document.assetPlacements?.find((placement) => placement.id === id))
        .filter((placement): placement is AssetPlacement => !!placement)
        .filter((placement) => !protectedIds.has(placement.id ?? '') && isDecorativeAsset(context, placement))

      for (const placement of targets) {
        const origin = placementAnchor(placement)
        for (const anchor of nearbyAnchors(space.document, origin, Math.max(1, budget.maxRepairCandidates))) {
          if (!planner.check() || changes.length >= (budget.maxRepairChanges ?? Number.MAX_SAFE_INTEGER)) break
          if (anchor.x === origin.x && anchor.y === origin.y && anchor.z === origin.z) continue
          const candidate = materializeAssetEdit(current, issue.spaceId, {
            kind: 'move-asset', placementId: placement.id!, anchor,
          })
          if (!candidate || !preservesProtected(current, candidate, context)) continue
          const candidateReport = await validateSceneEnvelope(candidate, context, budget, control, 'repair')
          if ((candidateReport.status !== 'invalid' && candidateReport.status !== 'valid')
            || candidateReport.issueCount >= report.issueCount) continue
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
          current = candidate
          report = candidateReport
          accepted = true
          break
        }
        if (accepted) break

        if (planner.check() && changes.length < (budget.maxRepairChanges ?? Number.MAX_SAFE_INTEGER)) {
          const candidate = materializeAssetEdit(current, issue.spaceId, { kind: 'remove-asset', placementId: placement.id! })
          if (candidate && preservesProtected(current, candidate, context)) {
            const candidateReport = await validateSceneEnvelope(candidate, context, budget, control, 'repair')
            if ((candidateReport.status === 'invalid' || candidateReport.status === 'valid')
              && candidateReport.issueCount < report.issueCount) {
              changes.push({
                id: `repair-remove-asset:${issue.spaceId}:${placement.id}`,
                spaceId: issue.spaceId,
                issueIds: [issue.id],
                kind: 'remove-asset',
                placementId: placement.id!,
                original: clone(placement),
                summary: `移除无法安全摆放的装饰资产 '${placement.id}'`,
              })
              current = candidate
              report = candidateReport
              accepted = true
            }
          }
        }
        if (accepted) break
      }
      if (accepted) break
    }

    if (!accepted) break
    if (report.status === 'valid') break
    await control.yieldControl()
  }

  if (report.status === 'valid') {
    const candidate = applyRawChanges(envelope.original, changes)
    if ('status' in candidate) return { status: 'blocked', changes, report }
    return { status: 'ready', candidate, changes, report }
  }
  return { status: 'blocked', changes, report }
}

export const planSceneRepair = repairSceneCompatibility
export const repairScene = repairSceneCompatibility
