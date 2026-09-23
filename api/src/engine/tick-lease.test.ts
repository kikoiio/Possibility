import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { engineTickLeases, worldCommands } from '../db/schema'
import { createWorldFixture } from '../test/world-fixture'
import { acquireEngineTickLease, ENGINE_TICK_LEASE_ID, ENGINE_TICK_LEASE_MS, renewEngineTickLease, releaseEngineTickLease } from './tick-lease'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

describe('cross-Worker engine tick lease', () => {
  it('allows one atomic owner, expires safely, and fences the previous owner', async () => {
    fixture = await createWorldFixture()
    const f = fixture
    const contenders = await Promise.all([
      acquireEngineTickLease(f.db, 'worker-a', 10_000),
      acquireEngineTickLease(f.db, 'worker-b', 10_000),
    ])
    expect(contenders.filter(Boolean)).toHaveLength(1)
    const firstOwner = contenders[0] ? 'worker-a' : 'worker-b'
    const nextOwner = firstOwner === 'worker-a' ? 'worker-b' : 'worker-a'
    expect(await f.db.select().from(engineTickLeases).where(eq(engineTickLeases.id, ENGINE_TICK_LEASE_ID)).get())
      .toMatchObject({ ownerToken: firstOwner, leaseUntil: 10_000 + ENGINE_TICK_LEASE_MS })
    expect(await acquireEngineTickLease(f.db, nextOwner, 10_001)).toBe(false)
    expect(await renewEngineTickLease(f.db, firstOwner, 10_002)).toBe(true)

    const takeoverAt = 10_002 + ENGINE_TICK_LEASE_MS
    expect(await acquireEngineTickLease(f.db, nextOwner, takeoverAt)).toBe(true)
    expect(await renewEngineTickLease(f.db, firstOwner, takeoverAt + 1)).toBe(false)
    await releaseEngineTickLease(f.db, firstOwner)
    expect(await f.db.select().from(engineTickLeases).where(eq(engineTickLeases.id, ENGINE_TICK_LEASE_ID)).get())
      .toMatchObject({ ownerToken: nextOwner })
    expect(await renewEngineTickLease(f.db, nextOwner, takeoverAt + 2)).toBe(true)
    await releaseEngineTickLease(f.db, nextOwner)
    expect(await f.db.select().from(engineTickLeases).all()).toEqual([])
  })

  it('rejects versioned engine commands from a stale lease token at the database boundary', async () => {
    fixture = await createWorldFixture()
    const f = fixture
    const owner = crypto.randomUUID()
    expect(await acquireEngineTickLease(f.db, owner)).toBe(true)
    const command = { worldId: 'home-world', timelineId: 'home-main', actorKind: 'system', actorId: null,
      type: 'clock_advance', payloadJson: '{}', expectedVersion: 0, resultVersion: 1, createdAt: '2026-09-21T08:00:00.000Z' }
    await f.db.insert(worldCommands).values({ id: 'current-owner-command', ...command, tickLeaseToken: owner })
    await expect(f.db.insert(worldCommands).values({ id: 'stale-owner-command', ...command, tickLeaseToken: 'old-worker' }))
      .rejects.toThrow()
    expect(await f.db.select().from(worldCommands).all()).toHaveLength(1)
  })
})
