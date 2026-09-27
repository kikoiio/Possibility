import { afterEach, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { timelines, universeEvidence, universeRevisions, worldModelVersions } from '../db/schema'
import { PROJECTION_DOMAINS, createRootProjectionBaseline } from '../world-state/model'
import { assessAndUpgradeUniverse, classifyUniverse, planUniverseUpgrade } from '../world-state/classification'
import { migrateUniverseEvidence } from '../db/migrate-data'
import { createWorldFixture, WORLD_TIME } from './world-fixture'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

const model = (extra: Record<string, unknown> = {}) => ({
  name: 'Home world', description: 'A small town', locations: [], residents: [], ...extra,
})

async function pin(value: Record<string, unknown>) {
  await fixture!.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1,
    modelJson: JSON.stringify(value), createdAt: WORLD_TIME })
}

async function revision(timelineId: string) {
  await fixture!.db.insert(universeRevisions).values({ timelineId, version: 0, simTime: WORLD_TIME,
    worldModelVersion: 1, updatedAt: WORLD_TIME })
}

function checkpoint(sourceTimelineId: string, extra: Record<string, unknown> = {}) {
  return {
    version: 1, sourceTimelineId, sourceSimTime: WORLD_TIME, capturedAt: WORLD_TIME,
    ancestorCutoffs: [{ timelineId: sourceTimelineId, realTime: WORLD_TIME, simTime: WORLD_TIME }],
    states: [], schedules: [], memories: [], events: [], commitments: [],
    dialogues: [], dialogueTurns: [], personaMessages: [], worldFacts: [],
    historyComplete: true, sourceStateVersion: 0, worldModelVersion: 1,
    completeDomains: [...PROJECTION_DOMAINS], ...extra,
  }
}

it('classifies a fully replayable root as complete without changing evidence or projection rows', async () => {
  fixture = await createWorldFixture()
  await pin(model({ projectionBaseline: createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, []) }))
  await revision('home-main')
  const before = fixture.sqlite.serialize()

  await expect(classifyUniverse(fixture.db, 'home-world', 'home-main')).resolves.toMatchObject({
    level: 'complete', assessedVersion: 0, baselineVersion: 0, reasonCodes: ['replay_verified'],
  })
  expect(fixture.sqlite.serialize()).toEqual(before)
})

it('marks only a uniquely derivable legacy root baseline upgradeable', async () => {
  fixture = await createWorldFixture()
  await pin(model({ initialStates: { capturedAt: WORLD_TIME, states: [] },
    initialEvents: { timelineId: 'home-main', eventIds: [] } }))
  await revision('home-main')

  const result = await classifyUniverse(fixture.db, 'home-world', 'home-main')
  expect(result).toMatchObject({ level: 'upgradeable', baselineVersion: 0,
    reasonCodes: ['legacy_root_baseline_derivable'] })
  expect(result.upgradeBaseline?.completeDomains).toEqual([...PROJECTION_DOMAINS])
})

it('can recover a malformed root baseline only from complete immutable legacy evidence', async () => {
  fixture = await createWorldFixture()
  await pin(model({
    initialStates: { capturedAt: WORLD_TIME, states: [] },
    initialEvents: { timelineId: 'home-main', eventIds: [] },
    projectionBaseline: { source: 'root', version: 0, capturedAt: WORLD_TIME, simTime: WORLD_TIME,
      completeDomains: [...PROJECTION_DOMAINS], rows: { states: [], schedules: [], events: [], commitments: [],
        memories: [], dialogues: [], dialogueTurns: [], personaMessages: [] } },
  }))
  await revision('home-main')

  await expect(classifyUniverse(fixture.db, 'home-world', 'home-main')).resolves.toMatchObject({
    level: 'upgradeable', baselineVersion: 0, reasonCodes: ['legacy_root_baseline_derivable'],
  })
})

it('keeps ambiguous legacy roots incomplete instead of inventing event content', async () => {
  fixture = await createWorldFixture()
  await pin(model({ initialStates: { capturedAt: WORLD_TIME, states: [] },
    initialEvents: { timelineId: 'home-main', eventIds: ['unknown-event'] } }))
  await revision('home-main')

  await expect(classifyUniverse(fixture.db, 'home-world', 'home-main')).resolves.toMatchObject({
    level: 'incomplete', reasonCodes: ['legacy_root_initial_event_content_missing'],
  })
})

it('classifies root, child, and grandchild from each timeline own complete evidence', async () => {
  fixture = await createWorldFixture()
  await pin(model({ projectionBaseline: createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, []) }))
  await revision('home-main')
  await fixture.db.insert(timelines).values({
    id: 'child', worldId: 'home-world', parentTimelineId: 'home-main', simNow: WORLD_TIME,
    createdAt: WORLD_TIME, ancestorIdsJson: '["home-main"]', forkSnapshotJson: JSON.stringify(checkpoint('home-main')),
  })
  await revision('child')
  await fixture.db.insert(timelines).values({
    id: 'grandchild', worldId: 'home-world', parentTimelineId: 'child', simNow: WORLD_TIME,
    createdAt: WORLD_TIME, ancestorIdsJson: '["home-main","child"]', forkSnapshotJson: JSON.stringify(checkpoint('child')),
  })
  await revision('grandchild')

  for (const timelineId of ['home-main', 'child', 'grandchild']) {
    await expect(classifyUniverse(fixture.db, 'home-world', timelineId)).resolves.toMatchObject({ level: 'complete' })
  }
})

it('upgrades an explicit full legacy checkpoint but rejects a child with no checkpoint', async () => {
  fixture = await createWorldFixture()
  await pin(model({ projectionBaseline: createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, []) }))
  await revision('home-main')
  const { completeDomains: _domains, ...legacyCheckpoint } = checkpoint('home-main')
  await fixture.db.insert(timelines).values([
    { id: 'derivable-child', worldId: 'home-world', parentTimelineId: 'home-main', simNow: WORLD_TIME,
      createdAt: WORLD_TIME, ancestorIdsJson: '["home-main"]', forkSnapshotJson: JSON.stringify(legacyCheckpoint) },
    { id: 'missing-child', worldId: 'home-world', parentTimelineId: 'home-main', simNow: WORLD_TIME,
      createdAt: WORLD_TIME, ancestorIdsJson: '["home-main"]', forkSnapshotJson: null },
  ])
  await revision('derivable-child')
  await revision('missing-child')

  await expect(classifyUniverse(fixture.db, 'home-world', 'derivable-child')).resolves.toMatchObject({
    level: 'upgradeable', reasonCodes: ['legacy_fork_domains_derivable'],
  })
  await expect(classifyUniverse(fixture.db, 'home-world', 'missing-child')).resolves.toMatchObject({
    level: 'incomplete', reasonCodes: ['legacy_fork_checkpoint_missing_or_invalid'],
  })
  expect(await fixture.db.select().from(timelines).where(eq(timelines.id, 'missing-child')).get())
    .toMatchObject({ forkSnapshotJson: null })
})

it('writes the minimal root upgrade and complete evidence atomically and idempotently', async () => {
  fixture = await createWorldFixture()
  await pin(model({ initialStates: { capturedAt: WORLD_TIME, states: [] },
    initialEvents: { timelineId: 'home-main', eventIds: [] } }))
  await revision('home-main')

  const plan = await planUniverseUpgrade(fixture.db, 'home-world', 'home-main')
  expect(plan).toMatchObject({ kind: 'root_model_version', targetModelVersion: 2, source: {
    table: 'world_model_versions', id: 'home-world', version: 1,
  } })
  const first = await assessAndUpgradeUniverse(fixture.db, 'home-world', 'home-main', WORLD_TIME)
  expect(first).toMatchObject({ before: { level: 'upgradeable' }, after: { level: 'complete' } })
  const upgradedModel = await fixture.db.select().from(worldModelVersions)
    .where(eq(worldModelVersions.version, 2)).get()
  expect(JSON.parse(upgradedModel!.modelJson)).toMatchObject({
    initialStates: { capturedAt: WORLD_TIME, states: [] },
    projectionBaseline: { source: 'root', completeDomains: [...PROJECTION_DOMAINS] },
  })
  expect(await fixture.db.select().from(universeEvidence).where(eq(universeEvidence.timelineId, 'home-main')).get())
    .toMatchObject({ level: 'complete', assessedVersion: 0, baselineVersion: 0, assessedAt: WORLD_TIME })

  const second = await assessAndUpgradeUniverse(fixture.db, 'home-world', 'home-main', WORLD_TIME)
  expect(second).toMatchObject({ before: { level: 'complete' }, after: { level: 'complete' }, plan: null })
})

  it('rolls back both baseline and evidence when the evidence switch fails mid-upgrade', async () => {
    fixture = await createWorldFixture()
    await fixture.db.delete(universeEvidence).where(eq(universeEvidence.timelineId, 'home-main'))
  await pin(model({ initialStates: { capturedAt: WORLD_TIME, states: [] },
    initialEvents: { timelineId: 'home-main', eventIds: [] } }))
  await revision('home-main')
  const before = await fixture.db.select().from(worldModelVersions).all()
  fixture.sqlite.exec("CREATE TRIGGER reject_evidence BEFORE INSERT ON universe_evidence BEGIN SELECT RAISE(ABORT, 'forced evidence failure'); END")

  await expect(assessAndUpgradeUniverse(fixture.db, 'home-world', 'home-main', WORLD_TIME))
    .rejects.toThrow('forced evidence failure')
  expect(await fixture.db.select().from(worldModelVersions).all()).toEqual(before)
  expect(await fixture.db.select().from(universeEvidence).all()).toEqual([])
  await expect(classifyUniverse(fixture.db, 'home-world', 'home-main')).resolves.toMatchObject({ level: 'upgradeable' })
})

it('persists incomplete classifications without changing ambiguous source evidence', async () => {
  fixture = await createWorldFixture()
  await pin(model({ initialStates: { capturedAt: WORLD_TIME, states: [] },
    initialEvents: { timelineId: 'home-main', eventIds: ['unknown-event'] } }))
  await revision('home-main')
  const before = (await fixture.db.select().from(worldModelVersions).get())!.modelJson

  await expect(migrateUniverseEvidence(fixture.db, WORLD_TIME)).resolves.toEqual({
    assessed: 2, complete: 0, upgraded: 0, incomplete: 2,
  })
  expect((await fixture.db.select().from(worldModelVersions).get())!.modelJson).toBe(before)
  expect(await fixture.db.select().from(universeEvidence).where(eq(universeEvidence.timelineId, 'home-main')).get())
    .toMatchObject({ level: 'incomplete', reasonCodesJson: '["legacy_root_initial_event_content_missing"]' })
})
