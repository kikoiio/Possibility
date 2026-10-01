import { eq } from 'drizzle-orm'
import { afterEach, expect, it } from 'vitest'
import { PROJECTION_DOMAINS, createRootProjectionBaseline } from './model'
import { collectReplayInput, readCurrentProjection } from './evidence'
import { compareProjection, rebuildProjection } from './rebuild'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { personStates, persons, universeRevisions, worldCommands, worldFacts, worldModelVersions, worldPersons } from '../db/schema'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

it('collects a complete immutable root baseline and audits it without changing source rows', async () => {
  fixture = await createWorldFixture()
  const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [])
  await fixture.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
    modelJson: JSON.stringify({ name: 'Home world', description: 'A small town', locations: [], residents: [], projectionBaseline: baseline }) })
  await fixture.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME,
    worldModelVersion: 1, updatedAt: WORLD_TIME })
  const snapshot = () => Object.fromEntries([
    'world_model_versions', 'universe_revisions', 'world_commands', 'world_facts', 'person_states', 'schedules', 'events',
    'commitments', 'memories', 'dialogues', 'dialogue_turns', 'persona_messages',
  ].map(table => [table, fixture!.sqlite.prepare(`SELECT * FROM ${table}`).all()]))
  const before = snapshot()

  const evidence = await collectReplayInput(fixture.db, 'home-world', 'home-main')
  const current = await readCurrentProjection(fixture.db, 'home-world', 'home-main')
  const result = await rebuildProjection(fixture.db, 'home-world', 'home-main', evidence, current)

  expect(evidence.baseline?.completeDomains).toEqual([...PROJECTION_DOMAINS])
  expect(evidence.baseline?.rows).toMatchObject({ states: [], schedules: [], events: [], commitments: [], memories: [],
    dialogues: [], dialogueTurns: [], personaMessages: [] })
  expect(result).toMatchObject({ status: 'complete', throughVersion: 0, differences: [] })
  expect(snapshot()).toEqual(before)
})

it('locates a corrupted projection from its immutable baseline without modifying the database', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  const state = { personId: 'resident', timelineId: 'home-main', simTime: WORLD_TIME, location: 'Cafe', activity: 'Reading',
    mood: 'Calm', goal: 'Explore', currentDialogueId: null, lastBeatSimTime: WORLD_TIME, updatedRealAt: WORLD_TIME }
  await f.db.insert(persons).values({ id: 'resident', userId: 'owner', name: 'Resident', modelJson: '{}', createdAt: WORLD_TIME })
  await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
  await f.db.insert(personStates).values(state)
  const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [state])
  await f.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
    modelJson: JSON.stringify({ name: 'Home world', description: 'A small town', locations: [], residents: [],
      initialStates: { capturedAt: WORLD_TIME, states: [state] }, projectionBaseline: baseline }) })
  await f.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME,
    worldModelVersion: 1, updatedAt: WORLD_TIME })
  await f.db.update(personStates).set({ mood: 'Changed after baseline' }).where(eq(personStates.personId, 'resident'))
  const before = f.sqlite.prepare('SELECT * FROM person_states').all()

  const result = await rebuildProjection(f.db, 'home-world', 'home-main',
    await collectReplayInput(f.db, 'home-world', 'home-main'),
    await readCurrentProjection(f.db, 'home-world', 'home-main'))

  expect(result.differences).toContainEqual(expect.objectContaining({
    domain: 'states', kind: 'mismatch', commandId: 'baseline:home-main', recordId: 'resident', version: 0,
  }))
  expect(f.sqlite.prepare('SELECT * FROM person_states').all()).toEqual(before)
})

it('keeps a legacy timeline without a structured baseline explicitly incomplete', async () => {
  fixture = await createWorldFixture()
  await fixture.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
    modelJson: JSON.stringify({ name: 'Home world', description: 'Legacy', locations: [], residents: [] }) })
  await fixture.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME,
    worldModelVersion: 1, updatedAt: WORLD_TIME })

  const evidence = await collectReplayInput(fixture.db, 'home-world', 'home-main')
  const current = await readCurrentProjection(fixture.db, 'home-world', 'home-main')
  const result = await rebuildProjection(fixture.db, 'home-world', 'home-main', evidence, current)

  expect(evidence.baseline).toBeNull()
  expect(result.status).toBe('incomplete')
})

it('reports unknown command semantics as unsupported instead of silently skipping them', async () => {
  fixture = await createWorldFixture()
  const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [])
  await fixture.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
    modelJson: JSON.stringify({ name: 'Home world', description: 'A small town', locations: [], residents: [], projectionBaseline: baseline }) })
  await fixture.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 1, simTime: WORLD_TIME,
    worldModelVersion: 1, updatedAt: WORLD_TIME })
  await fixture.db.insert(worldCommands).values({ id: 'unknown-command', worldId: 'home-world', timelineId: 'home-main',
    actorKind: 'builder', actorId: 'owner', type: 'future_action', payloadJson: '{"type":"future_action"}', expectedVersion: 0,
    resultVersion: 1, tickLeaseToken: null, createdAt: WORLD_TIME })
  await fixture.db.insert(worldFacts).values({ id: 'unknown-fact', timelineId: 'home-main', version: 1, simTime: WORLD_TIME,
    factType: 'future_fact', subjectId: 'future', valueJson: '{}', sourceCommandId: 'unknown-command', visibility: 'world', supersedesId: null })

  const result = await rebuildProjection(fixture.db, 'home-world', 'home-main',
    await collectReplayInput(fixture.db, 'home-world', 'home-main'),
    await readCurrentProjection(fixture.db, 'home-world', 'home-main'))

  expect(result.status).toBe('unsupported')
  expect(result.differences).toContainEqual(expect.objectContaining({ kind: 'unsupported', commandId: 'unknown-command', version: 1 }))
})

it('compares projection domains independent of array order and storage ownership columns', () => {
  const rows = (timelineId: string) => ({ simTime: WORLD_TIME, states: [],
    schedules: [{ personId: 'resident', timelineId, worldDate: '2026-09-21', itemsJson: '[]', generatedAt: WORLD_TIME, createdVersion: null }],
    events: [], commitments: [], memories: [], dialogues: [], dialogueTurns: [], personaMessages: [], knowledge: [] })
  const expected = rows('root')
  const current = rows('child')
  expect(compareProjection(expected, current)).toEqual([])
  expect(compareProjection({ ...expected, simTime: '2026-09-21T09:00:00.000Z' }, current))
    .toEqual([expect.objectContaining({ domain: 'clock', kind: 'mismatch' })])
  expect(compareProjection({ ...expected, schedules: [] }, current)).toContainEqual(expect.objectContaining({
    domain: 'schedules', kind: 'extra', recordId: 'resident:2026-09-21', reasonCode: 'schedules_projection_extra',
  }))
  expect(compareProjection(expected, { ...current, schedules: [] })).toContainEqual(expect.objectContaining({
    domain: 'schedules', kind: 'missing', recordId: 'resident:2026-09-21', reasonCode: 'schedules_projection_missing',
  }))
})

it('reports missing, extra and mismatched records in every row projection domain', () => {
  const rowDomains = PROJECTION_DOMAINS.filter((domain): domain is Exclude<typeof domain, 'clock'> => domain !== 'clock')
  const recordFor = (domain: Exclude<typeof PROJECTION_DOMAINS[number], 'clock'>, marker: string) => domain === 'states'
    ? { personId: 'resident', timelineId: 'root', simTime: WORLD_TIME, location: marker, activity: 'Read', mood: 'Calm',
      goal: 'Learn', updatedRealAt: WORLD_TIME, currentDialogueId: null, lastBeatSimTime: null }
    : domain === 'schedules'
      ? { personId: 'resident', timelineId: 'root', worldDate: '2026-09-21', itemsJson: marker, generatedAt: WORLD_TIME, createdVersion: null }
      : { id: `${domain}-record`, timelineId: 'root', marker }
  const empty = () => ({ simTime: WORLD_TIME, states: [], schedules: [], events: [], commitments: [], memories: [],
    dialogues: [], dialogueTurns: [], personaMessages: [], knowledge: [] })

  for (const domain of rowDomains) {
    const expected = { ...empty(), [domain]: [recordFor(domain, 'expected')] }
    const missing = compareProjection(expected, empty())
    expect(missing, `${domain} missing`).toContainEqual(expect.objectContaining({
      domain, kind: 'missing', reasonCode: `${domain}_projection_missing`,
    }))

    const extra = compareProjection(empty(), { ...empty(), [domain]: [recordFor(domain, 'extra')] })
    expect(extra, `${domain} extra`).toContainEqual(expect.objectContaining({
      domain, kind: 'extra', reasonCode: `${domain}_projection_extra`,
    }))

    const mismatch = compareProjection(expected, { ...empty(), [domain]: [recordFor(domain, 'actual')] })
    expect(mismatch, `${domain} mismatch`).toContainEqual(expect.objectContaining({
      domain, kind: 'mismatch', reasonCode: `${domain}_projection_mismatch`,
    }))
  }
})

it('uses the timeline pinned model version when collecting baseline evidence', async () => {
  fixture = await createWorldFixture()
  const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [])
  await fixture.db.insert(worldModelVersions).values([
    { worldId: 'home-world', version: 1, createdAt: WORLD_TIME, modelJson: JSON.stringify({ projectionBaseline: null }) },
    { worldId: 'home-world', version: 2, createdAt: WORLD_TIME, modelJson: JSON.stringify({ projectionBaseline: baseline }) },
  ])
  await fixture.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME,
    worldModelVersion: 2, updatedAt: WORLD_TIME })

  const evidence = await collectReplayInput(fixture.db, 'home-world', 'home-main')
  expect(evidence.baseline?.completeDomains).toEqual([...PROJECTION_DOMAINS])
  expect(await fixture.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())
    .toMatchObject({ worldModelVersion: 2 })
})
