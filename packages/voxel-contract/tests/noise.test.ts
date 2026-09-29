import { describe, expect, it } from 'vitest'
import { fbm2D, hash2i, mulberry32, valueNoise2D } from '../src/noise'

describe('mulberry32', () => {
  it('同种子两次序列全等', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 100; i++) expect(a()).toBe(b())
  })

  it('不同种子序列不同', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    const seqA = Array.from({ length: 10 }, () => a())
    const seqB = Array.from({ length: 10 }, () => b())
    expect(seqA).not.toEqual(seqB)
  })

  it('值域在 [0,1)', () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 1000; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('hash2i', () => {
  it('同参数结果全等且值域 [0,1)', () => {
    for (let i = 0; i < 100; i++) {
      const v = hash2i(9, i - 50, i * 3)
      expect(v).toBe(hash2i(9, i - 50, i * 3))
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('valueNoise2D', () => {
  it('同参数两次调用结果全等', () => {
    for (let i = 0; i < 50; i++) {
      const x = i * 0.37 - 9.1
      const y = i * 1.13 + 2.7
      expect(valueNoise2D(1234, x, y)).toBe(valueNoise2D(1234, x, y))
    }
  })

  it('值域在 [-1,1]', () => {
    for (let i = 0; i < 1000; i++) {
      const v = valueNoise2D(5, i * 0.173, i * 0.311)
      expect(v).toBeGreaterThanOrEqual(-1)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('不同 seed 输出不同', () => {
    const a = valueNoise2D(1, 3.7, 8.2)
    const b = valueNoise2D(2, 3.7, 8.2)
    expect(a).not.toBe(b)
  })

  it('抽样 1000 点分布不塌缩', () => {
    let min = Infinity
    let max = -Infinity
    let sum = 0
    for (let i = 0; i < 1000; i++) {
      const v = valueNoise2D(77, (i % 32) * 0.41, Math.floor(i / 32) * 0.43)
      min = Math.min(min, v)
      max = Math.max(max, v)
      sum += v
    }
    expect(min).toBeLessThan(0)
    expect(max).toBeGreaterThan(0)
    expect(Math.abs(sum / 1000)).toBeLessThan(0.2)
  })
})

describe('fbm2D', () => {
  it('同参数两次调用结果全等,值域 [-1,1]', () => {
    for (let i = 0; i < 200; i++) {
      const x = i * 0.19
      const y = i * 0.07
      const v = fbm2D(314, x, y, 4)
      expect(v).toBe(fbm2D(314, x, y, 4))
      expect(v).toBeGreaterThanOrEqual(-1)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('octaves=0 返回 0', () => {
    expect(fbm2D(1, 2, 3, 0)).toBe(0)
  })
})
