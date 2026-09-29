import { describe, expect, it } from 'vitest'
import { validateDocument, validateWalkability } from '@possibility/voxel-contract'
import type { ChatMessage } from '../llm/client'
import { generateWorld, WorldGeneratorError } from './generate'
import type { CompleteFn } from './edit-planner'

const payload = (ops: unknown[]) => JSON.stringify({
  size: { width: 16, height: 16, depth: 16 },
  groundBlock: 'grass',
  ops,
})

/** 无害操作:Parser 不接受空 ops;平地重写一块草等于不变 */
const NOOP_OPS = [{ kind: 'set-block', at: { x: 0, y: 0, z: 0 }, block: 'grass' }]

/** 净高 1 的「门洞」:平地上 (8,2,8) 压一块石头,(8,1,8) 成净空不足格 */
const LOW_DOOR_OPS = [{ kind: 'set-block', at: { x: 8, y: 2, z: 8 }, block: 'stone' }]

describe('generateWorld × 可行走性校验(S2b F5/AC6)', () => {
  it('首轮可行走性失败 → 重试文案带 walk issue 与坐标 → 次轮合规通过', async () => {
    const calls: ChatMessage[][] = []
    const complete: CompleteFn = async (messages) => {
      calls.push(messages)
      return calls.length === 1 ? payload(LOW_DOOR_OPS) : payload(NOOP_OPS)
    }
    const doc = await generateWorld('测试世界', 'mist-manor', { complete })
    expect(calls.length).toBe(2)
    const retryMsg = calls[1][calls[1].length - 1]
    expect(retryMsg.role).toBe('user')
    expect(retryMsg.content).toContain('walk-clearance')
    expect(retryMsg.content).toContain('(8,1,8)')
    // 最终产物通过双重校验
    expect(validateDocument(doc)).toEqual([])
    expect(validateWalkability(doc)).toEqual([])
  })

  it('maxAttempts 耗尽 → WorldGeneratorError 携带 walk issue', async () => {
    const complete: CompleteFn = async () => payload(LOW_DOOR_OPS)
    let error: unknown
    try {
      await generateWorld('测试世界', 'mist-manor', { complete, maxAttempts: 2 })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(WorldGeneratorError)
    expect((error as WorldGeneratorError).issues.some((i) => i.code === 'walk-clearance')).toBe(true)
  })

  it('结构校验失败时跳过可行走性(先修结构)', async () => {
    const calls: string[] = []
    const complete: CompleteFn = async () => {
      calls.push('x')
      // 悬空物体 → validateDocument floating-object;不应出现 walk-* issue
      return JSON.stringify({
        size: { width: 16, height: 16, depth: 16 },
        placements: [{ objectType: 'stone-lantern', anchor: { x: 8, y: 8, z: 8 }, rotation: 0 }],
      })
    }
    let error: unknown
    try {
      await generateWorld('测试世界', 'mist-manor', { complete, maxAttempts: 1 })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(WorldGeneratorError)
    const issues = (error as WorldGeneratorError).issues
    expect(issues.some((i) => i.code === 'floating-object')).toBe(true)
    expect(issues.some((i) => i.code.startsWith('walk-'))).toBe(false)
  })
})
