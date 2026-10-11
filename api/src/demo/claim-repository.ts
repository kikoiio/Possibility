import { and, eq, isNull, lte, gt } from 'drizzle-orm'
import type { Db } from '../db/client'
import { demoClaimOperations, demoSandboxes } from '../db/schema'
import type { ClaimExecution, DemoClaimOperation } from './types'

export const CLAIM_LEASE_MS = 120_000

type OperationRow = typeof demoClaimOperations.$inferSelect

function operation(row: OperationRow): DemoClaimOperation {
  return {
    sandboxId: row.sandboxId, requestId: row.requestId, targetUserId: row.targetUserId,
    epoch: row.epoch, executionId: row.executionId, executionNo: row.executionNo,
    state: row.state as DemoClaimOperation['state'], leaseUntil: row.leaseUntil,
    candidateWorldId: row.candidateWorldId, failureCode: row.failureCode,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  }
}

export async function readClaimOperation(db: Db, sandboxId: string): Promise<DemoClaimOperation | null> {
  const row = await db.select().from(demoClaimOperations).where(eq(demoClaimOperations.sandboxId, sandboxId)).get()
  return row ? operation(row) : null
}

/** The same deterministic ID used by cloneWorldGraph for a given execution. */
export async function candidateWorldIdFor(requestId: string, sourceWorldId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${requestId}\u0000world\u0000${sourceWorldId}`))
  return `world-${[...new Uint8Array(digest)].slice(0, 16).map(value => value.toString(16).padStart(2, '0')).join('')}`
}

export type AcquireClaimResult =
  | { kind: 'acquired'; execution: ClaimExecution }
  | { kind: 'in-progress'; operation: DemoClaimOperation }
  | { kind: 'succeeded'; worldId: string }
  | { kind: 'retryable'; epoch: number }
  | { kind: 'conflict' }
  | { kind: 'stale'; epoch: number }

export async function acquireClaimExecution(db: Db, input: {
  sandboxId: string; requestId: string; targetUserId: string; expectedEpoch?: number;
  candidateWorldId?: string; now?: Date
}): Promise<AcquireClaimResult> {
  const now = input.now ?? new Date()
  const nowIso = now.toISOString()
  let current = await db.select().from(demoClaimOperations).where(eq(demoClaimOperations.sandboxId, input.sandboxId)).get()
  if (!current) {
    await db.insert(demoClaimOperations).values({
      sandboxId: input.sandboxId, requestId: input.requestId, targetUserId: input.targetUserId,
      epoch: 0, executionId: null, executionNo: 0, state: 'failed', leaseUntil: null,
      candidateWorldId: null, failureCode: null, createdAt: nowIso, updatedAt: nowIso,
    }).onConflictDoNothing()
    current = await db.select().from(demoClaimOperations).where(eq(demoClaimOperations.sandboxId, input.sandboxId)).get()
  }
  if (!current) return { kind: 'conflict' }
  if (current.state === 'succeeded' && current.candidateWorldId) return { kind: 'succeeded', worldId: current.candidateWorldId }
  if (current.state === 'running' && current.executionId) return { kind: 'in-progress', operation: operation(current) }
  if (current.targetUserId !== input.targetUserId && current.state === 'failed' && current.requestId !== input.requestId) return { kind: 'conflict' }
  const expected = input.expectedEpoch ?? 0
  if (current.epoch !== expected) {
    return current.state === 'failed' ? { kind: 'stale', epoch: current.epoch } : { kind: 'conflict' }
  }
  const executionId = crypto.randomUUID()
  const executionNo = current.executionNo + 1
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString()
  const candidateWorldId = input.candidateWorldId ?? current.candidateWorldId ?? crypto.randomUUID()
  const changed = await db.update(demoClaimOperations).set({
    requestId: input.requestId, targetUserId: input.targetUserId, executionId, executionNo,
    state: 'running', leaseUntil, candidateWorldId, failureCode: null, updatedAt: nowIso,
  }).where(and(eq(demoClaimOperations.sandboxId, input.sandboxId), eq(demoClaimOperations.epoch, expected), eq(demoClaimOperations.state, 'failed'))).returning()
  if (!changed.length) {
    current = await db.select().from(demoClaimOperations).where(eq(demoClaimOperations.sandboxId, input.sandboxId)).get()
    if (current?.state === 'running' && current.executionId) return { kind: 'in-progress', operation: operation(current) }
    return { kind: 'conflict' }
  }
  return { kind: 'acquired', execution: {
    sandboxId: input.sandboxId, requestId: input.requestId, targetUserId: input.targetUserId,
    epoch: expected, executionId, candidateWorldId, leaseUntil,
  } }
}

export async function closeClaimExecution(db: Db, input: {
  sandboxId: string; targetUserId: string; requestId: string; epoch: number; executionId: string;
  failureCode?: string; now?: Date
}): Promise<{ closed: boolean; nextEpoch?: number }> {
  const now = input.now ?? new Date()
  const rows = await db.update(demoClaimOperations).set({
    state: 'failed', epoch: input.epoch + 1, executionId: null, leaseUntil: null,
    failureCode: input.failureCode ?? 'claim_failed', updatedAt: now.toISOString(),
  }).where(and(eq(demoClaimOperations.sandboxId, input.sandboxId), eq(demoClaimOperations.targetUserId, input.targetUserId), eq(demoClaimOperations.requestId, input.requestId), eq(demoClaimOperations.epoch, input.epoch), eq(demoClaimOperations.executionId, input.executionId), eq(demoClaimOperations.state, 'running'))).returning({ sandboxId: demoClaimOperations.sandboxId })
  return rows.length ? { closed: true, nextEpoch: input.epoch + 1 } : { closed: false }
}

export type RecoverClaimResult =
  | { kind: 'in-progress'; operation: DemoClaimOperation }
  | { kind: 'retryable'; epoch: number }
  | { kind: 'conflict'; epoch: number }

export async function recoverClaimOperation(db: Db, input: {
  sandboxId: string; requestId: string; targetUserId: string; observedEpoch: number;
  observedExecutionId: string | null; now?: Date
}): Promise<RecoverClaimResult> {
  const now = input.now ?? new Date()
  const current = await db.select().from(demoClaimOperations).where(eq(demoClaimOperations.sandboxId, input.sandboxId)).get()
  if (!current) {
    await db.insert(demoClaimOperations).values({
      sandboxId: input.sandboxId, requestId: input.requestId, targetUserId: input.targetUserId,
      epoch: input.observedEpoch + 1, executionId: null, executionNo: 0, state: 'failed', leaseUntil: null,
      candidateWorldId: null, failureCode: 'recovered_without_observed_operation',
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    }).onConflictDoNothing()
    const inserted = await db.select({ epoch: demoClaimOperations.epoch }).from(demoClaimOperations).where(eq(demoClaimOperations.sandboxId, input.sandboxId)).get()
    return inserted?.epoch === input.observedEpoch + 1 ? { kind: 'retryable', epoch: inserted.epoch } : { kind: 'conflict', epoch: inserted?.epoch ?? input.observedEpoch }
  }
  if (current.epoch !== input.observedEpoch || current.targetUserId !== input.targetUserId || current.requestId !== input.requestId) return { kind: 'conflict', epoch: current.epoch }
  if (current.state === 'succeeded') return { kind: 'conflict', epoch: current.epoch }
  if (current.state !== 'running' || current.executionId !== input.observedExecutionId) return { kind: 'conflict', epoch: current.epoch }
  if (current.leaseUntil && current.leaseUntil > now.toISOString()) return { kind: 'in-progress', operation: operation(current) }
  const closed = await closeClaimExecution(db, {
    sandboxId: input.sandboxId, targetUserId: input.targetUserId, requestId: input.requestId,
    epoch: input.observedEpoch, executionId: input.observedExecutionId!, failureCode: 'recovered', now,
  })
  return closed.closed ? { kind: 'retryable', epoch: input.observedEpoch + 1 } : { kind: 'conflict', epoch: input.observedEpoch }
}

export async function markClaimSucceeded(db: Db, execution: ClaimExecution, now = new Date()): Promise<boolean> {
  const rows = await db.update(demoClaimOperations).set({ state: 'succeeded', executionId: execution.executionId, leaseUntil: null, updatedAt: now.toISOString() })
    .where(and(eq(demoClaimOperations.sandboxId, execution.sandboxId), eq(demoClaimOperations.targetUserId, execution.targetUserId), eq(demoClaimOperations.epoch, execution.epoch), eq(demoClaimOperations.executionId, execution.executionId), eq(demoClaimOperations.state, 'running'))).returning({ sandboxId: demoClaimOperations.sandboxId })
  return rows.length > 0
}

export async function setCandidateWorld(db: Db, execution: ClaimExecution): Promise<void> {
  await db.update(demoClaimOperations).set({ candidateWorldId: execution.candidateWorldId }).where(and(eq(demoClaimOperations.sandboxId, execution.sandboxId), eq(demoClaimOperations.executionId, execution.executionId)))
}
