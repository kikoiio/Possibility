import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client'
import { persons, provenanceRepairItems, provenanceRepairRuns, provenanceSourceLinks, timelines, worldCommands, worldFacts } from '../db/schema'
import { hydrateTimelines } from '../life/snapshot-store'
import { readForkSnapshot } from '../agent/visibility'
import type { EvidenceQuery, EvidenceRecord, EvidenceScope, EvidenceSnapshot, PersonLabel, RecordRef, SourceStatus, SourceView, TopicEvidenceGroup } from './types'
import type { ProvenanceAccess } from './scope'
import { assertEvidenceScope, ProvenanceScopeError } from './scope'
import { messageReceiptFromCommand, receiptInScope } from './receipts'

interface SourceFact {
  fact: typeof worldFacts.$inferSelect
  value: Record<string, unknown> | null
}

interface CursorPayload {
  v: 1
  principal: string
  worldId: string
  timelineId: string
  residentId: string
  simNow: string
  revisionVersion: number
  receiptId?: string
  topic?: string
  fromSimTime?: string
  offset: number
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}

function encodeCursor(payload: CursorPayload): string {
  const raw = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(raw)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const normalized = raw.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - raw.length % 4) % 4)
    const binary = atob(normalized)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<CursorPayload>
    return value && value.v === 1 && typeof value.principal === 'string' && typeof value.worldId === 'string'
      && typeof value.timelineId === 'string' && typeof value.residentId === 'string' && typeof value.simNow === 'string'
      && Number.isSafeInteger(value.revisionVersion) && Number.isSafeInteger(value.offset) && typeof value.offset === 'number' && value.offset >= 0
      ? value as CursorPayload : null
  } catch { return null }
}

function normalizeTopic(topic: string): string { return topic.trim().toLowerCase() }
function sourceStatus(values: SourceView[]): SourceStatus {
  if (values.some(value => value.status === 'missing')) return 'missing'
  if (values.some(value => value.status === 'restricted')) return 'missing'
  return 'complete'
}
function recordRef(kind: RecordRef['kind'], id: string, timelineId: string): RecordRef { return { kind, id, timelineId } }

function visibleBoundary(scope: EvidenceScope, timelineId: string, version: number, simTime: string): boolean {
  return receiptInScope(scope, timelineId, version, simTime)
}

async function personLabel(db: Db, id: string | null): Promise<PersonLabel | null> {
  if (!id) return null
  const person = await db.select({ id: persons.id, name: persons.name }).from(persons).where(eq(persons.id, id)).get()
  return person ? { personId: person.id, name: person.name } : { personId: id, name: id }
}

function cursorFor(scope: EvidenceScope, query: EvidenceQuery, offset: number): string {
  return encodeCursor({ v: 1, principal: scope.principalKey, worldId: scope.worldId, timelineId: scope.timelineId,
    residentId: scope.residentId, simNow: scope.simNow, revisionVersion: scope.revisionVersion,
    receiptId: query.receiptId, topic: query.topic ? normalizeTopic(query.topic) : undefined,
    fromSimTime: query.fromSimTime, offset })
}

function checkCursor(scope: EvidenceScope, query: EvidenceQuery, raw: string): number {
  const decoded = decodeCursor(raw)
  if (!decoded || decoded.principal !== scope.principalKey || decoded.worldId !== scope.worldId
    || decoded.timelineId !== scope.timelineId || decoded.residentId !== scope.residentId
    || decoded.simNow !== scope.simNow || decoded.revisionVersion !== scope.revisionVersion
    || decoded.receiptId !== query.receiptId || decoded.topic !== (query.topic ? normalizeTopic(query.topic) : undefined)
    || decoded.fromSimTime !== query.fromSimTime) throw new ProvenanceScopeError(409, '来源分页游标与当前上下文不匹配', 'context_changed')
  return decoded.offset
}

async function sourceRows(db: Db, scope: EvidenceScope): Promise<{ rows: SourceFact[]; sourceFacts: Map<string, SourceFact>; complete: boolean }> {
  const timelinesRows = await db.select().from(timelines).where(eq(timelines.worldId, scope.worldId)).all()
  const hydrated = await hydrateTimelines(db, timelinesRows)
  const current = hydrated.find(item => item.id === scope.timelineId)
  const rows: SourceFact[] = []
  const sourceFacts = new Map<string, SourceFact>()
  const seen = new Set<string>()
  const append = (fact: typeof worldFacts.$inferSelect) => {
    const value = parseObject(fact.valueJson)
    if (!visibleBoundary(scope, fact.timelineId, fact.version, fact.simTime)) return
    // Keep world facts in a separate index. They are eligible as assertion
    // sources, but are never returned as resident message records.
    if (fact.visibility === 'world' && ['environment', 'location', 'resident_state'].includes(fact.factType)) {
      if (value) sourceFacts.set(fact.id, { fact, value })
      return
    }
    if (seen.has(fact.id) || fact.visibility !== 'private' || fact.factType !== 'knowledge') return
    if (!value || value.recipientId !== scope.residentId || typeof value.topic !== 'string' || typeof value.content !== 'string') return
    seen.add(fact.id)
    const item = { fact, value }
    rows.push(item)
    sourceFacts.set(fact.id, item)
  }
  const own = await db.select().from(worldFacts).where(eq(worldFacts.timelineId, scope.timelineId)).all()
  own.forEach(append)

  let complete = !scope.ancestors.length
  let snapshot: ReturnType<typeof readForkSnapshot> = null
  try { snapshot = current ? readForkSnapshot(current) : null } catch { snapshot = null }
  if (snapshot?.worldFacts && snapshot.completeDomains?.includes('knowledge')) {
    snapshot.worldFacts.forEach(append)
    complete = true
  } else if (scope.ancestors.length) {
    // Legacy forks without a knowledge checkpoint cannot prove the complete
    // inherited history. Read the bounded rows that are available and surface
    // the gap instead of inferring that no message existed.
    const ids = scope.ancestors.map(item => item.timelineId)
    const inherited = ids.length ? await db.select().from(worldFacts).where(inArray(worldFacts.timelineId, ids)).all() : []
    inherited.forEach(append)
    complete = false
  }
  return {
    rows: rows.sort((a, b) => a.fact.simTime.localeCompare(b.fact.simTime)
      || a.fact.version - b.fact.version
      || a.fact.id.localeCompare(b.fact.id)),
    sourceFacts,
    complete,
  }
}

async function sourceViewsFor(
  db: Db, sourceIds: string[], byId: Map<string, SourceFact>, scope: EvidenceScope,
): Promise<{ refs: RecordRef[]; views: SourceView[]; status: SourceStatus }> {
  const refs: RecordRef[] = []
  const views: SourceView[] = []
  const visited = new Set<string>()
  let cycle = false
  let currentIds = sourceIds.filter(Boolean)
  while (currentIds.length) {
    const next: string[] = []
    for (const id of currentIds) {
      if (visited.has(id)) { cycle = true; continue }
      visited.add(id)
      const source = byId.get(id)
      if (!source || !visibleBoundary(scope, source.fact.timelineId, source.fact.version, source.fact.simTime)) {
        views.push({ status: 'missing', reason: '来源记录缺失或不在本次固定范围内' })
        continue
      }
      refs.push(recordRef(source.fact.factType === 'knowledge' ? 'knowledge_fact' : 'world_fact', source.fact.id, source.fact.timelineId))
      const value = source.value
      const content = typeof value?.content === 'string' ? value.content
        : typeof value?.value === 'string' ? value.value
          : typeof value?.condition === 'string' ? `${String(value.location ?? '世界')}的${value.condition}：${String(value.value ?? '')}`
            : source.fact.valueJson
      views.push({ status: 'visible', sourceRef: source.fact.id, label: source.fact.factType === 'knowledge' ? '传话内容来源' : '世界事实来源', content, simTime: source.fact.simTime })
      const sourceFactId = typeof value?.sourceFactId === 'string' ? value.sourceFactId : null
      if (sourceFactId) next.push(sourceFactId)
    }
    currentIds = next
  }
  return { refs, views, status: cycle ? 'conflicting' : sourceStatus(views) }
}

async function linksFor(db: Db, scope: EvidenceScope, record: typeof worldFacts.$inferSelect): Promise<{ refs: RecordRef[]; repairItemId: string | null }> {
  const links = await db.select().from(provenanceSourceLinks).where(and(
    eq(provenanceSourceLinks.worldId, scope.worldId), eq(provenanceSourceLinks.timelineId, scope.timelineId),
    eq(provenanceSourceLinks.residentId, scope.residentId), eq(provenanceSourceLinks.recordKind, 'knowledge_fact'),
    eq(provenanceSourceLinks.recordId, record.id),
  )).all()
  if (!links.length) return { refs: [], repairItemId: null }
  const repairIds = links.flatMap(link => link.repairItemId ? [link.repairItemId] : [])
  const repairItems = repairIds.length
    ? await db.select({ itemId: provenanceRepairItems.itemId, sequence: provenanceRepairItems.committedSequence })
      .from(provenanceRepairItems).where(inArray(provenanceRepairItems.itemId, repairIds)).all()
    : []
  const sequenceById = new Map(repairItems.map(item => [item.itemId, item.sequence]))
  const visibleLinks = links.filter(link => !link.repairItemId
    || (sequenceById.get(link.repairItemId) !== undefined
      && sequenceById.get(link.repairItemId)! <= scope.repairWatermark))
  const refs = visibleLinks.filter(link => link.sourceId).map(link => recordRef(
    link.sourceKind === 'knowledge_fact' ? 'knowledge_fact' : link.sourceKind === 'memory' ? 'memory' : 'world_fact',
    link.sourceId, link.sourceTimelineId,
  ))
  return { refs, repairItemId: visibleLinks.find(link => link.repairItemId)?.repairItemId ?? null }
}

/** Read bounded resident knowledge without collapsing repeated or conflicting messages. */
export async function readEvidence(db: Db, access: ProvenanceAccess, scope: EvidenceScope, query: EvidenceQuery = {}): Promise<EvidenceSnapshot> {
  await assertEvidenceScope(db, access, scope)
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 100)
  const topic = query.topic ? normalizeTopic(query.topic) : undefined
  if (query.fromSimTime && !Number.isFinite(Date.parse(query.fromSimTime))) throw new ProvenanceScopeError(400, '来源起始时间无效', 'invalid_input')
  const offset = query.cursor ? checkCursor(scope, { ...query, topic }, query.cursor) : 0
  const source = await sourceRows(db, scope)
  const allFacts = source.rows
  const commandRows = allFacts.length ? await db.select().from(worldCommands).where(inArray(worldCommands.id, allFacts.map(item => item.fact.sourceCommandId))).all() : []
  const commandById = new Map(commandRows.map(command => [command.id, command]))
  const factById = new Map(source.sourceFacts)
  const records: EvidenceRecord[] = []
  for (const item of allFacts) {
    const fact = item.fact
    const value = item.value!
    const topicText = String(value.topic)
    if (topic && normalizeTopic(topicText) !== topic) continue
    if (query.fromSimTime && Date.parse(fact.simTime) < Date.parse(query.fromSimTime)) continue
    const command = commandById.get(fact.sourceCommandId)
    const receipt = command ? await messageReceiptFromCommand(db, command, fact) : null
    if (query.receiptId && receipt?.receiptId !== query.receiptId) continue
    if (query.receiptId && !receipt) continue
    const sourceFactId = typeof value.sourceFactId === 'string' ? value.sourceFactId : ''
    const linked = await linksFor(db, scope, fact)
    const sourceChain = await sourceViewsFor(db, sourceFactId ? [sourceFactId] : linked.refs.map(ref => ref.id), factById, scope)
    const assertionStatus: SourceStatus = sourceChain.status
    const assertionRefs = sourceChain.refs.length ? sourceChain.refs : linked.refs
    records.push({
      recordRef: recordRef('knowledge_fact', fact.id, fact.timelineId),
      evidenceId: fact.id,
      topicKey: normalizeTopic(topicText),
      topic: topicText,
      content: String(value.content),
      simTime: fact.simTime,
      version: fact.version,
      originTimelineId: fact.timelineId,
      sender: receipt?.sender ?? null,
      recipientId: scope.residentId,
      reception: { state: 'established', status: command && receipt ? 'complete' : 'missing', refs: [recordRef('knowledge_fact', fact.id, fact.timelineId)] },
      assertion: { state: value.certainty === 'fact' && assertionStatus === 'complete' ? 'verified' : 'unverified', status: assertionStatus, refs: assertionRefs },
      sourceViews: sourceChain.views,
      repairItemId: linked.repairItemId,
    })
  }
  records.sort((a, b) => (a.simTime ?? '').localeCompare(b.simTime ?? '')
    || (a.version ?? 0) - (b.version ?? 0)
    || a.evidenceId.localeCompare(b.evidenceId))
  const page = records.slice(offset, offset + limit)
  const nextCursor = offset + limit < records.length ? cursorFor(scope, { ...query, topic }, offset + limit) : null
  const groupsMap = new Map<string, EvidenceRecord[]>()
  for (const record of page) groupsMap.set(record.topicKey, [...(groupsMap.get(record.topicKey) ?? []), record])
  const groups: TopicEvidenceGroup[] = [...groupsMap].map(([topicKey, group]) => {
    const uniqueContent = new Set(group.map(record => record.content))
    const hasMissing = group.some(record => record.reception.status !== 'complete'
      || record.assertion.status === 'missing' || record.assertion.status === 'conflicting')
    return { topicKey, label: group[0]?.topic ?? topicKey, evidenceIds: group.map(record => record.evidenceId),
      relation: uniqueContent.size > 1 ? 'documented_conflict' : group.length > 1 ? 'multiple_accounts' : 'single_account',
      completeness: hasMissing || !source.complete ? 'partial' : 'complete' }
  })
  const gaps: string[] = []
  if (!source.complete) gaps.push('分叉历史缺少可核验的完整来源快照')
  if (nextCursor) gaps.push('来源结果仍有后续分页，当前快照不能证明范围完整')
  const completeRead = source.complete && !nextCursor && !gaps.some(gap => gap.includes('缺少'))
  return { snapshotId: makeSnapshotId(scope, { ...query, topic }, page), schemaVersion: 1, scope,
    query: { ...query, ...(topic ? { topic } : {}) }, records: page, groups,
    completeness: completeRead ? 'complete' : 'partial', gaps, nextCursor }
}

function makeSnapshotId(scope: EvidenceScope, query: EvidenceQuery, records: EvidenceRecord[]): string {
  const material = JSON.stringify({ worldId: scope.worldId, timelineId: scope.timelineId, residentId: scope.residentId,
    simNow: scope.simNow, revisionVersion: scope.revisionVersion, repairWatermark: scope.repairWatermark,
    query, records: records.map(record => [record.evidenceId, record.topicKey, record.content, record.assertion.state, record.assertion.status]) })
  // Stable, dependency-free digest. This is an identifier, not a security
  // boundary; access is always rechecked against the scope before reading.
  let hash = 2166136261
  for (let index = 0; index < material.length; index++) hash = Math.imul(hash ^ material.charCodeAt(index), 16777619)
  return `evidence:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export const buildEvidenceSnapshot = readEvidence
