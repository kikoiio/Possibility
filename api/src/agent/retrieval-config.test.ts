import { describe, expect, it } from 'vitest'
import { DEFAULT_RETRIEVAL_CONFIG, retrievalConfig } from './retrieval-config'

describe('retrievalConfig（N6：权重与阈值可调,非法值回落默认）', () => {
  it('缺省返回默认值', () => {
    expect(retrievalConfig()).toEqual(DEFAULT_RETRIEVAL_CONFIG)
    expect(retrievalConfig({})).toEqual(DEFAULT_RETRIEVAL_CONFIG)
  })

  it('环境变量覆盖', () => {
    const config = retrievalConfig({ RETRIEVAL_TOP_K: '10', RETRIEVAL_W3: '0', RETRIEVAL_HALF_LIFE_HOURS: '24.5' })
    expect(config.topK).toBe(10)
    expect(config.w3).toBe(0)
    expect(config.halfLifeHours).toBe(24.5)
    expect(config.recentFloor).toBe(DEFAULT_RETRIEVAL_CONFIG.recentFloor)
  })

  it('权重允许 0 但不允许负数;计数必须为正整数', () => {
    const config = retrievalConfig({ RETRIEVAL_W1: '-1', RETRIEVAL_W2: '0', RETRIEVAL_TOP_K: '0', RETRIEVAL_RECENT_FLOOR: 'abc' })
    expect(config.w1).toBe(DEFAULT_RETRIEVAL_CONFIG.w1)
    expect(config.w2).toBe(0)
    expect(config.topK).toBe(DEFAULT_RETRIEVAL_CONFIG.topK)
    expect(config.recentFloor).toBe(DEFAULT_RETRIEVAL_CONFIG.recentFloor)
  })
})
