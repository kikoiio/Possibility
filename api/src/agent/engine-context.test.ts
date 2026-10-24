import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { persons, timelines, universeRevisions, worldModelVersions, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { buildWorldSnapshot, currentScheduleItem, isAwake, type ScheduleItem } from './engine-context'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

const nightShift: ScheduleItem[] = [
  { start: '23:00', end: '07:00', location: 'Home', activity: 'Sleeping', kind: 'sleep' },
]

describe('schedule clock timezone', () => {
  it('interprets timeline instants in UTC, including offsets across midnight', () => {
    // 04:30 at +05:00 is 23:30 UTC on the prior date.
    expect(currentScheduleItem(nightShift, '2030-01-02T04:30:00+05:00')).toMatchObject({ kind: 'sleep' })
    expect(isAwake(nightShift, '2030-01-02T04:30:00+05:00')).toBe(false)
  })

  it('uses the same UTC clock for equivalent instants written with different offsets', () => {
    const utc = '2030-01-01T23:30:00Z'
    const offset = '2030-01-02T04:30:00+05:00'
    expect(currentScheduleItem(nightShift, utc)).toEqual(currentScheduleItem(nightShift, offset))
  })

  it('does not match a schedule for an invalid simulation timestamp', () => {
    expect(currentScheduleItem(nightShift, 'not-a-timestamp')).toBeNull()
    expect(isAwake(nightShift, 'not-a-timestamp')).toBe(true)
  })
})

describe('world snapshot person model provenance', () => {
  it('normalizes legacy row entries and keeps unknowns separate', async () => {
    fixture = await createWorldFixture()
    const rowModel = {
      identity: [
        { text: 'Creator supplied', provenance: 'known' },
        { text: 'Model inferred', provenance: 'inferred' },
        { text: 'Legacy item without a source' },
        { text: 'Invalid source', provenance: 'verified' },
      ],
      unknowns: ['  Unanswered question  ', '   ', 17],
    }
    await fixture.db.insert(persons).values({ id: 'ada', userId: 'owner', name: 'Ada',
      modelJson: JSON.stringify(rowModel), createdAt: WORLD_TIME })
    await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'ada', joinedAt: WORLD_TIME })

    const snapshot = await buildWorldSnapshot(fixture.db, 'home-world', 'home-main')
    const model = snapshot?.models.get('ada')
    expect(model?.identity).toEqual([
      { text: 'Creator supplied', provenance: 'known' },
      { text: 'Model inferred', provenance: 'inferred' },
      { text: 'Legacy item without a source', provenance: 'inferred' },
      { text: 'Invalid source', provenance: 'inferred' },
    ])
    expect(model?.unknowns).toEqual(['Unanswered question'])
    const modelLayerTexts = [model?.identity, model?.behavior, model?.speech, model?.skills,
      model?.memories, model?.relationships, model?.boundaries].flat().map(item => item?.text)
    expect(modelLayerTexts).not.toContain('Unanswered question')
  })

  it('normalizes the pinned model without changing its selected version or stored snapshot', async () => {
    fixture = await createWorldFixture()
    const currentRowModel = { identity: [{ text: 'Current editable row', provenance: 'known' }] }
    const pinnedModel = {
      identity: [
        { text: 'Pinned known', provenance: 'known' },
        { text: 'Pinned legacy item' },
        { text: 'Pinned invalid source', provenance: 'verified' },
      ],
      behavior: [{ text: 'Pinned inferred', provenance: 'inferred' }],
      unknowns: ['  Pinned unknown  ', ''],
    }
    await fixture.db.insert(persons).values({ id: 'ada', userId: 'owner', name: 'Editable Ada',
      modelJson: JSON.stringify(currentRowModel), createdAt: WORLD_TIME })
    await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'ada', joinedAt: WORLD_TIME })
    await fixture.db.insert(timelines).values({ id: 'home-pinned', worldId: 'home-world', simNow: WORLD_TIME,
      createdAt: WORLD_TIME })
    const pinnedJson = JSON.stringify({ name: 'Pinned world', description: 'Frozen world definition',
      locations: [{ name: 'Frozen place', description: '' }],
      residents: [{ id: 'ada', name: 'Pinned Ada', model: pinnedModel }] })
    await fixture.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 7,
      modelJson: pinnedJson, createdAt: WORLD_TIME })
    await fixture.db.insert(universeRevisions).values({ timelineId: 'home-pinned', version: 3,
      simTime: WORLD_TIME, worldModelVersion: 7, updatedAt: WORLD_TIME })
    const versionBefore = await fixture.db.select().from(worldModelVersions)
      .where(eq(worldModelVersions.worldId, 'home-world')).get()
    const revisionBefore = await fixture.db.select().from(universeRevisions)
      .where(eq(universeRevisions.timelineId, 'home-pinned')).get()

    const snapshot = await buildWorldSnapshot(fixture.db, 'home-world', 'home-pinned')
    const model = snapshot?.models.get('ada')
    expect(model?.identity).toEqual([
      { text: 'Pinned known', provenance: 'known' },
      { text: 'Pinned legacy item', provenance: 'inferred' },
      { text: 'Pinned invalid source', provenance: 'inferred' },
    ])
    expect(model?.behavior).toEqual([{ text: 'Pinned inferred', provenance: 'inferred' }])
    expect(model?.unknowns).toEqual(['Pinned unknown'])
    expect(snapshot?.persons.find(person => person.id === 'ada')?.name).toBe('Pinned Ada')
    expect(snapshot?.persons.find(person => person.id === 'ada')?.modelJson).toBe(JSON.stringify(currentRowModel))

    const versionAfter = await fixture.db.select().from(worldModelVersions)
      .where(eq(worldModelVersions.worldId, 'home-world')).get()
    const revisionAfter = await fixture.db.select().from(universeRevisions)
      .where(eq(universeRevisions.timelineId, 'home-pinned')).get()
    expect(versionAfter).toEqual(versionBefore)
    expect(versionAfter?.modelJson).toBe(pinnedJson)
    expect(revisionAfter).toEqual(revisionBefore)
    expect(snapshot?.stateVersion).toBe(3)
  })
})
