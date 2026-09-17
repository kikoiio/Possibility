import { describe, expect, it } from 'vitest'
import { parseSceneOutput } from './parse'

const VALID = {
  utterance: '雾大，脚下留神。',
  thought: '这位客人起得真早。',
  shouldEnd: false,
  memory: null,
}

describe('parseSceneOutput（scene 回应解析）', () => {
  it('正常解析，无 word 字段时 word=null', () => {
    const out = parseSceneOutput(VALID)
    expect(out.utterance).toBe('雾大，脚下留神。')
    expect(out.word).toBeNull()
    expect(out.memory).toBeNull()
  })
  it('word 字段原样取出并截断到 200 字', () => {
    const out = parseSceneOutput({ ...VALID, word: '明早开饭前再来一趟。' })
    expect(out.word).toBe('明早开饭前再来一趟。')
    expect(parseSceneOutput({ ...VALID, word: '长'.repeat(300) }).word).toHaveLength(200)
  })
  it('word 为空白/非字符串时视为 null', () => {
    expect(parseSceneOutput({ ...VALID, word: '   ' }).word).toBeNull()
    expect(parseSceneOutput({ ...VALID, word: 123 }).word).toBeNull()
  })
  it('utterance/thought 为空仍按对话格式报错', () => {
    expect(() => parseSceneOutput({ ...VALID, utterance: ' ' })).toThrow()
    expect(() => parseSceneOutput({ ...VALID, thought: '' })).toThrow()
  })
  it('memory 解析与对话格式一致', () => {
    const out = parseSceneOutput({ ...VALID, memory: { content: '阿透先生数的是灯', importance: 99 } })
    expect(out.memory?.content).toBe('阿透先生数的是灯')
  })
})
