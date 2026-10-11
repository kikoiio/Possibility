import { and, eq, inArray } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../db/client'
import { conversations, demoClaimOperations, demoSandboxes, guestSessions, persons, worldVisits, worlds, worldPersons } from '../db/schema'
import type { ClaimExecution } from './types'
import type { CloneWorldGraphResult } from './world-graph-cloner'
import { deleteClonedWorldGraph } from './world-graph-cloner'

/** Delete one failed candidate. The candidate marker is checked before any child
 * cleanup so a late failure cannot remove a newer execution's graph. */
export async function deleteClaimCandidate(db: Db, execution: ClaimExecution, cloned: CloneWorldGraphResult): Promise<boolean> {
  const row = await db.select({ id: worlds.id }).from(worlds).where(and(eq(worlds.id, cloned.worldId), eq(worlds.claimStagingExecutionId, execution.executionId))).get()
  if (!row) return false
  await deleteClonedWorldGraph(db, cloned)
  return true
}

/** Publish a verified candidate and its account-scoped rows in one D1 batch. */
export async function publishVerifiedClaim(db: Db, execution: ClaimExecution, cloned: CloneWorldGraphResult, input?: { sessionId?: string; sandboxId?: string; now?: Date }): Promise<boolean> {
  const now = input?.now ?? new Date()
  const sandbox = input?.sandboxId
    ? await db.select().from(demoSandboxes).where(eq(demoSandboxes.id, input.sandboxId)).get()
    : await db.select().from(demoSandboxes).where(eq(demoSandboxes.worldId, execution.sandboxId)).get()
  const sandboxId = input?.sandboxId ?? sandbox?.id
  if (!sandboxId) return false
  const candidate = await db.select().from(worlds).where(and(eq(worlds.id, cloned.worldId), eq(worlds.claimStagingExecutionId, execution.executionId))).get()
  if (!candidate) return false
  const operation = await db.select().from(demoClaimOperations).where(and(eq(demoClaimOperations.sandboxId, sandboxId), eq(demoClaimOperations.epoch, execution.epoch), eq(demoClaimOperations.executionId, execution.executionId), eq(demoClaimOperations.state, 'running'))).get()
  if (!operation || (operation.leaseUntil && operation.leaseUntil <= now.toISOString())) return false
  const timelineIds = [...cloned.timelineIds.values()]
  const personIds = [...cloned.personIds.values()]
  const statements: BatchItem<'sqlite'>[] = [
    db.update(worlds).set({ userId: execution.targetUserId, claimStagingExecutionId: null, status: 'running', pauseReason: null })
      .where(and(eq(worlds.id, cloned.worldId), eq(worlds.claimStagingExecutionId, execution.executionId))),
    db.update(persons).set({ userId: execution.targetUserId }).where(inArray(persons.id, personIds)),
    db.update(conversations).set({ userId: execution.targetUserId }).where(inArray(conversations.timelineId, timelineIds)),
    db.update(worldVisits).set({ userId: execution.targetUserId }).where(inArray(worldVisits.timelineId, timelineIds)),
    db.update(demoSandboxes).set({ status: 'claimed', claimedWorldId: cloned.worldId }).where(and(eq(demoSandboxes.id, sandboxId), eq(demoSandboxes.status, 'active'))),
    db.update(demoClaimOperations).set({ state: 'succeeded', leaseUntil: null, updatedAt: now.toISOString() })
      .where(and(eq(demoClaimOperations.sandboxId, sandboxId), eq(demoClaimOperations.epoch, execution.epoch), eq(demoClaimOperations.executionId, execution.executionId), eq(demoClaimOperations.state, 'running'))),
  ]
  if (input?.sessionId) statements.push(db.update(guestSessions).set({ status: 'claimed', updatedAt: now.toISOString() }).where(and(eq(guestSessions.id, input.sessionId), eq(guestSessions.status, 'claim_pending'))))
  else if (sandbox?.sessionId) statements.push(db.update(guestSessions).set({ status: 'claimed', updatedAt: now.toISOString() }).where(and(eq(guestSessions.id, sandbox.sessionId), eq(guestSessions.status, 'claim_pending'))))
  try {
    await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
    return true
  } catch {
    return false
  }
}
