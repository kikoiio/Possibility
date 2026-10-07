import { and, eq, inArray, lte } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../db/client'
import {
  chatRequests, chapters, commitments, conversations, demoSandboxes, dialogueTurns, dialogues,
  events, guestSessions, llmCallLog, memories, messages, personaMessages, personStates, persons,
  schedules, sceneIntentProposals, sceneRequests, sessions, timelines, timelineSceneHeads, timelineSceneRevisions,
  native2dLayoutHeads, native2dLayoutRevisions, universeEvidence,
  universeRevisions, userWorldPreferences, worldCommands, worldFacts, worldModelVersions,
  users, worldPersons, worldSceneRevisions, worldScenes, worldVisits, worlds,
} from '../db/schema'

export interface GuestCleanupSummary { sessions: number; sandboxes: number; worlds: number }

async function purgeSandbox(db: Db, sandboxId: string, worldId: string, ownerId: string): Promise<void> {
  const timelineRows = await db.select({ id: timelines.id }).from(timelines).where(eq(timelines.worldId, worldId)).all()
  const timelineIds = timelineRows.map(row => row.id)
  const peopleRows = await db.select({ id: worldPersons.personId }).from(worldPersons).where(eq(worldPersons.worldId, worldId)).all()
  const personIds = peopleRows.map(row => row.id)
  const dialogueIds = timelineIds.length
    ? (await db.select({ id: dialogues.id }).from(dialogues).where(inArray(dialogues.timelineId, timelineIds)).all()).map(row => row.id)
    : []
  const conversationIds = timelineIds.length
    ? (await db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.timelineId, timelineIds)).all()).map(row => row.id)
    : []

  const statements: BatchItem<'sqlite'>[] = []
  statements.push(db.delete(sceneRequests).where(dialogueIds.length ? inArray(sceneRequests.dialogueId, dialogueIds) : eq(sceneRequests.id, '')))
  statements.push(db.delete(sceneIntentProposals).where(eq(sceneIntentProposals.worldId, worldId)))
  statements.push(db.delete(chatRequests).where(eq(chatRequests.worldId, worldId)))
  statements.push(db.delete(messages).where(conversationIds.length ? inArray(messages.conversationId, conversationIds) : eq(messages.id, '')))
  statements.push(db.delete(conversations).where(conversationIds.length ? inArray(conversations.id, conversationIds) : eq(conversations.id, '')))
  statements.push(db.delete(dialogueTurns).where(dialogueIds.length ? inArray(dialogueTurns.dialogueId, dialogueIds) : eq(dialogueTurns.id, '')))
  statements.push(db.delete(personaMessages).where(eq(personaMessages.worldId, worldId)))
  statements.push(db.delete(commitments).where(eq(commitments.worldId, worldId)))
  statements.push(db.delete(events).where(timelineIds.length ? inArray(events.timelineId, timelineIds) : eq(events.id, '')))
  statements.push(db.delete(dialogues).where(timelineIds.length ? inArray(dialogues.timelineId, timelineIds) : eq(dialogues.id, '')))
  statements.push(db.delete(chapters).where(eq(chapters.worldId, worldId)))
  statements.push(db.delete(worldVisits).where(timelineIds.length ? inArray(worldVisits.timelineId, timelineIds) : eq(worldVisits.userId, ownerId)))
  statements.push(db.delete(personStates).where(timelineIds.length ? inArray(personStates.timelineId, timelineIds) : eq(personStates.personId, '')))
  statements.push(db.delete(schedules).where(timelineIds.length ? inArray(schedules.timelineId, timelineIds) : eq(schedules.personId, '')))
  statements.push(db.delete(memories).where(personIds.length ? inArray(memories.personId, personIds) : eq(memories.id, '')))
  statements.push(db.delete(worldFacts).where(timelineIds.length ? inArray(worldFacts.timelineId, timelineIds) : eq(worldFacts.id, '')))
  statements.push(db.delete(worldCommands).where(eq(worldCommands.worldId, worldId)))
  statements.push(db.delete(universeEvidence).where(timelineIds.length ? inArray(universeEvidence.timelineId, timelineIds) : eq(universeEvidence.timelineId, '')))
  statements.push(db.delete(universeRevisions).where(timelineIds.length ? inArray(universeRevisions.timelineId, timelineIds) : eq(universeRevisions.timelineId, '')))
  statements.push(db.delete(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, worldId)))
  statements.push(db.delete(timelineSceneHeads).where(eq(timelineSceneHeads.worldId, worldId)))
  statements.push(db.delete(timelineSceneRevisions).where(eq(timelineSceneRevisions.worldId, worldId)))
  statements.push(db.delete(native2dLayoutHeads).where(eq(native2dLayoutHeads.worldId, worldId)))
  statements.push(db.delete(native2dLayoutRevisions).where(eq(native2dLayoutRevisions.worldId, worldId)))
  statements.push(db.delete(worldScenes).where(eq(worldScenes.worldId, worldId)))
  statements.push(db.delete(worldModelVersions).where(eq(worldModelVersions.worldId, worldId)))
  statements.push(db.delete(worldPersons).where(eq(worldPersons.worldId, worldId)))
  statements.push(db.delete(timelines).where(eq(timelines.worldId, worldId)))
  statements.push(db.delete(llmCallLog).where(eq(llmCallLog.worldId, worldId)))
  statements.push(db.delete(demoSandboxes).where(eq(demoSandboxes.id, sandboxId)))
  statements.push(db.delete(worlds).where(eq(worlds.id, worldId)))
  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
}

/** Removes expired guest data only after fencing all credentials and marking each sandbox for purge. */
export async function cleanupExpiredGuestData(db: Db, now = new Date()): Promise<GuestCleanupSummary> {
  const nowIso = now.toISOString()
  // claim_pending is intentionally absent: its source copy survives ordinary guest TTL cleanup until claim succeeds.
  const expiredSessions = await db.select().from(guestSessions)
    .where(and(lte(guestSessions.expiresAt, nowIso), inArray(guestSessions.status, ['active', 'expired']))).all()
  const oldClaimedSessions = await db.select().from(guestSessions)
    .where(and(eq(guestSessions.status, 'claimed'), lte(guestSessions.updatedAt, new Date(now.getTime() - 30 * 86400000).toISOString()))).all()
  const candidates = [...new Map([...expiredSessions, ...oldClaimedSessions].map(row => [row.id, row])).values()]
  let sandboxCount = 0
  let worldCount = 0
  for (const session of candidates) {
    await db.update(guestSessions).set({ currentSandboxWorldId: null, resumeTimelineId: null, status: 'expired', updatedAt: nowIso })
      .where(eq(guestSessions.id, session.id))
    const sandboxes = await db.select().from(demoSandboxes).where(and(
      eq(demoSandboxes.sessionId, session.id), lte(demoSandboxes.expiresAt, nowIso),
    )).all()
    for (const sandbox of sandboxes) {
      await db.update(demoSandboxes).set({ status: 'purging' }).where(eq(demoSandboxes.id, sandbox.id))
      await purgeSandbox(db, sandbox.id, sandbox.worldId, session.ownerUserId)
      sandboxCount++
      worldCount++
    }
    const remaining = await db.select({ id: demoSandboxes.id }).from(demoSandboxes).where(eq(demoSandboxes.sessionId, session.id)).get()
    if (!remaining) {
      await db.delete(sessions).where(eq(sessions.userId, session.ownerUserId))
      await db.delete(userWorldPreferences).where(eq(userWorldPreferences.userId, session.ownerUserId))
      await db.delete(persons).where(eq(persons.userId, session.ownerUserId))
      await db.delete(llmCallLog).where(eq(llmCallLog.userId, session.ownerUserId))
      await db.delete(guestSessions).where(eq(guestSessions.id, session.id))
      await db.delete(worldVisits).where(eq(worldVisits.userId, session.ownerUserId))
      await db.delete(users).where(eq(users.id, session.ownerUserId))
    }
  }
  return { sessions: candidates.length, sandboxes: sandboxCount, worlds: worldCount }
}
