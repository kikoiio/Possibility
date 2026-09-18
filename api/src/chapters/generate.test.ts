import { describe, expect, it } from 'vitest'
import { buildChapterPrompt, normalizeChapter, rosterLine } from './generate'

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

  it('系统提示要求在场身份的事件必须写入', () => {
    const [system] = buildChapterPrompt({
      worldName: '雾影庄',
      worldDescription: '',
      timelineLabel: '主线',
      roster: '阿透（在场身份）、小夜',
      eventLines: ['[09-17 08:49] 阿透：阿透 与 小夜 在餐厅交谈——阿透：「早。」'],
    })
    expect(String(system.content)).toContain('在场身份')
    expect(String(system.content)).toContain('必须写入')
  })
})

describe('rosterLine（人物名单，纯函数）', () => {
  it('在场身份显式标注，其余照常', () => {
    expect(
      rosterLine([
        { name: '小夜', isUser: false },
        { name: '阿透', isUser: true },
        { name: '雾野透', isUser: false },
      ]),
    ).toBe('小夜、阿透（在场身份）、雾野透')
  })

  it('无人时给缺省值', () => {
    expect(rosterLine([])).toBe('（无人）')
  })
})
