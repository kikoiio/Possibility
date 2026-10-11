import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { demoSandboxes, guestSessions, worlds } from '../db/schema'
import { hashGuestToken } from '../access/middleware'
import { readClaimOperation } from './claim-repository'
import type { ClaimSourceBinding, ClaimStatus } from './types'

export async function readClaimStatus(db: Db, input: {
  token: string; userId: string; requestId: string; expectedBinding: ClaimSourceBinding; now?: Date
}): Promise<ClaimStatus> {
  const session = await db.select().from(guestSessions).where(eq(guestSessions.tokenHash, await hashGuestToken(input.token))).get()
  if (!session || !session.currentSandboxWorldId) return { kind: 'unavailable', code: 'claim_unavailable' }
  if (session.generation !== input.expectedBinding.generation || session.id !== input.expectedBinding.sessionId || session.currentSandboxWorldId !== input.expectedBinding.worldId) {
    return { kind: 'unavailable', code: 'source_changed' }
  }
  const sandbox = await db.select().from(demoSandboxes).where(and(eq(demoSandboxes.sessionId, session.id), eq(demoSandboxes.generation, session.generation))).get()
  if (!sandbox) return { kind: 'unavailable', code: 'claim_unavailable' }
  if (sandbox.claimedWorldId) {
    const owner = await db.select({ userId: worlds.userId }).from(worlds).where(eq(worlds.id, sandbox.claimedWorldId)).get()
    return owner?.userId === input.userId
      ? { kind: 'claimed', worldId: sandbox.claimedWorldId, replayed: true }
      : { kind: 'conflict', code: 'already_claimed_elsewhere' }
  }
  const op = await readClaimOperation(db, sandbox.id)
  if (!op) return { kind: 'not-started', epoch: 0, safeToSwitch: false }
  if (op.state === 'running') return { kind: 'in-progress', epoch: op.epoch, ...(op.targetUserId === input.userId && op.executionId ? { executionId: op.executionId } : {}), recoveryAvailable: Boolean(op.leaseUntil && op.leaseUntil <= (input.now ?? new Date()).toISOString()), safeToSwitch: false }
  if (op.state === 'failed') return { kind: 'retryable', epoch: op.epoch, safeToSwitch: true }
  return { kind: 'unavailable', code: 'claim_unavailable' }
}
