import { and, asc, count, desc, eq, gt, lte, or, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { dialogues, dialogueTurns, events, memories, residentMemoryRepairItems, residentMemoryRepairRuns,
  residentMemorySafety, timelines, worldFacts } from '../db/schema'

type Run = typeof residentMemoryRepairRuns.$inferSelect
type Source = { id: string; content: string; simTime: string; kind: string }

function normalized(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function readableFact(row: typeof worldFacts.$inferSelect, personId: string): string | null {
  try {
    const value = JSON.parse(row.valueJson) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (row.factType === 'environment' && row.visibility === 'world'
      && typeof value.condition === 'string' && typeof value.value === 'string') {
      return `${String(value.location ?? '全世界')}的${value.condition}：${value.value}`
    }
    if (row.factType === 'knowledge' && row.visibility === 'private' && value.recipientId === personId
      && typeof value.topic === 'string' && typeof value.content === 'string'
      && (value.certainty === 'fact' || value.certainty === 'rumor')) {
      const certainty = value.certainty === 'fact' ? '已证实' : '传闻'
      return `[${certainty}] ${value.topic}：${value.content}`
    }
    return null
  } catch { return null }
}

async function residentSources(db: Db, timelineId: string, personId: string): Promise<Source[]> {
  const facts = await db.select().from(worldFacts).where(eq(worldFacts.timelineId, timelineId))
    .orderBy(desc(worldFacts.version)).limit(500).all()
  const sources: Source[] = facts.flatMap(row => {
    const content = readableFact(row, personId)
    return content ? [{ id: row.id, content, simTime: row.simTime, kind: 'fact' }] : []
  })
  const ownEvents = await db.select().from(events).where(and(eq(events.timelineId, timelineId), eq(events.actorPersonId, personId)))
    .orderBy(desc(events.simTime)).limit(500).all()
  for (const event of ownEvents) {
    sources.push({ id: event.id, content: `${event.title}：${event.description}`, simTime: event.simTime, kind: 'action' })
  }
  const attended = await db.select().from(dialogues).where(and(
    eq(dialogues.timelineId, timelineId),
    sql`EXISTS (SELECT 1 FROM json_each(${dialogues.participantIdsJson}) AS participant WHERE participant.value = ${personId})`,
  )).orderBy(desc(dialogues.simStart)).limit(200).all()
  if (attended.length) {
    const turns = await db.select().from(dialogueTurns)
      .where(or(...attended.map(dialogue => eq(dialogueTurns.dialogueId, dialogue.id))))
      .orderBy(desc(dialogueTurns.simTime), desc(dialogueTurns.turnIndex)).limit(1600).all()
    turns.reverse()
    for (const turn of turns) sources.push({ id: turn.id, content: `${turn.personId}说过：「${turn.utterance}」`,
      simTime: turn.simTime, kind: 'utterance' })
  }
  return sources
}

async function getOrCreateRun(db: Db, input: { worldId: string; timelineId: string; personId: string; batchSize: number }): Promise<Run> {
  let run = await db.select().from(residentMemoryRepairRuns).where(and(
    eq(residentMemoryRepairRuns.worldId, input.worldId), eq(residentMemoryRepairRuns.timelineId, input.timelineId),
    eq(residentMemoryRepairRuns.personId, input.personId),
  )).get()
  if (run) return run
  const now = new Date().toISOString()
  await db.insert(residentMemoryRepairRuns).values({
    id: crypto.randomUUID(), worldId: input.worldId, timelineId: input.timelineId, personId: input.personId,
    status: 'pending', batchSize: input.batchSize, scanned: 0, rebuilt: 0, unreconstructable: 0,
    cursorCreatedAt: null, cursorMemoryId: null, lastError: null, createdAt: now, updatedAt: now,
  }).onConflictDoNothing()
  run = await db.select().from(residentMemoryRepairRuns).where(and(
    eq(residentMemoryRepairRuns.worldId, input.worldId), eq(residentMemoryRepairRuns.timelineId, input.timelineId),
    eq(residentMemoryRepairRuns.personId, input.personId),
  )).get()
  if (!run) throw new Error('无法创建居民记忆重建批次')
  return run
}

/** Bounded and resumable deterministic reconstruction from exact resident-visible source excerpts. */
export async function repairResidentTimelineMemories(
  db: Db,
  input: { worldId: string; timelineId: string; personId: string; batchSize: number },
): Promise<Run> {
  const batchSize = Math.max(1, Math.min(50, Math.floor(input.batchSize)))
  const run = await getOrCreateRun(db, { ...input, batchSize })
  if (run.status === 'completed') return run
  const [timeline, safety] = await Promise.all([
    db.select().from(timelines).where(and(eq(timelines.id, input.timelineId), eq(timelines.worldId, input.worldId))).get(),
    db.select().from(residentMemorySafety).where(eq(residentMemorySafety.timelineId, input.timelineId)).get(),
  ])
  if (!timeline || !timeline.parentTimelineId || !safety) {
    const now = new Date().toISOString()
    await db.update(residentMemoryRepairRuns).set({ status: 'failed', lastError: '该时间线没有可重建的分叉记忆水位', updatedAt: now })
      .where(eq(residentMemoryRepairRuns.id, run.id))
    return (await db.select().from(residentMemoryRepairRuns).where(eq(residentMemoryRepairRuns.id, run.id)).get())!
  }

  const cursorCondition = run.cursorCreatedAt && run.cursorMemoryId
    ? or(gt(memories.createdAt, run.cursorCreatedAt), and(eq(memories.createdAt, run.cursorCreatedAt), gt(memories.id, run.cursorMemoryId)))
    : undefined
  const conditions = [eq(memories.personId, input.personId), eq(memories.timelineId, input.timelineId),
    lte(memories.createdAt, safety.safeAfterCreatedAt)]
  if (cursorCondition) conditions.push(cursorCondition)
  const batch = await db.select().from(memories).where(and(...conditions))
    .orderBy(asc(memories.createdAt), asc(memories.id)).limit(batchSize).all()
  const sources = await residentSources(db, input.timelineId, input.personId)
  const now = new Date().toISOString()
  for (const memory of batch) {
    const existing = await db.select().from(residentMemoryRepairItems).where(and(
      eq(residentMemoryRepairItems.runId, run.id), eq(residentMemoryRepairItems.sourceMemoryId, memory.id),
    )).get()
    if (existing) continue
    const text = normalized(memory.content)
    const matched = sources.filter(source => {
      const excerpt = normalized(source.content)
      return excerpt.length >= 12 && text.includes(excerpt)
    })
    const replacementId = matched.length ? `resident-rebuilt:${memory.id}` : null
    if (matched.length && replacementId) {
      await db.insert(memories).values({
        id: replacementId, personId: input.personId, timelineId: input.timelineId, type: 'source',
        content: matched.map(source => source.content).join('\n'), simTime: matched[matched.length - 1]!.simTime,
        createdAt: now, importance: memory.importance, summarized: false, mentionedPersonIdsJson: null,
        locationName: null, topicsJson: null, level: null, createdVersion: null,
      }).onConflictDoNothing()
    }
    const status = matched.length ? 'rebuilt' : 'unreconstructable'
    await db.insert(residentMemoryRepairItems).values({
      id: `repair-item:${run.id}:${memory.id}`, runId: run.id, sourceMemoryId: memory.id, status,
      replacementMemoryId: replacementId, sourceIdsJson: JSON.stringify(matched.map(source => source.id)),
      reason: matched.length ? null : '找不到可逐字核实的居民可见来源；原记录继续隔离', createdAt: now,
    }).onConflictDoNothing()
  }
  const itemCounts = await db.select({ status: residentMemoryRepairItems.status, count: count() })
    .from(residentMemoryRepairItems).where(eq(residentMemoryRepairItems.runId, run.id)).groupBy(residentMemoryRepairItems.status).all()
  const rebuilt = itemCounts.find(row => row.status === 'rebuilt')?.count ?? 0
  const unreconstructable = itemCounts.find(row => row.status === 'unreconstructable')?.count ?? 0
  const last = batch[batch.length - 1]
  const hasMore = batch.length === batchSize
  await db.update(residentMemoryRepairRuns).set({
    status: hasMore ? 'running' : 'completed',
    cursorCreatedAt: last?.createdAt ?? run.cursorCreatedAt,
    cursorMemoryId: last?.id ?? run.cursorMemoryId,
    scanned: rebuilt + unreconstructable,
    rebuilt,
    unreconstructable,
    lastError: null, updatedAt: now,
  }).where(eq(residentMemoryRepairRuns.id, run.id))
  return (await db.select().from(residentMemoryRepairRuns).where(eq(residentMemoryRepairRuns.id, run.id)).get())!
}
