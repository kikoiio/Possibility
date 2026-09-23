import { afterEach, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { persons, personStates, schedules, timelines, universeRevisions, worldCommands, worldFacts, worldPersons, worlds } from '../../db/schema'
import { createWorldFixture, WORLD_TIME } from '../../test/world-fixture'
import { auditUniverse } from '../../world-state/invariants'
import type { Env } from '../../index'
import type { EngineContext, WorldSnapshot } from '../../agent/engine-context'
import type { ScheduleInput } from './schedule'
import { scheduleExecutor } from './schedule'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

it('persists an engine-generated resident schedule through a system world command', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  await f.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await f.db.insert(personStates).values({ personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Read', updatedRealAt: WORLD_TIME })
  const world = (await f.db.select().from(worlds).where(eq(worlds.id, 'home-world')).get())!
  const timeline = (await f.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())!
  const snapshot = { world, timeline, worldDate: WORLD_TIME.slice(0, 10), stateVersion: 0 } as WorldSnapshot
  const input = { step: { worldId: world.id, timelineId: timeline.id, personId: 'resident' }, snapshot,
    ctx: { person: { name: 'Resident' } } as EngineContext, prompt: { system: '', user: '' } } as ScheduleInput
  const items = [
    { start: '00:00', end: '04:00', location: 'Cafe', activity: 'Sleeping', kind: 'sleep' as const },
    { start: '04:00', end: '08:00', location: 'Cafe', activity: 'Waking up' },
    { start: '08:00', end: '12:00', location: 'Library', activity: 'Reading' },
    { start: '12:00', end: '16:00', location: 'Cafe', activity: 'Lunch' },
    { start: '16:00', end: '20:00', location: 'Library', activity: 'Writing' },
    { start: '20:00', end: '00:00', location: 'Cafe', activity: 'Going to sleep' },
  ]

  expect(await scheduleExecutor.act(f.db, {} as Env, input, { items })).toBe('schedule(Resident): 6 项')
  expect(await f.db.select().from(schedules).where(eq(schedules.timelineId, timeline.id)).all()).toHaveLength(1)
  expect(await f.db.select().from(worldCommands).where(eq(worldCommands.type, 'schedule_set')).all()).toHaveLength(1)
  expect(await f.db.select().from(worldFacts).where(eq(worldFacts.factType, 'schedule')).all())
    .toMatchObject([expect.objectContaining({ visibility: 'private', version: 1 })])
  expect(await f.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, timeline.id)).get())
    .toMatchObject({ version: 1 })
  expect(await auditUniverse(f.db, world.id, timeline.id)).toEqual([])
})
