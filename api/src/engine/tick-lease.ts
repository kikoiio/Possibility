import { and, eq, gt, lte } from 'drizzle-orm'
import type { Db } from '../db/client'
import { engineTickLeases } from '../db/schema'

export const ENGINE_TICK_LEASE_ID = 'autonomous-world-tick'
export const ENGINE_TICK_LEASE_MS = 180_000
export const ENGINE_TICK_HEARTBEAT_MS = 45_000

/** Atomic cross-Worker acquisition. A live owner's lease is never overwritten. */
export async function acquireEngineTickLease(db: Db, ownerToken: string, now = Date.now()): Promise<boolean> {
  const claimed = await db.insert(engineTickLeases).values({ id: ENGINE_TICK_LEASE_ID, ownerToken,
    leaseUntil: now + ENGINE_TICK_LEASE_MS, updatedAt: now })
    .onConflictDoUpdate({ target: engineTickLeases.id,
      set: { ownerToken, leaseUntil: now + ENGINE_TICK_LEASE_MS, updatedAt: now },
      setWhere: lte(engineTickLeases.leaseUntil, now),
    })
    .returning({ ownerToken: engineTickLeases.ownerToken }).get()
  return claimed?.ownerToken === ownerToken
}

/** Renew only while this invocation still owns an unexpired lease. */
export async function renewEngineTickLease(db: Db, ownerToken: string, now = Date.now()): Promise<boolean> {
  const renewed = await db.update(engineTickLeases)
    .set({ leaseUntil: now + ENGINE_TICK_LEASE_MS, updatedAt: now })
    .where(and(eq(engineTickLeases.id, ENGINE_TICK_LEASE_ID), eq(engineTickLeases.ownerToken, ownerToken),
      gt(engineTickLeases.leaseUntil, now)))
    .returning({ ownerToken: engineTickLeases.ownerToken }).get()
  return renewed?.ownerToken === ownerToken
}

export async function releaseEngineTickLease(db: Db, ownerToken: string): Promise<void> {
  await db.delete(engineTickLeases).where(and(eq(engineTickLeases.id, ENGINE_TICK_LEASE_ID),
    eq(engineTickLeases.ownerToken, ownerToken))).run()
}
