import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  decodeSceneCompatibility,
  repairSceneCompatibility,
  sceneBudget,
  validateSceneEnvelope,
} from '@possibility/voxel-contract'
import { libraryManifest } from '../voxel/library-manifest'

describe('A1 original Mist Manor sample diagnostics', () => {
  it('reports source overlaps and classifies the original hall bookshelf cavity', async () => {
    const rawText = readFileSync('src/demo/mist-manor-voxel-spaces.json', { encoding: 'utf8' })
    expect(createHash('sha256').update(rawText).digest('hex')).toBe('c9ebfbe70e0a5ef6ec0b421cd68e72a5b3c46cf86f5164f3515248a5d1cf6d20')
    const rawBundle: unknown = JSON.parse(rawText)
    const decoded = decodeSceneCompatibility(rawBundle)
    expect(decoded.status).toBe('ready')
    if (decoded.status !== 'ready') return
    const assets = libraryManifest()
    expect(assets).not.toBeNull()
    if (!assets) return
    const context = {
      rulesVersion: 'a1-original-sample',
      assets,
      assetManifestHash: 'sample-assets',
      templateCatalogHash: 'sample-templates',
      bindingHash: 'sample-bindings',
      contextFingerprint: 'sample-context',
      bindings: { personIds: [], locations: [], protectedObjects: [], protectedPlacements: [], locationBindings: [], personBindings: [], entries: [] },
    }
    const originalStructure = decoded.envelope.spaces.map(({ spaceId, document }) => ({
      spaceId,
      sections: structuredClone(document.sections),
      objects: structuredClone(document.objects),
      objectCells: structuredClone(document.objectCells),
      lockedObjectIds: structuredClone(document.lockedObjectIds),
      buildingPlacements: structuredClone((document.assetPlacements ?? []).filter(
        placement => assets.assets[placement.assetId]?.category === 'building',
      )),
    }))
    const workControl = {
      signal: new AbortController().signal,
      nowMs: () => performance.now(),
      yieldControl: async () => {},
    }
    const report = await validateSceneEnvelope(decoded.envelope, context, sceneBudget(), workControl)
    expect(report.status).toBe('invalid')
    expect(report.stopReason).toBeNull()
    expect(report.countIsExact).toBe(true)
    expect(report.checkedSpaceIds).toEqual(['exterior', 'main-house-interior'])
    const overlaps = report.issues.filter(issue => issue.code === 'asset-overlap' && issue.spaceId === 'exterior')
    expect(overlaps).toHaveLength(7)
    expect(overlaps.map(({ placementId, objectId, at }) => ({ placementId, objectId, at }))).toEqual([
      { placementId: 'legacy-placement-19-3780a218', objectId: 'manor-main-house-1', at: { x: 31, y: 4, z: 8 } },
      { placementId: 'legacy-placement-22-74a078cc', objectId: 'manor-main-house-1', at: { x: 30, y: 4, z: 9 } },
      { placementId: 'legacy-placement-24-6c8004c1', objectId: 'manor-main-house-1', at: { x: 26, y: 4, z: 10 } },
      { placementId: 'legacy-placement-30-7735dba6', objectId: 'greenhouse-1', at: { x: 40, y: 4, z: 16 } },
      { placementId: 'legacy-placement-42-d7560fdb', objectId: 'fence-1', at: { x: 6, y: 4, z: 26 } },
      { placementId: 'legacy-placement-59-90b0bc27', objectId: 'gatehouse-1', at: { x: 12, y: 4, z: 38 } },
      { placementId: 'legacy-placement-61-db950121', objectId: 'gatehouse-1', at: { x: 10, y: 4, z: 41 } },
    ])
    expect(report.issues).not.toContainEqual(expect.objectContaining({
      code: 'walk-clearance', spaceId: 'main-house-interior', at: { x: 15, y: 2, z: 12 },
    }))
    expect(report.ruleNotes.items).toContainEqual(expect.objectContaining({
      code: 'furniture-cavity', spaceId: 'main-house-interior', objectId: 'hall-bookshelf', at: { x: 15, y: 2, z: 12 },
    }))
    expect(report.workUnitsUsed).toBeGreaterThan(0)
    expect(report.workspaceBytesUsed).toBeGreaterThan(0)

    const budget = sceneBudget()
    const cpuStart = process.cpuUsage()
    const wallStart = performance.now()
    let peakRss = process.memoryUsage().rss
    const sampleRss = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 20)
    let repair: Awaited<ReturnType<typeof repairSceneCompatibility>> | undefined
    try {
      repair = await repairSceneCompatibility(decoded.envelope, context, budget, workControl)
    } finally {
      clearInterval(sampleRss)
    }
    const repairWallMs = performance.now() - wallStart
    const repairCpu = process.cpuUsage(cpuStart)
    console.info('A14.3 original sample repair outcome', JSON.stringify({
      status: repair?.status,
      reportStatus: repair?.report.status,
      stopReason: repair?.report.stopReason,
      issueCount: repair?.report.issueCount,
      issues: repair?.report.issues.map(issue => ({ code: issue.code, spaceId: issue.spaceId, placementId: issue.placementId, objectId: issue.objectId, reason: issue.reason, at: issue.at })),
      collisionPlacements: decoded.envelope.spaces.find(space => space.spaceId === 'exterior')?.document.assetPlacements
        ?.filter(placement => repair?.report.issues.some(issue => issue.placementId === placement.id))
        .map(placement => ({ id: placement.id, assetId: placement.assetId, category: assets.assets[placement.assetId]?.category, anchor: placement.anchor })),
      changes: repair?.changes,
      workUnits: repair?.report.workUnitsUsed,
      wallMs: Math.round(repairWallMs),
    }))
    expect(repair?.status).toBe('ready')
    if (!repair || repair.status !== 'ready') return
    expect(repair.report.status).toBe('valid')
    expect(repair.changes.filter(change => change.kind === 'assign-placement-id')).toHaveLength(70)
    const semanticRepairs = repair.changes.filter(change => change.kind !== 'assign-placement-id')
    expect(semanticRepairs.length).toBeGreaterThan(0)
    expect(semanticRepairs.every(change => change.kind === 'move-asset' || change.kind === 'remove-asset')).toBe(true)
    expect(semanticRepairs.length).toBeLessThanOrEqual(budget.maxRepairChanges ?? 64)
    expect(repair.report.workUnitsUsed).toBeLessThanOrEqual(budget.maxRepairWorkUnits ?? 48_000_000)
    expect(repair.report.workspaceBytesUsed).toBeLessThanOrEqual(budget.maxWorkspaceBytes)
    expect(repairWallMs).toBeLessThan(budget.maxDraftWallMs ?? 10_000)
    expect(repair.candidate).toMatchObject({ format: 'voxel-spaces', version: 1 })
    const repaired = decodeSceneCompatibility(repair.candidate)
    expect(repaired.status).toBe('ready')
    if (repaired.status !== 'ready') return
    for (const before of originalStructure) {
      const after = repaired.envelope.spaces.find(space => space.spaceId === before.spaceId)?.document
      expect(after).toBeTruthy()
      expect(after?.sections).toEqual(before.sections)
      expect(after?.objects).toEqual(before.objects)
      expect(after?.objectCells).toEqual(before.objectCells)
      expect(after?.lockedObjectIds).toEqual(before.lockedObjectIds)
      expect((after?.assetPlacements ?? []).filter(placement => assets.assets[placement.assetId]?.category === 'building'))
        .toEqual(before.buildingPlacements)
    }
    const resourceEvidence = {
      wallMs: Math.round(repairWallMs),
      workUnits: repair.report.workUnitsUsed,
      workspaceBytesPeak: repair.report.workspaceBytesUsed,
      visitedCells: repair.report.visitedCellsUsed,
      cpuUserMs: Math.round(repairCpu.user / 1000),
      cpuSystemMs: Math.round(repairCpu.system / 1000),
      sampledPeakRssBytes: peakRss,
      stablePlacementIds: repair.changes.filter(change => change.kind === 'assign-placement-id').length,
      semanticRepairChanges: semanticRepairs.length,
    }
    // Vitest suppresses console output for passing cases; allow explicit evidence capture.
    const evidencePath = process.env.A1_RESOURCE_EVIDENCE_PATH
    if (evidencePath) writeFileSync(evidencePath, `${JSON.stringify(resourceEvidence, null, 2)}\n`)
  }, 15_000)
})
