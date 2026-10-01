import type { Db } from './client'
import { timelines } from './schema'
import { assessAndUpgradeUniverse } from '../world-state/classification'

export interface MigrateUniverseEvidenceResult {
  assessed: number
  complete: number
  upgraded: number
  incomplete: number
}

/** Idempotently classify every timeline and apply only uniquely provable upgrades. */
export async function migrateUniverseEvidence(db: Db, assessedAt = new Date().toISOString()): Promise<MigrateUniverseEvidenceResult> {
  const result: MigrateUniverseEvidenceResult = { assessed: 0, complete: 0, upgraded: 0, incomplete: 0 }
  const rows = await db.select({ id: timelines.id, worldId: timelines.worldId }).from(timelines).all()
  for (const timeline of rows) {
    const assessed = await assessAndUpgradeUniverse(db, timeline.worldId, timeline.id, assessedAt)
    result.assessed++
    if (assessed.after.level === 'complete') result.complete++
    if (assessed.plan) result.upgraded++
    if (assessed.after.level === 'incomplete') result.incomplete++
  }
  return result
}
