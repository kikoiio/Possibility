import { describe, expect, it } from 'vitest'
import { parseAncestorIds } from './memory'
import type { timelines } from '../db/schema'

type Timeline = typeof timelines.$inferSelect

function timeline(ancestorIdsJson: string): Timeline {
  return {
    id: 't',
    worldId: 'w',
    parentTimelineId: null,
    forkScenarioJson: null,
    simNow: '2026-09-17T00:00:00Z',
    createdAt: '2026-09-17T00:00:00Z',
    status: 'active',
    ancestorIdsJson,
    lastRealTickAt: null,
  }
}

/** person 级 fork 的祖先链计算（与 timelines/routes.ts 保持一致）：源的祖先链 + 源本身 */
function forkAncestors(source: Timeline): string[] {
  return [...parseAncestorIds(source), source.id]
}

describe('分叉祖先链（bug#3：person 级 fork 曾写入缺省 [] 导致分叉人物零记忆）', () => {
  it('从主线分叉：祖先链 = [主线]', () => {
    const main = timeline('[]')
    main.id = 'main'
    expect(forkAncestors(main)).toEqual(['main'])
  })

  it('从分叉再分叉：祖先链累积完整路径', () => {
    const main = timeline('[]')
    main.id = 'main'
    const fork1 = timeline(JSON.stringify(forkAncestors(main)))
    fork1.id = 'fork1'
    expect(forkAncestors(fork1)).toEqual(['main', 'fork1'])
  })

  it('parseAncestorIds 对坏数据容错', () => {
    expect(parseAncestorIds(timeline('not json'))).toEqual([])
    expect(parseAncestorIds(timeline('{"a":1}'))).toEqual([])
    expect(parseAncestorIds(timeline('["x", 1, "y"]'))).toEqual(['x', '1', 'y'])
  })
})
