import { afterEach, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { commitments, memories, persons, personStates, timelines, universeRevisions, worldFacts, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { ensureUniverseRevision } from '../world-state/model'
import { commitWorldCommand } from '../world-state/commit'
import { proposeCommitment } from './service'
import { auditUniverse } from '../world-state/invariants'

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => { fixture?.close(); fixture = null })

it('completes an invited meeting through acceptance, arrival-window refusal, attendance, and fulfillment', async () => {
  fixture = await createWorldFixture()
  const f = fixture
  const model = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] })
  await f.db.insert(persons).values({ id: 'meeting-resident', userId: 'owner', name: 'Mina', modelJson: model, createdAt: WORLD_TIME })
  await f.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'meeting-resident', joinedAt: WORLD_TIME })
  await f.db.insert(personStates).values({ personId: 'meeting-resident', timelineId: 'home-main', simTime: WORLD_TIME,
    location: 'Cafe', activity: 'Waiting for a visitor', mood: 'Calm', goal: 'Meet a friend', updatedRealAt: WORLD_TIME })
  await ensureUniverseRevision(f.db, 'home-world', 'home-main')

  const headers = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }
  const personaResponse = await app.request('/api/worlds/home-world/persona', { method: 'POST', headers,
    body: JSON.stringify({ name: 'Traveler', description: 'A visitor who keeps appointments.' }) }, f.env)
  const { persona } = await personaResponse.json() as { persona: { id: string } }
  expect(personaResponse.status).toBe(200)
  const entry = await app.request('/api/worlds/home-world/scene/position', { method: 'POST', headers,
    body: JSON.stringify({ timelineId: 'home-main', commandId: 'meeting-visitor-entry', expectedVersion: 0, location: 'Cafe' }) }, f.env)
  expect(entry.status).toBe(200)
  await commitWorldCommand(f.db, { id: 'meeting-scene-open', worldId: 'home-world', timelineId: 'home-main', userId: 'owner',
    actorKind: 'visitor', actorPersonId: persona.id, expectedVersion: 1,
    action: { type: 'scene_open', dialogueId: 'meeting-scene', visitorId: persona.id,
      participantIds: [persona.id, 'meeting-resident'], location: 'Cafe', turnLimit: 100 } })

  await proposeCommitment(f.db, { id: 'visitor-meeting', worldId: 'home-world', timelineId: 'home-main',
    personId: 'meeting-resident', visitorId: persona.id, sourceDialogueId: 'meeting-scene', simNow: WORLD_TIME,
    raw: { title: 'Meet at the cafe', kind: 'meeting', location: 'Cafe', dueInMinutes: 60 },
    locations: [{ name: 'Cafe' }, { name: 'Library' }] })
  const proposal = (await f.db.select().from(commitments).where(eq(commitments.id, 'visitor-meeting')).get())!
  expect(proposal.status).toBe('proposed')

  const commitmentUrl = '/api/worlds/home-world/commitments/visitor-meeting?timelineId=home-main'
  const accept = await app.request(commitmentUrl, { method: 'POST', headers, body: JSON.stringify({ action: 'accept' }) }, f.env)
  expect(await accept.json()).toMatchObject({ ok: true, status: 'accepted' })
  const acceptedVersion = (await f.db.select().from(universeRevisions).where(eq(universeRevisions.timelineId, 'home-main')).get())!.version

  const advance = async (id: string, to: string, version: number) => {
    const current = (await f.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())!.simNow
    return commitWorldCommand(f.db, { id, worldId: 'home-world', timelineId: 'home-main', userId: 'owner', actorKind: 'system',
      expectedVersion: version,
      action: { type: 'clock_advance', from: current, to, observedAt: to } })
  }
  await advance('meeting-clock-early', '2026-09-21T08:20:00.000Z', acceptedVersion)
  const tooEarly = await app.request(commitmentUrl, { method: 'POST', headers, body: JSON.stringify({ action: 'fulfill' }) }, f.env)
  expect(tooEarly.status).toBe(409)
  expect((await f.db.select().from(commitments).where(eq(commitments.id, 'visitor-meeting')).get())?.status).toBe('accepted')

  await advance('meeting-clock-window', '2026-09-21T08:50:00.000Z', acceptedVersion + 1)
  const fulfill = await app.request(commitmentUrl, { method: 'POST', headers, body: JSON.stringify({ action: 'fulfill' }) }, f.env)
  expect(await fulfill.json()).toMatchObject({ ok: true, status: 'fulfilled' })
  const replay = await app.request(commitmentUrl, { method: 'POST', headers, body: JSON.stringify({ action: 'fulfill' }) }, f.env)
  expect(await replay.json()).toMatchObject({ ok: true, status: 'fulfilled' })

  const status = (await f.db.select().from(commitments).where(eq(commitments.id, 'visitor-meeting')).get())!
  expect(status.status).toBe('fulfilled')
  expect((await f.db.select().from(personStates).where(eq(personStates.personId, 'meeting-resident')).get())?.mood)
    .toContain('守约')
  expect(await f.db.select().from(memories).where(eq(memories.id, 'commitment:visitor-meeting:fulfilled:memory')).get()).toBeDefined()
  expect(await f.db.select().from(worldFacts).where(eq(worldFacts.factType, 'commitment')).all()).toHaveLength(3)

  const returnView = await app.request('/api/worlds/home-world/return?timelineId=home-main', { headers }, f.env)
  expect(await returnView.json()).toMatchObject({ commitments: [expect.objectContaining({ id: 'visitor-meeting', status: 'fulfilled' })] })
  expect(await auditUniverse(f.db, 'home-world', 'home-main')).toEqual([])
})
