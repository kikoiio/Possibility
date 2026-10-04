import type { worldFacts } from '../db/schema'

type Fact = typeof worldFacts.$inferSelect

export interface KnowledgeAssertion {
  recipientId: string
  topic: string
  content: string
  certainty: 'fact' | 'rumor'
  sourceFactId: string | null
}

export type KnowledgeValidation =
  | { ok: true; certainty: 'fact' | 'rumor'; sourceChain: string[] }
  | { ok: false; reasonCode: 'source_missing' | 'source_cycle' | 'source_future' | 'source_timeline_forbidden'
      | 'source_visibility_forbidden' | 'source_payload_invalid' | 'certainty_upgrade' }

export interface KnowledgeValidationOptions {
  currentVersion?: number
  currentTimelineId?: string
  allowedTimelineIds?: ReadonlySet<string>
}

export interface VisibleKnowledgeFact {
  kind: 'environment' | 'knowledge'
  text: string
  sourceFactId: string
  certainty: 'fact' | 'rumor'
  timelineId?: string
  simTime?: string
  version?: number
  recipientPersonId?: string
}

export interface KnowledgeFactView {
  id: string
  factType: string
  visibility: string
  value: unknown
  timelineId?: string
  simTime?: string
  version?: number
}

/** One visibility rule for chat, scene, NPC dialogue, engine decisions and summaries. */
export function visibleKnowledgeForPerson(
  facts: KnowledgeFactView[],
  personId: string,
): VisibleKnowledgeFact[] {
  const visible: VisibleKnowledgeFact[] = []
  for (const fact of facts) {
    if (!fact.value || typeof fact.value !== 'object' || Array.isArray(fact.value)) continue
    const value = fact.value as Record<string, unknown>
    if (fact.factType === 'environment' && fact.visibility === 'world') {
      if (typeof value.condition !== 'string' || typeof value.value !== 'string') continue
      visible.push({ kind: 'environment', text: `${String(value.location ?? '全世界')}的${value.condition}：${value.value}`,
        sourceFactId: fact.id, certainty: 'fact', timelineId: fact.timelineId, simTime: fact.simTime, version: fact.version })
    } else if (fact.factType === 'knowledge' && fact.visibility === 'private' && value.recipientId === personId
      && typeof value.topic === 'string' && typeof value.content === 'string'
      && (value.certainty === 'fact' || value.certainty === 'rumor')) {
      visible.push({ kind: 'knowledge', text: `${value.topic}：${value.content}`, sourceFactId: fact.id,
        certainty: value.certainty, timelineId: fact.timelineId, simTime: fact.simTime,
        version: fact.version, recipientPersonId: personId })
    }
  }
  return visible
}

function parseValue(fact: Fact): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fact.valueJson) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}

/** Validate a complete visible provenance chain; rumor certainty can never be promoted by relaying it. */
export function validateKnowledgeChain(
  assertion: KnowledgeAssertion,
  visibleSourceFacts: Fact[],
  options: KnowledgeValidationOptions = {},
): KnowledgeValidation {
  if (!assertion.sourceFactId) {
    return assertion.certainty === 'rumor'
      ? { ok: true, certainty: 'rumor', sourceChain: [] }
      : { ok: false, reasonCode: 'certainty_upgrade' }
  }
  const byId = new Map(visibleSourceFacts.map(fact => [fact.id, fact]))
  const visited = new Set<string>()
  const sourceChain: string[] = []
  let sourceId: string | null = assertion.sourceFactId
  let expected: 'fact' | 'rumor' = 'fact'
  while (sourceId) {
    if (visited.has(sourceId)) return { ok: false, reasonCode: 'source_cycle' }
    visited.add(sourceId)
    sourceChain.push(sourceId)
    const source = byId.get(sourceId)
    if (!source) return { ok: false, reasonCode: 'source_missing' }
    if (options.allowedTimelineIds && !options.allowedTimelineIds.has(source.timelineId)) {
      return { ok: false, reasonCode: 'source_timeline_forbidden' }
    }
    if (options.currentVersion !== undefined && source.timelineId === options.currentTimelineId
      && source.version >= options.currentVersion) {
      return { ok: false, reasonCode: 'source_future' }
    }
    const value = parseValue(source)
    if (!value) return { ok: false, reasonCode: 'source_payload_invalid' }
    if (source.factType === 'knowledge') {
      if (source.visibility !== 'private' || typeof value.recipientId !== 'string'
        || typeof value.topic !== 'string' || typeof value.content !== 'string'
        || (value.certainty !== 'fact' && value.certainty !== 'rumor')) {
        return { ok: false, reasonCode: 'source_payload_invalid' }
      }
      if (value.certainty === 'rumor') expected = 'rumor'
      sourceId = typeof value.sourceFactId === 'string' && value.sourceFactId ? value.sourceFactId : null
      continue
    }
    if (source.visibility !== 'world' || !['environment', 'location', 'resident_state'].includes(source.factType)) {
      return { ok: false, reasonCode: 'source_visibility_forbidden' }
    }
    sourceId = null
  }
  if (assertion.certainty !== expected) return { ok: false, reasonCode: 'certainty_upgrade' }
  return { ok: true, certainty: expected, sourceChain }
}
