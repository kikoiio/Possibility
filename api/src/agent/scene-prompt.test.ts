import { describe, expect, it } from 'vitest'
import { buildScenePrompt } from './engine-prompt'
import { buildUserPersonaModel } from '../persona/routes'
import type { EngineContext } from './engine-context'

/** 构造一个最小可用的 EngineContext（仅 scene prompt 用到的字段） */
function fakeCtx(): EngineContext {
  return {
    person: { id: 'p1', userId: 'u1', name: '雾野 透', modelJson: '{}', isUser: false, createdAt: '' },
    model: {
      identity: [{ text: '四处游历的记者', provenance: 'known' }],
      behavior: [],
      speech: [],
      skills: [],
      memories: [],
      relationships: [],
      boundaries: [],
      unknowns: [],
    },
    state: {
      personId: 'p1',
      timelineId: 't1',
      simTime: '2026-09-17T12:00:00Z',
      location: '图书室',
      activity: '翻旧报',
      mood: '警觉',
      goal: '查三十年前的案子',
      updatedRealAt: '',
      currentDialogueId: null,
      lastBeatSimTime: null,
    },
    snapshot: {
      world: {
        id: 'w1',
        userId: 'u1',
        name: '雾影庄',
        description: '山间温泉小镇',
        locationsJson: '[]',
        status: 'running',
        pauseReason: null,
        isDemo: false,
        callsToday: 0,
        callsDay: null,
        lastUserActivityAt: null,
        createdAt: '',
      },
      locations: [],
      timeline: {
        id: 't1',
        worldId: 'w1',
        parentTimelineId: null,
        forkScenarioJson: null,
        simNow: '2026-09-17T12:00:00Z',
        createdAt: '',
        status: 'active',
        ancestorIdsJson: '[]',
        lastRealTickAt: null,
        forkSnapshotJson: null,
      },
      persons: [],
      models: new Map(),
      states: new Map(),
      schedules: new Map(),
      worldDate: '2026-09-17',
    },
    others: [],
    memories: [],
    unperceivedEvents: [],
    sameLocationAwake: [],
    scheduleItems: null,
  }
}

describe('buildScenePrompt（你在世界里：到场交谈提示）', () => {
  it('包含来访者身份、地点与对话记录，且禁止点破第四面墙', () => {
    const { system } = buildScenePrompt(
      fakeCtx(),
      { name: '阿透', profile: '一位来泡汤的旅人' },
      '图书室',
      [{ personName: '阿透', utterance: '这屋里的旧报，能让我翻翻吗？' }],
    )
    expect(system).toContain('阿透')
    expect(system).toContain('一位来泡汤的旅人')
    expect(system).toContain('图书室')
    expect(system).toContain('阿透：这屋里的旧报，能让我翻翻吗？')
    expect(system).toContain('第四面墙')
    expect(system).toContain('memory')
  })
})

describe('buildUserPersonaModel（在场身份模型）', () => {
  it('身份即用户自述，其余留白', () => {
    const model = buildUserPersonaModel('一位来泡汤的旅人')
    expect(model.identity).toEqual([{ text: '一位来泡汤的旅人', provenance: 'known' }])
    expect(model.behavior).toEqual([])
    expect(model.memories).toEqual([])
  })
})
