import { describe, expect, it } from 'vitest'
import { normalizePersonModel } from './person-model'

describe('normalizePersonModel', () => {
  it('preserves valid provenance and keeps unknowns separate', () => {
    expect(normalizePersonModel({
      identity: [
        { text: ' 明确提供的身份 ', provenance: 'known' },
        { text: '推测的偏好', provenance: 'inferred' },
      ],
      unknowns: [' 不知道的地点 ', ''],
    })).toEqual({
      identity: [
        { text: '明确提供的身份', provenance: 'known' },
        { text: '推测的偏好', provenance: 'inferred' },
      ],
      behavior: [],
      speech: [],
      skills: [],
      memories: [],
      relationships: [],
      boundaries: [],
      unknowns: ['不知道的地点'],
    })
  })

  it('treats legacy strings and missing or invalid provenance as inferred', () => {
    expect(normalizePersonModel({
      identity: [
        '旧格式条目',
        { text: '缺少来源' },
        { text: '无效来源', provenance: 'verified' },
      ],
    }).identity).toEqual([
      { text: '旧格式条目', provenance: 'inferred' },
      { text: '缺少来源', provenance: 'inferred' },
      { text: '无效来源', provenance: 'inferred' },
    ])
  })

  it('drops blank entries and malformed layers while returning a complete model', () => {
    expect(normalizePersonModel({
      identity: [{ text: '  ', provenance: 'known' }, null, 4],
      behavior: 'not-an-array',
      unknowns: [' ', null, { text: 'not a string' }],
    })).toEqual({
      identity: [],
      behavior: [],
      speech: [],
      skills: [],
      memories: [],
      relationships: [],
      boundaries: [],
      unknowns: [],
    })
  })

  it('returns an empty model for invalid roots', () => {
    expect(normalizePersonModel(null)).toEqual({
      identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [],
    })
    expect(normalizePersonModel(['not', 'a', 'model']).unknowns).toEqual([])
  })
})
