import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { universeEvidence } from '../db/schema'

export type UniverseEvidenceLevel = 'unassessed' | 'complete' | 'upgradeable' | 'incomplete'

export interface PublicUniverseEvidence {
  level: UniverseEvidenceLevel
  reasonCodes: string[]
}

/** Expose bounded machine codes only; never leak internal diagnostic prose. */
export function publicUniverseEvidence(
  row: typeof universeEvidence.$inferSelect | null | undefined,
): PublicUniverseEvidence {
  if (!row) return { level: 'unassessed', reasonCodes: ['evidence_unassessed'] }
  const level = ['unassessed', 'complete', 'upgradeable', 'incomplete'].includes(row.level)
    ? row.level as UniverseEvidenceLevel : 'unassessed'
  let parsed: unknown = []
  try { parsed = JSON.parse(row.reasonCodesJson) } catch { /* sanitized below */ }
  const reasonCodes = Array.isArray(parsed) ? [...new Set(parsed.filter((value): value is string =>
    typeof value === 'string' && /^[a-z0-9_:-]{1,100}$/.test(value)))].slice(0, 20) : []
  if (level === 'unassessed' && !reasonCodes.length) reasonCodes.push('evidence_unassessed')
  if (level !== row.level || !Array.isArray(parsed)) reasonCodes.push('evidence_record_invalid')
  return { level, reasonCodes: [...new Set(reasonCodes)].sort() }
}

export async function readPublicUniverseEvidence(db: Db, timelineId: string): Promise<PublicUniverseEvidence> {
  const row = await db.select().from(universeEvidence).where(eq(universeEvidence.timelineId, timelineId)).get()
  return publicUniverseEvidence(row)
}
