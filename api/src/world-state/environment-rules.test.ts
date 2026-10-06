import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { persons, personStates, timelines, worldFacts, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { forkTimeline } from '../life/fork'
import { commitWorldCommand } from './commit'

type Fixture = Awaited<ReturnType<typeof createWorldFixture>>
let fixture: Fixture | null = null
afterEach(() => { fixture?.close(); fixture = null })

async function setup() {
  fixture = await createWorldFixture()
  await fixture.db.insert(persons).values([
    { id: 'a', userId: 'owner', name: 'A', modelJson: '{}', createdAt: WORLD_TIME },
    { id: 'b', userId: 'owner', name: 'B', modelJson: '{}', createdAt: WORLD_TIME },
    { id: 'c', userId: 'owner', name: 'C', modelJson: '{}', createdAt: WORLD_TIME },
  ])
  await fixture.db.insert(worldPersons).values([
    { worldId: 'home-world', personId: 'a', joinedAt: WORLD_TIME },
    { worldId: 'home-world', personId: 'b', joinedAt: WORLD_TIME },
    { worldId: 'home-world', personId: 'c', joinedAt: WORLD_TIME },
  ])
  await fixture.db.insert(personStates).values([
    { personId: 'a', timelineId: 'home-main', simTime: WORLD_TIME, location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Read', updatedRealAt: WORLD_TIME },
    { personId: 'b', timelineId: 'home-main', simTime: WORLD_TIME, location: 'Library', activity: 'Reading', mood: 'Calm', goal: 'Read', updatedRealAt: WORLD_TIME },
  ])
  return fixture
}

const base = { worldId: 'home-world', timelineId: 'home-main', userId: 'owner' }

describe('D3 finite environment rules', () => {
  it('rejects unsupported conditions and values before writing a fact', async () => {
    const f = await setup()
    await expect(commitWorldCommand(f.db, { ...base, id: 'bad-value', expectedVersion: 0,
      action: { type: 'environment', location: 'Cafe', condition: 'weather', value: 'hail' } }))
      .rejects.toMatchObject({ status: 400, reasonCode: 'unsupported' })
    await expect(commitWorldCommand(f.db, { ...base, id: 'bad-condition', expectedVersion: 0,
      action: { type: 'environment', location: 'Cafe', condition: 'temperature', value: 'clear' } }))
      .rejects.toMatchObject({ status: 400, reasonCode: 'invalid_condition' })
    expect(await f.db.select().from(worldFacts).all()).toHaveLength(0)
  })

  it('allows structured environment writes only for the owner actor', async () => {
    const f = await setup()
    await expect(commitWorldCommand(f.db, { ...base, id: 'system-environment', actorKind: 'system', expectedVersion: 0,
      action: { type: 'environment', location: 'Cafe', condition: 'weather', value: 'rain' } }))
      .rejects.toMatchObject({ status: 403 })
    expect(await f.db.select().from(worldFacts).all()).toHaveLength(0)
  })

  it('blocks entering a closed location while allowing an occupant to leave', async () => {
    const f = await setup()
    await commitWorldCommand(f.db, { ...base, id: 'close-cafe', expectedVersion: 0,
      action: { type: 'environment', location: 'Cafe', condition: 'access', value: 'closed' } })
    await expect(commitWorldCommand(f.db, { ...base, id: 'move-into-closed-cafe', expectedVersion: 1,
      action: { type: 'move', personId: 'b', to: 'Cafe' } }))
      .rejects.toMatchObject({ status: 409, reasonCode: 'environment_access_blocked' })
    await expect(commitWorldCommand(f.db, { ...base, id: 'enter-closed-cafe', expectedVersion: 1,
      action: { type: 'enter', personId: 'c', to: 'Cafe' } }))
      .rejects.toMatchObject({ status: 409, reasonCode: 'environment_access_blocked' })
    await commitWorldCommand(f.db, { ...base, id: 'leave-closed-cafe', expectedVersion: 1,
      action: { type: 'move', personId: 'a', to: 'Library' } })
    expect((await f.db.select().from(personStates).where(eq(personStates.personId, 'a')).get())?.location).toBe('Library')
  })

  it('lets an owner reopen a closed location and retry the blocked move', async () => {
    const f = await setup()
    await commitWorldCommand(f.db, { ...base, id: 'close-cafe-retry', expectedVersion: 0,
      action: { type: 'environment', location: 'Cafe', condition: 'access', value: 'closed' } })
    await expect(commitWorldCommand(f.db, { ...base, id: 'blocked-retry-move', expectedVersion: 1,
      action: { type: 'move', personId: 'b', to: 'Cafe' } })).rejects.toMatchObject({
      status: 409, reasonCode: 'environment_access_blocked',
    })
    await commitWorldCommand(f.db, { ...base, id: 'open-cafe-retry', expectedVersion: 1,
      action: { type: 'environment', location: 'Cafe', condition: 'access', value: 'open' } })
    await expect(commitWorldCommand(f.db, { ...base, id: 'retry-move', expectedVersion: 2,
      action: { type: 'move', personId: 'b', to: 'Cafe' } })).resolves.toMatchObject({ version: 3 })
  })

  it('keeps owner writes scoped to an active fork and isolates parent updates', async () => {
    const f = await setup()
    await commitWorldCommand(f.db, { ...base, id: 'parent-close', expectedVersion: 0,
      action: { type: 'environment', location: 'Cafe', condition: 'access', value: 'closed' } })
    const fork = await forkTimeline(f.db, 'home-world', 'home-main', {
      name: 'Closed cafe branch', whatIf: 'Cafe opens only in this branch', startTime: WORLD_TIME,
      changedVariable: 'Cafe access', participants: [], invariants: [],
    }, 'd3-access-fork')
    const forkBase = { ...base, timelineId: fork.id }

    await commitWorldCommand(f.db, { ...base, id: 'parent-open', expectedVersion: 1,
      action: { type: 'environment', location: 'Cafe', condition: 'access', value: 'open' } })
    await expect(commitWorldCommand(f.db, { ...forkBase, id: 'fork-still-closed', expectedVersion: 0,
      action: { type: 'move', personId: 'b', to: 'Cafe' } })).rejects.toMatchObject({
      status: 409, reasonCode: 'environment_access_blocked',
    })

    await commitWorldCommand(f.db, { ...forkBase, id: 'fork-open', expectedVersion: 0,
      action: { type: 'environment', location: 'Cafe', condition: 'access', value: 'open' } })
    await expect(commitWorldCommand(f.db, { ...forkBase, id: 'fork-retry', expectedVersion: 1,
      action: { type: 'move', personId: 'b', to: 'Cafe' } })).resolves.toMatchObject({ version: 2 })

    await expect(commitWorldCommand(f.db, { ...forkBase, id: 'foreign-owner-fork-write', expectedVersion: 2,
      userId: 'other', action: { type: 'environment', location: 'Cafe', condition: 'access', value: 'closed' } }))
      .rejects.toMatchObject({ status: 404 })
    expect(await f.db.select().from(timelines).where(eq(timelines.id, fork.id)).get()).toMatchObject({ status: 'active' })
  })
})
