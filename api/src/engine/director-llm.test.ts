import { describe, expect, it } from 'vitest'
import { buildDirectorPrompt, parseDirectorOrder } from './director-llm'

const EVENT = { title: '山道上的陌生人', description: '一个背着相机的陌生人在雾中打听图书室的位置。' }

const CANDIDATES = [
  { personId: 'p1', name: '雾野 透', location: '图书室', activity: '翻旧报', mood: '警觉', profile: '四处游历的记者' },
  { personId: 'p2', name: '白川 怜', location: '大厅', activity: '写小说', mood: '烦躁', profile: '庄主侄孙' },
  { personId: 'p3', name: '小夜', location: '厨房', activity: '备晚饭', mood: '平静', profile: '老管家' },
]

describe('buildDirectorPrompt（导演仲裁提示）', () => {
  it('包含事件与全部候选人关键信息', () => {
    const { system, user } = buildDirectorPrompt(EVENT, CANDIDATES)
    expect(system).toContain('导演')
    expect(user).toContain('山道上的陌生人')
    expect(user).toContain('p1｜雾野 透')
    expect(user).toContain('四处游历的记者')
    expect(user).toContain('p3｜小夜')
    expect(system).toContain('order')
  })
})

describe('parseDirectorOrder（导演排序解析）', () => {
  const valid = CANDIDATES.map((c) => c.personId)
  it('正常解析并保持顺序', () => {
    expect(parseDirectorOrder({ order: ['p3', 'p1'] }, valid)).toEqual(['p3', 'p1'])
  })
  it('剥掉非法 id 与重复项', () => {
    expect(parseDirectorOrder({ order: ['p9', 'p1', 'p1', 'p2'] }, valid)).toEqual(['p1', 'p2'])
  })
  it('结构非法或非字符串 id 时返回空（调用方回退机械排序）', () => {
    expect(parseDirectorOrder({ order: 'p1' }, valid)).toEqual([])
    expect(parseDirectorOrder(null, valid)).toEqual([])
    expect(parseDirectorOrder({ order: [1, 2] }, valid)).toEqual([])
  })
})
