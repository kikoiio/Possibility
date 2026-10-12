import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { persons, worldPersons } from '../db/schema'
import { commitWorldCommand } from '../world-state/commit'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'

describe('message provenance routes', () => {
  let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
  afterEach(() => fixture?.close())

  it('returns stable receipts and preserves conflicting unverified accounts', async () => {
    fixture = await createWorldFixture()
    await fixture.db.insert(persons).values({ id: 'resident', userId: 'owner', name: '居民', modelJson: '{}', createdAt: WORLD_TIME })
    await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident', joinedAt: WORLD_TIME })
    const first = await commitWorldCommand(fixture.db, { id: 'inform-one', worldId: 'home-world', timelineId: 'home-main', userId: 'owner', expectedVersion: 0,
      action: { type: 'inform', recipientId: 'resident', topic: '钥匙位置', content: '钥匙在钟楼' } })
    await commitWorldCommand(fixture.db, { id: 'inform-two', worldId: 'home-world', timelineId: 'home-main', userId: 'owner', expectedVersion: first.version,
      action: { type: 'inform', recipientId: 'resident', topic: '钥匙位置', content: '钥匙在花园' } })
    const headers = { Authorization: 'Bearer owner-token' }
    const receipt = await app.request('/api/worlds/home-world/provenance/receipts/inform-one?timelineId=home-main&residentId=resident', { headers }, fixture.env)
    expect(receipt.status).toBe(200)
    const receiptBody = await receipt.json() as { status: string; receipt?: { receiptId: string; content: string } }
    expect(receiptBody).toMatchObject({ status: 'committed', receipt: { receiptId: `receipt:${first.factId}`, content: '钥匙在钟楼' } })
    const missing = await app.request('/api/worlds/home-world/provenance/receipts/does-not-exist?timelineId=home-main&residentId=resident', { headers }, fixture.env)
    expect(await missing.json()).toEqual({ status: 'not_found' })
    const evidence = await app.request('/api/worlds/home-world/provenance/evidence?timelineId=home-main&residentId=resident&limit=50', { headers }, fixture.env)
    expect(evidence.status).toBe(200)
    const body = await evidence.json() as { records: { content: string }[]; groups: { relation: string; evidenceIds: string[] }[] }
    expect(body.records.map(record => record.content)).toEqual(['钥匙在钟楼', '钥匙在花园'])
    expect(body.groups).toEqual([expect.objectContaining({ relation: 'documented_conflict', evidenceIds: expect.arrayContaining([first.factId]) })])
  })
})
