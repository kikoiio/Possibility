import { describe, expect, it } from 'vitest'
import { buildChapterPrompt, normalizeChapter } from './generate'

describe('normalizeChapter（章节 JSON 解析）', () => {
  it('正常解析', () => {
    expect(normalizeChapter({ title: '雾起', content: '那晚的雪……' })).toEqual({ title: '雾起', content: '那晚的雪……' })
  })
  it('正文为空视为失败（触发重试）', () => {
    expect(() => normalizeChapter({ title: 'x', content: '  ' })).toThrow()
    expect(() => normalizeChapter({})).toThrow()
  })
  it('缺标题给缺省值，超长标题截断', () => {
    expect(normalizeChapter({ content: '正文' }).title).toBe('无题')
    expect(normalizeChapter({ title: '长'.repeat(40), content: '正文' }).title).toHaveLength(30)
  })
})

describe('buildChapterPrompt（章节提示组装）', () => {
  it('包含世界、时间线、人物与全部事件行', () => {
    const [system, user] = buildChapterPrompt({
      worldName: '雾影庄',
      worldDescription: '山间温泉小镇',
      timelineLabel: 'what-if 分叉：「如果……」',
      roster: '雾野透、白川宗一郎',
      eventLines: ['[09-16 18:00] 雾野透：抵达——他在门口站了很久', '[09-16 19:00] 一段对话'],
    })
    expect(system.role).toBe('system')
    const u = String(user.content)
    expect(u).toContain('雾影庄')
    expect(u).toContain('what-if 分叉')
    expect(u).toContain('雾野透、白川宗一郎')
    expect(u).toContain('2 条')
    expect(u).toContain('抵达——他在门口站了很久')
  })
})
