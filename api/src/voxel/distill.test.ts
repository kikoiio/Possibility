import { describe, expect, it } from 'vitest'
import { distillVoxelEvents, mapEventType, scoreImportance, type DistillInput, type DistillSourceEvent } from './distill'

const AT = { x: 10, y: 2, z: 20 }

function input(overrides: Partial<DistillInput> = {}): DistillInput {
  return {
    events: [],
    dialogues: [],
    actorLocation: () => '庭院',
    resolveLocation: (name) => (name === '庭院' ? AT : null),
    ...overrides,
  }
}

function ev(overrides: Partial<DistillSourceEvent>): DistillSourceEvent {
  return {
    id: 'e1',
    simTime: '2026-10-15T10:00:00.000Z',
    kind: 'action',
    title: '在庭院打扫',
    description: '把落叶归到墙角',
    actorPersonId: 'p-a',
    dialogueId: null,
    ...overrides,
  }
}

describe('distillVoxelEvents', () => {
  it('空输入 → 空产出', () => {
    expect(distillVoxelEvents(input())).toEqual({ distilled: [], skipped: 0 })
  })

  it('单事件 → 单簇,最小时间窗 30 分钟,模板文案确定', () => {
    const { distilled, skipped } = distillVoxelEvents(input({ events: [ev({})] }))
    expect(skipped).toBe(0)
    expect(distilled).toHaveLength(1)
    const { event, sourceEventIds } = distilled[0]
    expect(sourceEventIds).toEqual(['e1'])
    expect(event.at).toEqual(AT)
    expect(event.importance).toBe('low')
    expect(event.type).toBe('daily')
    expect(event.timeWindow.start).toBe('2026-10-15T10:00:00.000Z')
    expect(Date.parse(event.timeWindow.end) - Date.parse(event.timeWindow.start)).toBe(30 * 60 * 1000)
    expect(event.label).toBe('在庭院打')
    expect(event.teaser).toContain('在庭院打扫')
    expect(event.scene).toContain('把落叶归到墙角')
    expect(event.participants).toEqual(['p-a'])
  })

  it('同参与者同地点同时间桶的多个动作聚为一簇;跨桶/跨日分簇', () => {
    const { distilled } = distillVoxelEvents(input({
      events: [
        ev({ id: 'e1', simTime: '2026-10-15T10:00:00.000Z' }),
        ev({ id: 'e2', simTime: '2026-10-15T11:00:00.000Z', title: '在庭院浇花' }),
        // 次日同时刻:时间桶不同 → 另一簇
        ev({ id: 'e3', simTime: '2026-10-16T10:30:00.000Z', title: '在庭院打扫' }),
      ],
    }))
    expect(distilled).toHaveLength(2)
    expect(distilled[0].sourceEventIds).toEqual(['e1', 'e2'])
    expect(distilled[0].event.timeWindow.end).toBe('2026-10-15T11:00:00.000Z')
    expect(distilled[1].sourceEventIds).toEqual(['e3'])
  })

  it('对话事件按 dialogueId 聚簇:参与者/轮数驱动 importance 与文案', () => {
    const { distilled } = distillVoxelEvents(input({
      events: [
        ev({ id: 'e1', kind: 'dialogue', dialogueId: 'd1', title: '三人聊起秋收', actorPersonId: 'p-a', simTime: '2026-10-15T14:00:00.000Z' }),
        ev({ id: 'e2', kind: 'dialogue', dialogueId: 'd1', title: '三人聊起秋收', actorPersonId: 'p-b', simTime: '2026-10-15T14:03:00.000Z' }),
        ev({ id: 'e3', kind: 'dialogue', dialogueId: 'd1', title: '三人聊起秋收', actorPersonId: 'p-c', simTime: '2026-10-15T14:06:00.000Z' }),
        ev({ id: 'e4', kind: 'dialogue', dialogueId: 'd1', title: '三人聊起秋收', actorPersonId: 'p-a', simTime: '2026-10-15T14:09:00.000Z' }),
      ],
      dialogues: [{ id: 'd1', location: '庭院', participantIds: ['p-a', 'p-b', 'p-c'] }],
    }))
    expect(distilled).toHaveLength(1)
    const { event, sourceEventIds } = distilled[0]
    expect(sourceEventIds).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(event.importance).toBe('high') // 3 参与者(+2) + 4 轮(+2)
    expect(event.type).toBe('celebration') // ≥3 人且 high
    expect(event.label).toBe('交谈')
    expect(event.participants).toEqual(['p-a', 'p-b', 'p-c'])
    expect(event.timeWindow.end).toBe('2026-10-15T14:30:00.000Z') // 窗长不足 30 分钟按最小窗补齐
  })

  it('注入事件 → turning 且 importance 加权;与同时同地的反应动作同簇', () => {
    const { distilled } = distillVoxelEvents(input({
      events: [
        ev({ id: 'e1', kind: 'injected', title: '暴雨突至', actorPersonId: 'p-a' }),
        ev({ id: 'e2', kind: 'action', title: '收衣服', actorPersonId: 'p-a', simTime: '2026-10-15T10:20:00.000Z' }),
      ],
    }))
    // 同参与者同地点同时间桶 → 一簇;注入 +2 权重 → medium
    expect(distilled).toHaveLength(1)
    const injected = distilled[0]
    expect(injected.sourceEventIds).toEqual(['e1', 'e2'])
    expect(injected.event.type).toBe('turning')
    expect(injected.event.importance).toBe('medium')
    expect(injected.event.label).toBe('变故')
  })

  it('无行动者的注入事件无法锚定 → 跳过(诚实计数,不冒充位置)', () => {
    const { distilled, skipped } = distillVoxelEvents(input({
      events: [ev({ id: 'e1', kind: 'injected', title: '暴雨突至', actorPersonId: null })],
    }))
    expect(distilled).toHaveLength(0)
    expect(skipped).toBe(1)
  })

  it('system 事件不进蒸馏;地点无法锚定的簇跳过并计数', () => {
    const { distilled, skipped } = distillVoxelEvents(input({
      events: [
        ev({ id: 'e0', kind: 'system', title: '时钟推进', actorPersonId: null }),
        ev({ id: 'e1', actorPersonId: 'p-a' }),
        ev({ id: 'e2', actorPersonId: 'p-b' }),
      ],
      actorLocation: (id) => (id === 'p-a' ? '庭院' : '虚空'),
    }))
    expect(distilled).toHaveLength(1)
    expect(distilled[0].sourceEventIds).toEqual(['e1'])
    expect(skipped).toBe(1) // e2 地点「虚空」无法解析;e0 system 不计入跳过
  })

  it('同一输入恒得同一输出(确定性)', () => {
    const base = input({
      events: [ev({ id: 'e2' }), ev({ id: 'e1', simTime: '2026-10-15T09:00:00.000Z' })],
    })
    const a = distillVoxelEvents(base)
    const b = distillVoxelEvents(base)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('scoreImportance / mapEventType 边界', () => {
  it('双人短对话 → medium;单人日常 → low', () => {
    expect(scoreImportance({ participantIds: ['a', 'b'], dialogueTurns: 2, hasInjected: false, events: [{}] as never })).toBe('medium')
    expect(scoreImportance({ participantIds: ['a'], dialogueTurns: 0, hasInjected: false, events: [{}] as never })).toBe('low')
  })

  it('多人但未到 high → daily(不冒充庆典)', () => {
    expect(mapEventType({ participantIds: ['a', 'b', 'c'], hasInjected: false }, 'medium')).toBe('daily')
    expect(mapEventType({ participantIds: ['a', 'b', 'c'], hasInjected: false }, 'high')).toBe('celebration')
  })
})
