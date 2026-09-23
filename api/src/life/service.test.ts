import { afterEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createTestDb } from '../test/db'
import { commitments, dialogues, events, memories, persons, personStates, timelines, users, worldFacts, worldPersons, worlds } from '../db/schema'
import { advanceCommitments, nextCommitmentStatus, parseInvitation, proposeCommitment, statusLabels } from './service'

describe('持续生活约定', () => {
  it('只接受结构完整且在合理时间窗内的邀请', () => {
    expect(parseInvitation({ title: '晚饭', kind: 'meeting', location: '厨房', dueInMinutes: 90 })).toEqual({ title: '晚饭', kind: 'meeting', location: '厨房', dueInMinutes: 90 })
    expect(parseInvitation({ title: '现在就来', kind: 'meeting', location: '厨房', dueInMinutes: 1 })).toBeNull()
    expect(parseInvitation({ title: '帮忙', kind: 'other', location: '厨房', dueInMinutes: 90 })).toBeNull()
  })
  it('状态流转拒绝隐式承诺和重复后果', () => {
    expect(nextCommitmentStatus('proposed', 'accept')).toBe('accepted')
    expect(nextCommitmentStatus('proposed', 'decline')).toBe('declined')
    expect(nextCommitmentStatus('accepted', 'fulfill')).toBe('fulfilled')
    expect(nextCommitmentStatus('fulfilled', 'fulfill')).toBeNull()
    expect(statusLabels.missed).toBe('未能赴约')
  })

  it('到期处理是可重复的机械事实，并留下事件与人物记忆', async () => {
    const f = createTestDb()
    try {
      const now = '2026-09-20T12:00:00.000Z'
      await f.db.insert(users).values({ id: 'u', username: 'u', passwordHash: 'x', createdAt: now })
      await f.db.insert(worlds).values({ id: 'w', userId: 'u', name: 'W', description: '', status: 'running' })
      await f.db.insert(timelines).values({ id: 't', worldId: 'w', simNow: now, createdAt: now })
      await f.db.insert(persons).values([
        { id: 'npc', userId: 'u', name: '小夜', modelJson: '{}', createdAt: now },
        { id: 'visitor', userId: 'u', name: '阿透', modelJson: '{}', createdAt: now, isUser: true },
      ])
      await f.db.insert(worldPersons).values([{ worldId: 'w', personId: 'npc', joinedAt: now }, { worldId: 'w', personId: 'visitor', joinedAt: now }])
      await f.db.insert(personStates).values({ personId: 'npc', timelineId: 't', simTime: now, location: '厨房', activity: '等候', mood: '平静', goal: '等人', updatedRealAt: now })
      await f.db.insert(commitments).values({ id: 'c', worldId: 'w', timelineId: 't', personId: 'npc', visitorId: 'visitor', title: '晚饭', kind: 'meeting', location: '厨房', dueSim: '2026-09-20T11:00:00.000Z', status: 'accepted', createdSim: now, updatedSim: now, createdAt: now })
      await advanceCommitments(f.db, 't', now)
      await advanceCommitments(f.db, 't', now)
      expect((await f.db.select().from(commitments).where(eq(commitments.id, 'c')).get())?.status).toBe('missed')
      expect((await f.db.select().from(events).all()).filter(e => e.id === 'commitment:c:missed')).toHaveLength(1)
      expect((await f.db.select().from(memories).all()).filter(m => m.id === 'commitment:c:missed:memory')).toHaveLength(1)
    } finally { f.close() }
  })

  it('把居民提出的邀请与 proposal 记录作为一个版本化事实提交', async () => {
    const f = createTestDb()
    try {
      const now = '2026-09-20T12:00:00.000Z'
      await f.db.insert(users).values({ id: 'u', username: 'u', passwordHash: 'x', createdAt: now })
      await f.db.insert(worlds).values({ id: 'w', userId: 'u', name: 'W', description: '', status: 'running',
        locationsJson: JSON.stringify([{ name: '厨房', description: '' }]) })
      await f.db.insert(timelines).values({ id: 't', worldId: 'w', simNow: now, createdAt: now })
      await f.db.insert(persons).values([
        { id: 'npc', userId: 'u', name: '小夜', modelJson: '{}', createdAt: now },
        { id: 'visitor', userId: 'u', name: '阿透', modelJson: '{}', createdAt: now, isUser: true },
      ])
      await f.db.insert(worldPersons).values([{ worldId: 'w', personId: 'npc', joinedAt: now }, { worldId: 'w', personId: 'visitor', joinedAt: now }])
      await f.db.insert(dialogues).values({ id: 'scene-1', timelineId: 't', location: '厨房', participantIdsJson: JSON.stringify(['visitor', 'npc']),
        status: 'scene', kind: 'scene', visitorId: 'visitor', turnLimit: 100, simStart: now })
      const proposal = { id: 'proposal-1', worldId: 'w', timelineId: 't', personId: 'npc', visitorId: 'visitor', sourceDialogueId: 'scene-1',
        simNow: now, raw: { title: '晚饭后散步', kind: 'meeting', location: '厨房', dueInMinutes: 90 }, locations: [{ name: '厨房' }] }
      await proposeCommitment(f.db, proposal)
      await proposeCommitment(f.db, proposal)
      expect(await f.db.select().from(commitments).all()).toHaveLength(1)
      expect((await f.db.select().from(commitments).where(eq(commitments.id, 'proposal-1')).get())?.status).toBe('proposed')
      const fact = (await f.db.select().from(worldFacts).where(eq(worldFacts.factType, 'commitment')).get())!
      expect(JSON.parse(fact.valueJson)).toMatchObject({ commitmentId: 'proposal-1', from: null, to: 'proposed', title: '晚饭后散步' })
      expect(await f.db.select().from(events).all()).toHaveLength(1)
      expect(fact.version).toBe(1)
    } finally { f.close() }
  })
})
