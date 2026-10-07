import { describe, expect, it } from 'vitest'
import type { worldCommands } from '../db/schema'
import { createRootProjectionBaseline } from './model'
import { reduceProjection } from './projector'
import { applyCoreCommands } from './core-replay'
import type { AnchorCorePayload } from './anchors'

type Command = typeof worldCommands.$inferSelect
const T0 = '2026-10-01T08:00:00.000Z'
const T1 = '2026-10-01T09:00:00.000Z'
const T2 = '2026-10-01T10:00:00.000Z'
const T3 = '2026-10-01T11:00:00.000Z'

let seq = 0
function cmd(type: string, action: Record<string, unknown>, createdAt = T0): Command {
  seq += 1
  return { id: `cmd${seq}`, worldId: 'w', timelineId: 'main', actorKind: 'system', actorId: null,
    type, payloadJson: JSON.stringify({ type, ...action }), expectedVersion: seq - 1,
    resultVersion: seq, tickLeaseToken: null, cloneSourceCommandId: null, createdAt }
}

const emptyCore: AnchorCorePayload = { version: 1, states: [], schedules: [], commitments: [] }

describe('applyCoreCommands 逐动作语义', () => {
  it('clock_advance 推进 simTime,倒退忽略', () => {
    const result = applyCoreCommands(emptyCore, [cmd('clock_advance', { from: T0, to: T1 }), cmd('clock_advance', { from: T0, to: T0 })], T0)
    expect(result.simTime).toBe(T1)
  })

  it('enter 建默认状态,move 改位置', () => {
    const result = applyCoreCommands(emptyCore, [
      cmd('enter', { personId: 'p1', to: '广场' }),
      cmd('move', { personId: 'p1', to: '茶馆' }),
    ], T0)
    expect(result.states).toHaveLength(1)
    expect(result.states[0]).toMatchObject({ personId: 'p1', location: '茶馆', activity: '刚来到这里' })
  })

  it('resident_state 应用白名单字段并推进 simTime', () => {
    const result = applyCoreCommands(emptyCore, [
      cmd('enter', { personId: 'p1', to: '广场' }),
      cmd('resident_state', { personId: 'p1', advanceTo: T1, patch: { mood: '开心', hacker: 'x' } }),
    ], T0)
    expect(result.states[0].mood).toBe('开心')
    expect((result.states[0] as Record<string, unknown>).hacker).toBeUndefined()
    expect(result.simTime).toBe(T1)
  })

  it('schedule_set 新增当日日程,重复跳过', () => {
    const items = [{ start: '08:00', end: '09:00', location: '家', activity: '早餐' }]
    const result = applyCoreCommands(emptyCore, [
      cmd('schedule_set', { personId: 'p1', worldDate: '2026-10-01', generatedAt: T0, items }),
      cmd('schedule_set', { personId: 'p1', worldDate: '2026-10-01', generatedAt: T1, items }),
    ], T0)
    expect(result.schedules).toHaveLength(1)
    expect(result.schedules[0].generatedAt).toBe(T0)
  })

  it('承诺:proposal 新增,commitment 转移状态', () => {
    const result = applyCoreCommands(emptyCore, [
      cmd('commitment_proposal', { commitmentId: 'c1', personId: 'p1', visitorId: 'v', sourceDialogueId: 'd1',
        title: '喝茶', kind: 'meeting', location: '茶馆', dueSim: T2 }),
      cmd('commitment', { commitmentId: 'c1', next: 'accepted' }),
    ], T0)
    expect(result.commitments).toHaveLength(1)
    expect(result.commitments[0]).toMatchObject({ id: 'c1', status: 'accepted' })
  })

  it('conversation 的 acceptedCommitments 以 scene visitorId 归属', () => {
    const result = applyCoreCommands(emptyCore, [
      cmd('scene_open', { dialogueId: 'd1', participantIds: ['p1', 'v'], location: '茶馆', turnLimit: 6, visitorId: 'v' }),
      cmd('conversation', { dialogueId: 'd1', requestId: 'r1', acceptedCommitments: [
        { id: 'c9', personId: 'p1', title: '帮忙', kind: 'help', location: '茶馆', dueSim: T2 }] }),
    ], T0)
    expect(result.commitments[0]).toMatchObject({ id: 'c9', status: 'accepted', visitorId: 'v', sourceDialogueId: 'd1' })
  })

  it('dialogue_start 挂上 currentDialogueId,达上限关闭并复位 lastBeatSimTime', () => {
    const result = applyCoreCommands(emptyCore, [
      cmd('enter', { personId: 'p1', to: '广场' }),
      cmd('enter', { personId: 'p2', to: '广场' }),
      cmd('clock_advance', { from: T0, to: T1 }),
      cmd('dialogue_start', { dialogueId: 'd1', participantIds: ['p1', 'p2'], location: '广场', turnLimit: 2 }),
      cmd('dialogue_turn', { dialogueId: 'd1', speakerId: 'p1', turnIndex: 0, utterance: 'hi' }),
      cmd('dialogue_turn', { dialogueId: 'd1', speakerId: 'p2', turnIndex: 1, utterance: 'hey' }),
    ], T0)
    expect(result.states.every((s) => s.currentDialogueId === null)).toBe(true)
    expect(result.states.every((s) => s.lastBeatSimTime === T1)).toBe(true)
  })

  it('畸形负载与非核心动作跳过不炸', () => {
    const bad = { ...cmd('enter', {}), payloadJson: '{broken' }
    const result = applyCoreCommands(emptyCore, [bad, cmd('memory_summary', { personId: 'p1' })], T0)
    expect(result.states).toHaveLength(0)
  })
})

describe('与全量回放的对照一致性', () => {
  it('混合命令序列:核心三域 + simTime 与 reduceProjection 一致', () => {
    seq = 0
    const commands = [
      cmd('enter', { personId: 'p1', to: '广场' }, T0),
      cmd('enter', { personId: 'p2', to: '广场' }, T0),
      cmd('clock_advance', { from: T0, to: T1 }, T1),
      cmd('resident_state', { personId: 'p1', advanceTo: T1, patch: { mood: '期待' } }, T1),
      cmd('schedule_set', { personId: 'p1', worldDate: '2026-10-01', generatedAt: T1, items: [{ start: '10:00' }] }, T1),
      cmd('scene_open', { dialogueId: 'd0', participantIds: ['p1', 'p2'], location: '广场', turnLimit: 6, visitorId: 'p2' }, T1),
      cmd('commitment_proposal', { commitmentId: 'c1', personId: 'p1', visitorId: 'p2', sourceDialogueId: 'd0',
        title: '喝茶', kind: 'meeting', location: '茶馆', dueSim: T3 }, T1),
      cmd('commitment', { commitmentId: 'c1', next: 'accepted' }, T1),
      cmd('dialogue_start', { dialogueId: 'd1', participantIds: ['p1', 'p2'], location: '广场', turnLimit: 2 }, T1),
      cmd('dialogue_turn', { dialogueId: 'd1', speakerId: 'p1', turnIndex: 0, utterance: 'hi', thought: 't' }, T1),
      cmd('dialogue_turn', { dialogueId: 'd1', speakerId: 'p2', turnIndex: 1, utterance: 'hey', thought: 't' }, T1),
      cmd('clock_advance', { from: T1, to: T2 }, T2),
      cmd('move', { personId: 'p2', to: '书店' }, T2),
      cmd('memory_summary', { personId: 'p1', sourceMemoryIds: ['x'], summaryId: 's1' }, T2),
    ]
    const baseline = createRootProjectionBaseline(T0, T0, [])
    const full = reduceProjection({ worldId: 'w', timelineId: 'main', baseline, commands, facts: [], throughVersion: commands.length })
    expect(full.projection).not.toBeNull()
    const mini = applyCoreCommands(emptyCore, commands, T0)
    const projection = full.projection!
    expect(mini.simTime).toBe(projection.simTime)
    // Projection domains are sets of records; SQL/replay insertion order is not semantic.
    const key = (rows: unknown[]) => JSON.stringify(rows.map(row => JSON.stringify(row)).sort())
    expect(key(mini.states)).toBe(key(projection.states))
    expect(key(mini.schedules)).toBe(key(projection.schedules))
    expect(key(mini.commitments)).toBe(key(projection.commitments))
  })
})
