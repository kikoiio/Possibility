import { describe, expect, it } from 'vitest'
import { normalizeBeatJson } from './beat'
import { normalizeDialogueJson } from './dialogue'
import { parseMemoryAnnotations } from './annotations'

const LOCS = ['Cafe', 'Library']
const PEOPLE = [{ id: 'bo', name: 'Bo' }, { id: 'ada-lo', name: '张三丰' }]

function beatRaw(memory: unknown) {
  return {
    events: [{ title: '事', description: '发生了一些事', offsetMin: 0 }],
    thought: '在想事情',
    memory,
    nextLocation: null, nextActivity: null, mood: null, goal: null,
  }
}

describe('parseMemoryAnnotations(S1 写入侧情境标注,宽松解析)', () => {
  it('名字映射为 ID:全名与前两字均可,未知名丢弃', () => {
    const a = parseMemoryAnnotations({ mentions: ['张三丰', '张三', '不存在的人', 42] }, PEOPLE, LOCS)
    expect(a.mentions).toEqual(['ada-lo'])
  })

  it('地点须在世界清单内,否则 null', () => {
    expect(parseMemoryAnnotations({ location: 'Cafe' }, PEOPLE, LOCS).location).toBe('Cafe')
    expect(parseMemoryAnnotations({ location: '火星' }, PEOPLE, LOCS).location).toBeNull()
  })

  it('主题词截断到 3 个、空白丢弃', () => {
    const a = parseMemoryAnnotations({ topics: ['葬礼', '  ', '收成', '旧事', '第五条'] }, PEOPLE, LOCS)
    expect(a.topics).toEqual(['葬礼', '收成', '旧事'])
  })

  it('全部缺省/非法 → 空标注', () => {
    expect(parseMemoryAnnotations({}, PEOPLE, LOCS)).toEqual({ mentions: [], location: null, topics: [] })
    expect(parseMemoryAnnotations({ mentions: '不是数组', topics: 7, location: [] }, PEOPLE, LOCS))
      .toEqual({ mentions: [], location: null, topics: [] })
  })
})

describe('标注非法不阻断(AC1)', () => {
  it('beat:标注全非法时 memory 本体照写、标注为空', () => {
    const beat = normalizeBeatJson(beatRaw(
      { content: '值得一记', type: 'timeline', importance: 6, mentions: '烂掉了', location: '火星', topics: '也好' },
    ), LOCS, 60, undefined, PEOPLE)
    expect(beat.memory).toEqual({ content: '值得一记', type: 'timeline', importance: 6,
      mentions: [], location: null, topics: [] })
  })

  it('beat:合法标注映射入库形态', () => {
    const beat = normalizeBeatJson(beatRaw(
      { content: '听张三丰提起葬礼', type: 'relationship', importance: 8,
        mentions: ['张三丰'], location: 'Cafe', topics: ['葬礼'] },
    ), LOCS, 60, undefined, PEOPLE)
    expect(beat.memory).toMatchObject({ mentions: ['ada-lo'], location: 'Cafe', topics: ['葬礼'] })
  })

  it('dialogue:标注非法时 memory 照写', () => {
    const out = normalizeDialogueJson(
      { utterance: '嗯。', thought: '这样啊。', shouldEnd: false,
        memory: { content: '他提到收成', importance: 6, mentions: [123], topics: null, location: ' nowhere ' } },
      undefined, PEOPLE, LOCS)
    expect(out.memory).toEqual({ content: '他提到收成', importance: 6, mentions: [], location: null, topics: [] })
  })
})
