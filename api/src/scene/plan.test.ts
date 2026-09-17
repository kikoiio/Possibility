import { describe, expect, it } from 'vitest'
import { SCENE_TRANSCRIPT_MAX, sceneDialogueTitle, sceneTranscript } from './plan'

describe('sceneDialogueTitle', () => {
  it('单人回应：与引擎对话标题同风格', () => {
    expect(sceneDialogueTitle('阿透', ['小夜'], '餐厅')).toBe('阿透 与 小夜 在餐厅交谈')
  })

  it('多人回应：顿号并列', () => {
    expect(sceneDialogueTitle('阿透', ['小夜', '柊一成'], '温室花房')).toBe('阿透 与 小夜、柊一成 在温室花房交谈')
  })

  it('无回应者也给出合法标题', () => {
    expect(sceneDialogueTitle('阿透', [], '餐厅')).toBe('阿透 与  在餐厅交谈')
  })
})

describe('sceneTranscript', () => {
  it('拼接每句对话为章节摘录格式', () => {
    const text = sceneTranscript([
      { name: '阿透', utterance: '早。' },
      { name: '小夜', utterance: '咦，你来了。' },
    ])
    expect(text).toBe('阿透：「早。」　小夜：「咦，你来了。」')
  })

  it('空输入返回空串', () => {
    expect(sceneTranscript([])).toBe('')
  })

  it('跳过缺名字或缺内容的轮次', () => {
    expect(
      sceneTranscript([
        { name: '', utterance: '早。' },
        { name: '小夜', utterance: '  ' },
        { name: '小夜', utterance: '咦。' },
      ]),
    ).toBe('小夜：「咦。」')
  })

  it('超长截断并加省略号', () => {
    const long = 'x'.repeat(SCENE_TRANSCRIPT_MAX + 100)
    const text = sceneTranscript([{ name: '阿透', utterance: long }])
    expect(text.length).toBe(SCENE_TRANSCRIPT_MAX + 1) // 截断到上限 + 省略号
    expect(text.startsWith('阿透：「')).toBe(true)
    expect(text.endsWith('…')).toBe(true)
  })
})
