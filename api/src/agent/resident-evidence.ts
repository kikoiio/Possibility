import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { dialogues, dialogueTurns, timelines } from '../db/schema'
import { readForkSnapshot } from './visibility'
import { hydrateTimelines } from '../life/snapshot-store'
import type { VisibleKnowledgeFact } from './knowledge'

export interface ResidentEvidence {
  sourceId: string
  sourceIds: string[]
  timelineId: string
  simTime: string
  version: number | null
  recipientPersonId: string | null
  certainty: 'fact' | 'rumor' | 'inferred'
  kind: 'world_fact' | 'private_knowledge' | 'utterance'
  content: string
}

type Dialogue = typeof dialogues.$inferSelect
type DialogueTurn = typeof dialogueTurns.$inferSelect

function attendedBy(dialogue: Dialogue, personId: string): boolean {
  try {
    const parsed = JSON.parse(dialogue.participantIdsJson) as unknown
    return Array.isArray(parsed) && parsed.includes(personId)
  } catch { return false }
}

function dialogueEvidence(dialoguesById: Map<string, Dialogue>, turns: DialogueTurn[], personId: string): ResidentEvidence[] {
  return turns.flatMap(turn => {
    const dialogue = dialoguesById.get(turn.dialogueId)
    if (!dialogue || !attendedBy(dialogue, personId)) return []
    return [{
      sourceId: turn.id,
      sourceIds: [turn.id, turn.dialogueId],
      timelineId: dialogue.timelineId,
      simTime: turn.simTime,
      version: null,
      recipientPersonId: personId,
      certainty: 'fact',
      kind: 'utterance',
      content: `${turn.simTime} ${turn.personId}说过：「${turn.utterance}」`,
    }]
  })
}

/** Assemble only evidence available to this resident. Dialogue thoughts are never selected. */
export async function buildResidentEvidence(
  db: Db,
  input: { timelineId: string; personId: string; knownFacts: VisibleKnowledgeFact[] },
): Promise<ResidentEvidence[]> {
  const facts: ResidentEvidence[] = input.knownFacts.map(fact => ({
    sourceId: fact.sourceFactId,
    sourceIds: [fact.sourceFactId],
    timelineId: fact.timelineId ?? input.timelineId,
    simTime: fact.simTime ?? '',
    version: fact.version ?? null,
    recipientPersonId: fact.recipientPersonId ?? null,
    certainty: fact.certainty,
    kind: fact.kind === 'knowledge' ? 'private_knowledge' : 'world_fact',
    content: fact.text,
  }))

  const attended = await db.select().from(dialogues).where(and(
    eq(dialogues.timelineId, input.timelineId),
    sql`EXISTS (SELECT 1 FROM json_each(${dialogues.participantIdsJson}) AS participant WHERE participant.value = ${input.personId})`,
  )).orderBy(desc(dialogues.simStart)).limit(20).all()
  const evidenceTurns: DialogueTurn[] = []
  const evidenceDialogues = new Map(attended.map(dialogue => [dialogue.id, dialogue]))
  if (attended.length) {
    const turns = await db.select().from(dialogueTurns)
      .where(inArray(dialogueTurns.dialogueId, attended.map(dialogue => dialogue.id)))
      .orderBy(desc(dialogueTurns.simTime), desc(dialogueTurns.turnIndex)).limit(32).all()
    evidenceTurns.push(...turns)
  }

  // Descendants may inherit dialogue transcripts only through their immutable fork snapshots.
  // If a legacy snapshot lacks complete transcript data, stop instead of reading parent futures.
  let child = await db.select().from(timelines).where(eq(timelines.id, input.timelineId)).get()
  const seenTurns = new Set(evidenceTurns.map(turn => turn.id))
  for (let depth = 0; child?.parentTimelineId && depth < 16; depth++) {
    const hydratedChild = (await hydrateTimelines(db, [child]))[0]
    const snapshot = readForkSnapshot(hydratedChild)
    if (!snapshot?.dialogues || !snapshot.dialogueTurns) break
    const dialogueById = new Map(snapshot.dialogues.map(dialogue => [dialogue.id, dialogue]))
    for (const dialogue of snapshot.dialogues) {
      if (attendedBy(dialogue, input.personId)) evidenceDialogues.set(dialogue.id, dialogue)
    }
    for (const turn of snapshot.dialogueTurns) {
      const dialogue = dialogueById.get(turn.dialogueId)
      if (!dialogue || !attendedBy(dialogue, input.personId) || turn.simTime > snapshot.sourceSimTime || seenTurns.has(turn.id)) continue
      evidenceTurns.push(turn)
      seenTurns.add(turn.id)
    }
    child = await db.select().from(timelines).where(and(
      eq(timelines.id, child.parentTimelineId), eq(timelines.worldId, child.worldId),
    )).get()
  }
  const turns = evidenceTurns.sort((a, b) => a.simTime.localeCompare(b.simTime) || a.turnIndex - b.turnIndex).slice(-32)
  return [...facts, ...dialogueEvidence(evidenceDialogues, turns, input.personId)]
}
