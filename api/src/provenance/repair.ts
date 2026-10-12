import { and, asc, count, eq, gt, isNull, lte, or, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  memories, provenanceRepairItems, provenanceRepairRuns, provenanceSourceLinks,
  timelines, universeRevisions, worldFacts, worldPersons,
} from '../db/schema'
import type { RecordRef, RepairCursor, RepairItem, RepairRun, RepairScope } from './types'

const RULE_VERSION = 'message-provenance/v1' as const
const DEFAULT_BATCH_SIZE = 20
const MAX_BATCH_SIZE = 50
const MAX_SOURCE_CHAIN = 64
const LEASE_MS = 30_000
const REPAIR_KINDS = ['knowledge_fact', 'memory'] as const
type RepairKind = typeof REPAIR_KINDS[number]

type StoredRun = typeof provenanceRepairRuns.$inferSelect
type Fact = typeof worldFacts.$inferSelect
type Memory = typeof memories.$inferSelect
type Source = { id: string; timelineId: string; content: string; digest: string; kind: 'world_fact' | 'memory' }

export interface StartRepairInput {
  scope: RepairScope
  batchSize?: number
}

export interface RepairItemsPageResult {
  items: RepairItem[]
  nextCursor: string | null
}

export interface RepairRunView {
  runId: string
  scope: RepairScope
  scopeHash: string
  frozenBounds: Record<string, unknown>
  status: StoredRun['status']
  cursor: RepairCursor | null
  counts: RepairRun['counts']
  batchSize: number
  lastError: string | null
  createdAt: string
  updatedAt: string
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch { return null }
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function parseRepairScope(scope: RepairScope): RepairScope {
  const kinds = [...new Set(scope.recordKinds)]
  if (!scope.worldId || !scope.timelineId || !scope.residentId) throw new Error('修复范围缺少世界、时间线或居民')
  if (scope.ruleVersion !== RULE_VERSION) throw new Error(`不支持的修复规则版本：${scope.ruleVersion}`)
  if (!kinds.length || kinds.some(kind => !REPAIR_KINDS.includes(kind as RepairKind))) throw new Error('修复范围类型无效')
  if (scope.createdFrom && scope.createdThrough && scope.createdFrom > scope.createdThrough) throw new Error('修复时间范围无效')
  return { ...scope, recordKinds: REPAIR_KINDS.filter(kind => kinds.includes(kind)) }
}

function scopeFromRow(run: StoredRun): RepairScope {
  return parseJson<RepairScope>(run.scopeJson, {
    worldId: run.worldId, timelineId: run.timelineId, residentId: run.residentId,
    recordKinds: ['knowledge_fact', 'memory'], ruleVersion: run.ruleVersion as RepairScope['ruleVersion'],
  })
}

function viewRun(run: StoredRun): RepairRunView {
  const bounds = parseJson<Record<string, unknown>>(run.frozenBoundsJson, {})
  return {
    runId: run.runId, scope: scopeFromRow(run), scopeHash: run.scopeHash, frozenBounds: bounds,
    status: run.status as StoredRun['status'], cursor: parseJson<RepairCursor | null>(run.cursorJson, null),
    counts: {
      scanned: run.scanned, linked: run.linked, alreadyValid: run.alreadyValid,
      insufficientEvidence: run.insufficientEvidence, conflictingEvidence: run.conflictingEvidence,
    }, batchSize: run.batchSize, lastError: run.lastError, createdAt: run.createdAt, updatedAt: run.updatedAt,
  }
}

export function repairRunView(run: StoredRun): RepairRunView { return viewRun(run) }

async function getRun(db: Db, runId: string): Promise<StoredRun | null> {
  return await db.select().from(provenanceRepairRuns).where(eq(provenanceRepairRuns.runId, runId)).get() ?? null
}

async function freezeBounds(db: Db, scope: RepairScope): Promise<Record<string, unknown>> {
  const [factMax, memoryMax, memoryCount, revision, timeline] = await Promise.all([
    db.select({ value: sql<number | null>`max(${worldFacts.version})` }).from(worldFacts).where(eq(worldFacts.timelineId, scope.timelineId)).get(),
    db.select({ createdAt: memories.createdAt, id: memories.id }).from(memories)
      .where(and(eq(memories.timelineId, scope.timelineId), eq(memories.personId, scope.residentId)))
      .orderBy(sql`${memories.createdAt} DESC`, sql`${memories.id} DESC`).limit(1).get(),
    db.select({ value: count() }).from(memories).where(and(eq(memories.timelineId, scope.timelineId), eq(memories.personId, scope.residentId))).get(),
    db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, scope.timelineId)).get(),
    db.select().from(timelines).where(and(eq(timelines.id, scope.timelineId), eq(timelines.worldId, scope.worldId))).get(),
  ])
  const ancestorIds = parseJson<string[]>(timeline?.ancestorIdsJson ?? null, [])
  const revisionVersion = revision?.version ?? 0
  const simNow = revision?.simTime ?? timeline?.simNow ?? new Date(0).toISOString()
  return {
    // These two fields are retained as stable numeric watermarks for callers that only
    // understand the contract shape. The extra max fields prevent later inserts from
    // entering a running batch.
    knowledgeFactRow: factMax?.value ?? 0,
    memoryRow: memoryCount?.value ?? 0,
    knowledgeFactMaxVersion: factMax?.value ?? 0,
    memoryMaxCreatedAt: memoryMax?.createdAt ?? null,
    memoryMaxId: memoryMax?.id ?? null,
    evidenceScope: {
      worldId: scope.worldId, timelineId: scope.timelineId, residentId: scope.residentId,
      simNow, revisionVersion, repairWatermark: factMax?.value ?? 0,
      principalKey: `repair:${scope.worldId}:${scope.timelineId}:${scope.residentId}`,
      permission: 'admin_repair', ancestors: ancestorIds.map(timelineId => ({
        timelineId, maxVersion: revisionVersion, maxSimTime: simNow, snapshotRef: `timeline:${timelineId}`,
      })),
    },
  }
}

async function createOrLoadRun(db: Db, input: StartRepairInput): Promise<StoredRun> {
  const scope = parseRepairScope(input.scope)
  const scopeHash = await digest(canonicalize(scope))
  const existing = await db.select().from(provenanceRepairRuns).where(eq(provenanceRepairRuns.scopeHash, scopeHash)).get()
  if (existing) return existing
  const membership = await db.select({ personId: worldPersons.personId }).from(worldPersons)
    .innerJoin(timelines, eq(timelines.worldId, worldPersons.worldId))
    .where(and(eq(worldPersons.worldId, scope.worldId), eq(worldPersons.personId, scope.residentId), eq(timelines.id, scope.timelineId))).get()
  if (!membership) throw new Error('世界、时间线或居民范围无效')
  const timeline = await db.select().from(timelines).where(and(eq(timelines.id, scope.timelineId), eq(timelines.worldId, scope.worldId))).get()
  if (!timeline) throw new Error('世界或时间线不存在')
  const frozenBounds = await freezeBounds(db, scope)
  const now = new Date().toISOString()
  const runId = crypto.randomUUID()
  const requestedBatchSize = input.batchSize ?? DEFAULT_BATCH_SIZE
  const batchSize = Number.isFinite(requestedBatchSize)
    ? Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(requestedBatchSize)))
    : DEFAULT_BATCH_SIZE
  try {
    await db.insert(provenanceRepairRuns).values({
      runId, scopeHash, worldId: scope.worldId, timelineId: scope.timelineId, residentId: scope.residentId,
      ruleVersion: scope.ruleVersion, scopeJson: JSON.stringify(scope), frozenBoundsJson: JSON.stringify(frozenBounds),
      cursorJson: null, status: 'pending', batchSize, scanned: 0, linked: 0, alreadyValid: 0,
      insufficientEvidence: 0, conflictingEvidence: 0, lastError: null, leaseToken: null, leaseGeneration: 0,
      leaseExpiresAt: null, createdAt: now, updatedAt: now,
    })
  } catch (error) {
    // A concurrent creator wins the unique scope hash race; reuse it instead of creating
    // a second batch that could attach duplicate repair links.
    const raced = await db.select().from(provenanceRepairRuns).where(eq(provenanceRepairRuns.scopeHash, scopeHash)).get()
    if (raced) return raced
    throw error
  }
  return (await getRun(db, runId))!
}

function positionAfterFact(fact: Fact, cursor: RepairCursor | null): boolean {
  if (!cursor || cursor.kind !== 'knowledge_fact' || !cursor.recordPosition) return true
  return fact.version > Number(cursor.recordPosition)
}

function positionAfterMemory(memory: Memory, cursor: RepairCursor | null): boolean {
  if (!cursor || cursor.kind !== 'memory' || !cursor.recordPosition) return true
  const [createdAt, id] = cursor.recordPosition.split('\u0000')
  return memory.createdAt > createdAt || (memory.createdAt === createdAt && memory.id > id)
}

async function sourcesForFacts(db: Db, scope: RepairScope, bounds: Record<string, unknown>): Promise<Fact[]> {
  const maxVersion = Number(bounds.knowledgeFactMaxVersion ?? bounds.knowledgeFactRow ?? 0)
  const rows = await db.select().from(worldFacts).where(and(
    eq(worldFacts.timelineId, scope.timelineId), lte(worldFacts.version, maxVersion),
  )).orderBy(asc(worldFacts.version)).all()
  return rows
}

function factContent(fact: Fact): string {
  const value = parseObject(fact.valueJson)
  if (!value) return fact.valueJson
  if (typeof value.content === 'string') return value.content
  if (typeof value.value === 'string') return value.value
  return JSON.stringify(value)
}

async function sourceDigest(source: Fact | Memory): Promise<string> {
  return digest('valueJson' in source ? source.valueJson : source.content)
}

async function existingLinks(db: Db, run: StoredRun, recordKind: RepairKind, recordId: string): Promise<typeof provenanceSourceLinks.$inferSelect[]> {
  return db.select().from(provenanceSourceLinks).where(and(
    eq(provenanceSourceLinks.worldId, run.worldId), eq(provenanceSourceLinks.timelineId, run.timelineId),
    eq(provenanceSourceLinks.residentId, run.residentId), eq(provenanceSourceLinks.recordKind, recordKind),
    eq(provenanceSourceLinks.recordId, recordId), eq(provenanceSourceLinks.ruleVersion, run.ruleVersion),
  )).all()
}

async function sourceRef(kind: 'world_fact' | 'memory', row: Fact | Memory, sourceDigestValue: string): Promise<Source> {
  return { id: row.id, timelineId: row.timelineId ?? '', content: kind === 'world_fact' ? factContent(row as Fact) : (row as Memory).content, digest: sourceDigestValue, kind }
}

async function classifyFact(db: Db, run: StoredRun, fact: Fact, allFacts: Fact[]): Promise<{ status: RepairItem['status']; sources: Source[]; reason: string }> {
  const value = parseObject(fact.valueJson)
  if (!value || value.recipientId !== run.residentId || typeof value.topic !== 'string' || typeof value.content !== 'string'
    || (value.certainty !== 'fact' && value.certainty !== 'rumor')) {
    return { status: 'insufficient_evidence', sources: [], reason: 'knowledge 记录内容或居民归属无法核实' }
  }
  const sourceIds: string[] = []
  const seen = new Set<string>()
  let sourceId = typeof value.sourceFactId === 'string' && value.sourceFactId ? value.sourceFactId : null
  let cycle = false
  while (sourceId) {
    if (sourceIds.length >= MAX_SOURCE_CHAIN) {
      return { status: 'insufficient_evidence', sources: [], reason: '来源链超过核对上限，无法确认完整关联' }
    }
    if (seen.has(sourceId)) { cycle = true; break }
    seen.add(sourceId); sourceIds.push(sourceId)
    const source = allFacts.find(row => row.id === sourceId)
    if (!source) break
    const sourceValue = parseObject(source.valueJson)
    sourceId = source.factType === 'knowledge' && typeof sourceValue?.sourceFactId === 'string' ? sourceValue.sourceFactId : null
  }
  if (cycle || (sourceIds.length && sourceIds.some(id => !allFacts.some(row => row.id === id)))) {
    return { status: 'insufficient_evidence', sources: [], reason: cycle ? '来源链存在循环' : '来源记录缺失，无法恢复关联' }
  }
  if (!sourceIds.length) {
    return value.certainty === 'rumor'
      ? { status: 'already_valid', sources: [], reason: '传闻允许没有进一步证实来源' }
      : { status: 'insufficient_evidence', sources: [], reason: '已证实消息缺少来源依据' }
  }
  const sourceRows = sourceIds.map(id => allFacts.find(row => row.id === id)!).filter(Boolean)
  if (sourceRows.some(row => row.version >= fact.version)) {
    return { status: 'insufficient_evidence', sources: [], reason: '来源发生在消息之后，不能作为历史依据' }
  }
  const sourceHasRumor = sourceRows.some(row => parseObject(row.valueJson)?.certainty === 'rumor')
  if (value.certainty === 'fact' && sourceHasRumor) {
    return { status: 'conflicting_evidence', sources: [], reason: '记录声称已证实，但来源链包含未经证实的传闻' }
  }
  const sources = await Promise.all(sourceRows.map(async row => sourceRef('world_fact', row, await sourceDigest(row))))
  const old = await existingLinks(db, run, 'knowledge_fact', fact.id)
  const originalDigest = await digest(fact.valueJson)
  const oldValid = old.length === sources.length && old.every(link => link.originalDigest === originalDigest
    && sources.some(source => source.id === link.sourceId && source.digest === link.sourceDigest))
  return { status: oldValid ? 'already_valid' : 'linked', sources, reason: oldValid ? '原来源关联仍然有效' : '已根据消息来源链恢复关联' }
}

async function classifyMemory(db: Db, run: StoredRun, memory: Memory, facts: Fact[]): Promise<{ status: RepairItem['status']; sources: Source[]; reason: string }> {
  const text = normalized(memory.content)
  if (text.length < 8) return { status: 'insufficient_evidence', sources: [], reason: '记忆内容过短，无法安全匹配来源' }
  if (!memory.simTime) return { status: 'insufficient_evidence', sources: [], reason: '记忆缺少发生时刻，无法确认来源先后' }
  const candidates: Source[] = []
  for (const fact of facts) {
    const value = parseObject(fact.valueJson)
    if (fact.factType !== 'knowledge' || fact.visibility !== 'private' || value?.recipientId !== run.residentId) continue
    if (fact.simTime > memory.simTime) continue
    const factEvidence = await classifyFact(db, run, fact, facts)
    if (factEvidence.status === 'insufficient_evidence' || factEvidence.status === 'conflicting_evidence') continue
    const content = factContent(fact)
    const candidateText = normalized(content)
    if (candidateText.length >= 8 && (text.includes(candidateText) || candidateText.includes(text))) {
      candidates.push(await sourceRef('world_fact', fact, await sourceDigest(fact)))
    }
  }
  const unique = [...new Map(candidates.map(source => [source.id, source])).values()]
  if (!unique.length) return { status: 'insufficient_evidence', sources: [], reason: '找不到可核实的居民消息来源；原记忆保留' }
  const old = await existingLinks(db, run, 'memory', memory.id)
  const originalDigest = await digest(memory.content)
  const oldValid = old.length === unique.length && old.every(link => link.originalDigest === originalDigest
    && unique.some(source => source.id === link.sourceId && source.digest === link.sourceDigest))
  const distinctAssertions = new Set(unique.map(source => normalized(source.content))).size
  if (distinctAssertions > 1) return { status: 'conflicting_evidence', sources: [], reason: '匹配到多条内容不同的消息，保留冲突供后续核实' }
  return { status: oldValid ? 'already_valid' : 'linked', sources: unique, reason: oldValid ? '原来源关联仍然有效' : '已根据居民可见消息恢复关联' }
}

async function commitItem(db: Db, run: StoredRun, kind: RepairKind, record: Fact | Memory, classification: { status: RepairItem['status']; sources: Source[]; reason: string }, sequence: number): Promise<void> {
  const recordRef: RecordRef = { kind, id: record.id, timelineId: run.timelineId }
  const original = kind === 'knowledge_fact' ? (record as Fact).valueJson : (record as Memory).content
  const originalDigest = await digest(original)
  const itemId = `repair-item:${run.runId}:${kind}:${record.id}`
  const linkIds = await Promise.all(classification.sources.map(source => digest(`${run.runId}|${kind}|${record.id}|${source.kind}|${source.id}|assertion|${run.ruleVersion}`)))
  const itemInsert = db.insert(provenanceRepairItems).values({
    itemId, runId: run.runId, recordKind: kind, recordId: record.id, originTimelineId: run.timelineId,
    originalDigest, originalExcerpt: original.slice(0, 500), status: classification.status,
    sourceRefsJson: JSON.stringify(classification.sources.map(source => ({ kind: source.kind, id: source.id, timelineId: source.timelineId }))),
    linkIdsJson: JSON.stringify(linkIds), reason: classification.reason, committedSequence: sequence,
    createdAt: new Date().toISOString(),
  }).onConflictDoNothing()
  const links = []
  for (let index = 0; index < classification.sources.length; index++) {
    const source = classification.sources[index]!
    links.push(db.insert(provenanceSourceLinks).values({
      linkId: linkIds[index]!, worldId: run.worldId, timelineId: run.timelineId, residentId: run.residentId,
      recordKind: kind, recordId: record.id, sourceKind: source.kind, sourceId: source.id,
      sourceTimelineId: source.timelineId, relation: kind === 'memory' ? 'memory_support' : 'assertion',
      ruleVersion: run.ruleVersion, originalDigest, sourceDigest: source.digest, repairItemId: itemId,
      createdAt: new Date().toISOString(),
    }).onConflictDoNothing())
  }
  await db.batch([itemInsert, ...links])
}

async function itemCounts(db: Db, runId: string): Promise<RepairRun['counts']> {
  const rows = await db.select({ status: provenanceRepairItems.status, value: count() })
    .from(provenanceRepairItems).where(eq(provenanceRepairItems.runId, runId)).groupBy(provenanceRepairItems.status).all()
  const get = (status: RepairItem['status']) => rows.find(row => row.status === status)?.value ?? 0
  return {
    scanned: rows.reduce((total, row) => total + row.value, 0),
    linked: get('linked'), alreadyValid: get('already_valid'),
    insufficientEvidence: get('insufficient_evidence'), conflictingEvidence: get('conflicting_evidence'),
  }
}

async function claimLease(db: Db, run: StoredRun): Promise<{ run: StoredRun; token: string } | null> {
  const now = new Date()
  const nowIso = now.toISOString()
  if (run.status === 'completed') return { run, token: '' }
  if (run.leaseExpiresAt && run.leaseExpiresAt > nowIso) return null
  const token = crypto.randomUUID()
  const expires = new Date(now.getTime() + LEASE_MS).toISOString()
  const claimed = await db.update(provenanceRepairRuns).set({
    status: 'running', leaseToken: token, leaseGeneration: sql`${provenanceRepairRuns.leaseGeneration} + 1`,
    leaseExpiresAt: expires, updatedAt: nowIso,
  }).where(and(eq(provenanceRepairRuns.runId, run.runId), or(isNull(provenanceRepairRuns.leaseExpiresAt), lte(provenanceRepairRuns.leaseExpiresAt, nowIso)))).run()
  if (!claimed.success || claimed.meta.changes !== 1) return null
  const fresh = await getRun(db, run.runId)
  return fresh ? { run: fresh, token } : null
}

async function selectBatch(db: Db, run: StoredRun): Promise<{ kind: RepairKind; rows: Array<Fact | Memory>; nextKind: RepairKind | null }> {
  const scope = scopeFromRow(run)
  const bounds = parseJson<Record<string, unknown>>(run.frozenBoundsJson, {})
  const cursor = parseJson<RepairCursor | null>(run.cursorJson, null)
  const currentIndex = cursor ? Math.max(0, scope.recordKinds.indexOf(cursor.kind as RepairKind)) : 0
  for (let kindIndex = currentIndex; kindIndex < scope.recordKinds.length; kindIndex++) {
    const kind = scope.recordKinds[kindIndex]!
    if (kind === 'knowledge_fact') {
      const maxVersion = Number(bounds.knowledgeFactMaxVersion ?? bounds.knowledgeFactRow ?? 0)
      const rows = await db.select().from(worldFacts).where(and(
        eq(worldFacts.timelineId, scope.timelineId), eq(worldFacts.factType, 'knowledge'), lte(worldFacts.version, maxVersion),
        ...(scope.createdFrom ? [sql`${worldFacts.simTime} >= ${scope.createdFrom}`] : []),
        ...(scope.createdThrough ? [sql`${worldFacts.simTime} <= ${scope.createdThrough}`] : []),
      )).orderBy(asc(worldFacts.version)).all()
      const pending = rows.filter(row => positionAfterFact(row, cursor)).slice(0, run.batchSize)
      if (pending.length) return { kind, rows: pending, nextKind: kindIndex + 1 < scope.recordKinds.length ? scope.recordKinds[kindIndex + 1]! : null }
    } else {
      const maxCreatedAt = typeof bounds.memoryMaxCreatedAt === 'string' ? bounds.memoryMaxCreatedAt : null
      const maxId = typeof bounds.memoryMaxId === 'string' ? bounds.memoryMaxId : null
      const rows = await db.select().from(memories).where(and(
        eq(memories.timelineId, scope.timelineId), eq(memories.personId, scope.residentId),
        ...(maxCreatedAt ? [or(sql`${memories.createdAt} < ${maxCreatedAt}`, and(eq(memories.createdAt, maxCreatedAt), lte(memories.id, maxId ?? '')))] : []),
        ...(scope.createdFrom ? [sql`${memories.createdAt} >= ${scope.createdFrom}`] : []),
        ...(scope.createdThrough ? [sql`${memories.createdAt} <= ${scope.createdThrough}`] : []),
      )).orderBy(asc(memories.createdAt), asc(memories.id)).all()
      const pending = rows.filter(row => positionAfterMemory(row, cursor)).slice(0, run.batchSize)
      if (pending.length) return { kind, rows: pending, nextKind: kindIndex + 1 < scope.recordKinds.length ? scope.recordKinds[kindIndex + 1]! : null }
    }
    cursor && (cursor.recordPosition = null)
  }
  return { kind: scope.recordKinds[scope.recordKinds.length - 1]!, rows: [], nextKind: null }
}

/** Start or continue one bounded repair batch. Existing source records are never changed. */
export async function repairProvenance(db: Db, input: StartRepairInput): Promise<RepairRunView> {
  let run = await createOrLoadRun(db, input)
  if (run.status === 'completed') return viewRun(run)
  const lease = await claimLease(db, run)
  if (!lease) return viewRun(run)
  run = lease.run
  const token = lease.token
  try {
    const scope = scopeFromRow(run)
    const batch = await selectBatch(db, run)
    const allFacts = await sourcesForFacts(db, scope, parseJson<Record<string, unknown>>(run.frozenBoundsJson, {}))
    const sequenceRow = await db.select({ value: sql<number | null>`max(${provenanceRepairItems.committedSequence})` })
      .from(provenanceRepairItems).where(eq(provenanceRepairItems.runId, run.runId)).get()
    let sequence = sequenceRow?.value ?? run.scanned
    let cursor: RepairCursor | null = parseJson<RepairCursor | null>(run.cursorJson, null)
    for (const row of batch.rows) {
      const kind = batch.kind
      const classification = kind === 'knowledge_fact'
        ? await classifyFact(db, run, row as Fact, allFacts)
        : await classifyMemory(db, run, row as Memory, allFacts)
      sequence++
      await commitItem(db, run, kind, row, classification, sequence)
      cursor = kind === 'knowledge_fact'
        ? { kind, recordPosition: String((row as Fact).version), sourcePosition: null }
        : { kind, recordPosition: `${(row as Memory).createdAt}\u0000${(row as Memory).id}`, sourcePosition: null }
    }
    const hasBatch = batch.rows.length > 0
    const nextCursor = hasBatch
      ? cursor
      : (batch.nextKind ? { kind: batch.nextKind, recordPosition: null, sourcePosition: null } : null)
    const done = !hasBatch && !batch.nextKind
    const counts = await itemCounts(db, run.runId)
    const now = new Date().toISOString()
    const updated = await db.update(provenanceRepairRuns).set({
      status: done ? 'completed' : 'running', cursorJson: nextCursor ? JSON.stringify(nextCursor) : null,
      scanned: counts.scanned, linked: counts.linked, alreadyValid: counts.alreadyValid,
      insufficientEvidence: counts.insufficientEvidence, conflictingEvidence: counts.conflictingEvidence,
      lastError: null, leaseToken: done ? null : token, leaseExpiresAt: done ? null : new Date(Date.now() + LEASE_MS).toISOString(), updatedAt: now,
    }).where(and(eq(provenanceRepairRuns.runId, run.runId), eq(provenanceRepairRuns.leaseToken, token))).run()
    if (!updated.success || updated.meta.changes !== 1) return viewRun((await getRun(db, run.runId))!)
    return viewRun((await getRun(db, run.runId))!)
  } catch (error) {
    const now = new Date().toISOString()
    await db.update(provenanceRepairRuns).set({ status: 'failed', lastError: error instanceof Error ? error.message : String(error), leaseToken: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(provenanceRepairRuns.runId, run.runId), eq(provenanceRepairRuns.leaseToken, token))).run()
    return viewRun((await getRun(db, run.runId))!)
  }
}

export async function getProvenanceRepairRun(db: Db, runId: string): Promise<RepairRunView | null> {
  const run = await getRun(db, runId)
  return run ? viewRun(run) : null
}

/** Continue an existing run by id; unlike start, this never creates a new scope. */
export async function continueProvenanceRepair(db: Db, runId: string, batchSize?: number): Promise<RepairRunView> {
  const run = await getRun(db, runId)
  if (!run) throw new Error('来源修复任务不存在')
  return repairProvenance(db, { scope: scopeFromRow(run), batchSize: batchSize ?? run.batchSize })
}

export async function listProvenanceRepairItems(db: Db, runId: string, input: { cursor?: string; limit?: number } = {}): Promise<RepairItemsPageResult> {
  const requestedLimit = input.limit ?? 50
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(50, Math.floor(requestedLimit))) : 50
  const cursor = input.cursor && /^\d+$/.test(input.cursor) ? Number(input.cursor) : 0
  const rows = await db.select().from(provenanceRepairItems).where(and(
    eq(provenanceRepairItems.runId, runId), gt(provenanceRepairItems.committedSequence, cursor),
  )).orderBy(asc(provenanceRepairItems.committedSequence)).limit(limit + 1).all()
  const page = rows.slice(0, limit)
  return {
    items: page.map(row => ({
      itemId: row.itemId, runId: row.runId,
      record: { kind: row.recordKind as RepairItem['record']['kind'], id: row.recordId, timelineId: row.originTimelineId },
      status: row.status as RepairItem['status'], sourceRefs: parseJson<RepairItem['sourceRefs']>(row.sourceRefsJson, []),
      linkIds: parseJson<string[]>(row.linkIdsJson, []), reason: row.reason, originalDigest: row.originalDigest,
      originalExcerpt: row.originalExcerpt, committedSequence: row.committedSequence,
    })),
    nextCursor: rows.length > limit ? String(page[page.length - 1]?.committedSequence ?? cursor) : null,
  }
}

export { RULE_VERSION as provenanceRepairRuleVersion }
