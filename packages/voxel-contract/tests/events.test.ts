import { describe, expect, it } from 'vitest'
import {
  assertWorldEvent, deserialize, resolveEventDisclosure, serialize, VoxelDeserializeError,
  type DisclosureTier, type WorldEvent,
} from '../src'
import { createEmptyWorld } from '../src'

const at = (x: number, y: number, z: number) => ({ x, y, z })

function sampleEvent(overrides: Partial<WorldEvent> = {}): WorldEvent {
  return {
    id: 'evt-wedding',
    type: 'celebration',
    at: at(12, 3, 20),
    importance: 'high',
    timeWindow: { start: '2026-10-15T16:00:00Z', end: '2026-10-15T20:00:00Z' },
    label: '婚礼',
    teaser: '艾拉与芬恩在钟楼广场许下誓言',
    scene: '钟声敲响四下,艾拉与芬恩在广场中央交换誓言。灯笼次第亮起,居民们围成一圈……',
    participants: ['person-ella', 'person-finn'],
    relatedAssetIds: ['pl-bell-tower'],
    ...overrides,
  }
}

const BEFORE = '2026-10-15T15:00:00Z'
const DURING = '2026-10-15T17:00:00Z'
const AFTER = '2026-10-15T21:00:00Z'

describe('resolveEventDisclosure(裁决矩阵,F4/F5/F7)', () => {
  const tiers: DisclosureTier[] = ['overview', 'district', 'close']

  it('窗内 active:district/close → teaser;overview 仅 high → icon(F7)', () => {
    for (const tier of tiers) {
      const high = resolveEventDisclosure(sampleEvent(), DURING, tier)
      const low = resolveEventDisclosure(sampleEvent({ importance: 'low' }), DURING, tier)
      expect(high.phase).toBe('active')
      if (tier === 'overview') {
        expect(high.level).toBe('icon')
        expect(low.level).toBe('none')
      } else {
        expect(high.level).toBe('teaser')
        expect(low.level).toBe('teaser')
      }
    }
  })

  it('窗前 hidden(防剧透),任意 tier 皆 none', () => {
    for (const tier of tiers) {
      expect(resolveEventDisclosure(sampleEvent(), BEFORE, tier)).toEqual(
        { eventId: 'evt-wedding', phase: 'hidden', level: 'none' })
    }
  })

  it('窗后 trace(留痕),任意 tier 恒 icon', () => {
    for (const tier of tiers) {
      expect(resolveEventDisclosure(sampleEvent(), AFTER, tier)).toEqual(
        { eventId: 'evt-wedding', phase: 'trace', level: 'icon' })
    }
  })

  it('边界:恰在 start/end 算窗内;simNow 不可解析按 hidden 防御', () => {
    expect(resolveEventDisclosure(sampleEvent(), '2026-10-15T16:00:00Z', 'district').phase).toBe('active')
    expect(resolveEventDisclosure(sampleEvent(), '2026-10-15T20:00:00Z', 'district').phase).toBe('active')
    expect(resolveEventDisclosure(sampleEvent(), 'not-a-date', 'close').phase).toBe('hidden')
  })
})

describe('assertWorldEvent(形状校验)', () => {
  const throws = (raw: unknown, index = 0): string => {
    try {
      assertWorldEvent(raw, index, (c, reason) => { if (!c) throw new VoxelDeserializeError(reason as string) })
      return ''
    } catch (e) {
      return (e as Error).message
    }
  }

  it('合法事件通过(含可选字段缺省)', () => {
    expect(throws(sampleEvent())).toBe('')
    expect(throws(sampleEvent({ participants: undefined, relatedAssetIds: undefined }))).toBe('')
  })

  it('非法形状抛错且消息带 events[i] 定位', () => {
    expect(throws(null)).toContain('events[0]')
    expect(throws(sampleEvent({ label: '' }))).toContain('events[0].label')
    expect(throws(sampleEvent({ type: 'party' as never }))).toContain('events[0].type')
    expect(throws(sampleEvent({ importance: 'huge' as never }))).toContain('events[0].importance')
    expect(throws(sampleEvent({ at: { x: 1.5, y: 2, z: 3 } }))).toContain('events[0].at')
    expect(throws(sampleEvent({ timeWindow: { start: '2026-10-15T20:00:00Z', end: '2026-10-15T16:00:00Z' } })))
      .toContain('events[0].timeWindow')
    expect(throws(sampleEvent({ timeWindow: { start: 'x', end: 'y' } }))).toContain('events[0].timeWindow')
    expect(throws(sampleEvent({ participants: [42] as never }))).toContain('events[0].participants')
  })
})

describe('events 信封持久化(F2, N1)', () => {
  it('含 events 文档往返逐字段无损', () => {
    const doc = createEmptyWorld({ width: 16, height: 8, depth: 16 }, 'mist-manor', 'evt-world')
    doc.events = [sampleEvent(), sampleEvent({ id: 'evt-fire', type: 'turning', importance: 'medium' })]
    const restored = deserialize(serialize(doc))
    expect(restored.events).toEqual(doc.events)
  })

  it('无 events 字段的旧 JSON 反序列化为 undefined', () => {
    const doc = createEmptyWorld({ width: 16, height: 8, depth: 16 }, 'mist-manor', 'legacy')
    const raw = serialize(doc)
    expect(raw).not.toContain('"events"')
    expect(deserialize(raw).events).toBeUndefined()
  })

  it('坏事件数据抛 VoxelDeserializeError 且带定位', () => {
    const doc = createEmptyWorld({ width: 16, height: 8, depth: 16 }, 'mist-manor', 'bad')
    const raw = serialize(doc)
    const parsed = JSON.parse(raw) as Record<string, unknown>
    parsed.events = [{ ...sampleEvent(), scene: '' }]
    expect(() => deserialize(JSON.stringify(parsed))).toThrow(VoxelDeserializeError)
    expect(() => deserialize(JSON.stringify(parsed))).toThrow(/events\[0\]\.scene/)
  })
})
