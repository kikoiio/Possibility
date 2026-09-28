import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { demoBaselines, worlds } from '../db/schema'
import type { AccessContext } from './types'
import { capabilitiesFor } from './policy'

export async function resolveWorldScope(db: Db, access: AccessContext, worldId: string) {
  const world = await db.select().from(worlds).where(eq(worlds.id, worldId)).get()
  if (!world) return null
  const baseline = await db.select({ id: demoBaselines.id }).from(demoBaselines)
    .where(and(eq(demoBaselines.worldId, worldId), eq(demoBaselines.status, 'active'))).get()
  const isPublicBaseline = !!baseline
  const ownsWorld = access.kind === 'user' ? world.userId === access.userId
    : access.kind === 'guest' ? world.id === access.worldId && world.userId === access.ownerId
      : false
  const capabilities = capabilitiesFor(access, { isPublicBaseline, ownsWorld })
  if (!capabilities.observe) return null
  return { world, baselineId: baseline?.id ?? null, isPublicBaseline, ownsWorld, capabilities }
}
