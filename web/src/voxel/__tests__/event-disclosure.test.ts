import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { WorldEvent } from '@possibility/voxel-contract'
import { EventDisclosure } from '../engine/event-disclosure'
import { iconCell } from '../engine/event-icons'

const AT = (x: number, y: number, z: number) => ({ x, y, z })

function makeEvent(id: string, overrides: Partial<WorldEvent> = {}): WorldEvent {
  return {
    id,
    type: 'celebration',
    at: AT(10, 2, 10),
    importance: 'high',
    timeWindow: { start: '2026-10-15T16:00:00Z', end: '2026-10-15T20:00:00Z' },
    label: '婚礼',
    teaser: '一句话预告',
    scene: '完整场景',
    ...overrides,
  }
}

const DURING = '2026-10-15T17:00:00Z'
const BEFORE = '2026-10-15T15:00:00Z'
const AFTER = '2026-10-15T21:00:00Z'

/** 无 DOM 的注入式构造:空纹理 + 可控投影器 */
function makeDisclosure(project: (at: { x: number; y: number; z: number }) => { x: number; y: number } | null) {
  const scene = new THREE.Scene()
  const d = new EventDisclosure({ scene, project, atlas: new THREE.Texture() })
  return { d, scene }
}

describe('EventDisclosure(S3b F4/F5/F8)', () => {
  it('setEvents 建 Points 层并入 scene;states 初始为空,update 后按裁决填充', () => {
    const { d, scene } = makeDisclosure(() => null)
    d.setEvents([makeEvent('a'), makeEvent('b', { importance: 'low' })])
    expect(scene.children).toHaveLength(1)
    d.setSimNow(DURING)
    d.update(1 / 60)
    expect(d.states()).toEqual([
      { eventId: 'a', phase: 'active', level: 'icon' },   // overview 档 high
      { eventId: 'b', phase: 'active', level: 'none' },   // overview 档 low 过滤(F7)
    ])
    d.dispose()
    expect(scene.children).toHaveLength(0)
  })

  it('setTier/setSimNow 驱动状态切换:district 全开;过去留痕;未来隐藏(F5)', () => {
    const { d } = makeDisclosure(() => null)
    d.setEvents([makeEvent('a'), makeEvent('b', { importance: 'low' })])
    d.setSimNow(DURING)
    d.update(1 / 60)
    d.setTier('district')
    d.update(1 / 60)
    expect(d.states().map((s) => s.level)).toEqual(['teaser', 'teaser'])
    d.setSimNow(AFTER)
    d.update(1 / 60)
    expect(d.states().map((s) => s.phase)).toEqual(['trace', 'trace'])
    expect(d.states().map((s) => s.level)).toEqual(['icon', 'icon'])
    d.setSimNow(BEFORE)
    d.update(1 / 60)
    expect(d.states().map((s) => s.phase)).toEqual(['hidden', 'hidden'])
  })

  it('同值 setSimNow/setTier 不重复刷新(帧内缓存)', () => {
    const { d } = makeDisclosure(() => null)
    d.setEvents([makeEvent('a')])
    d.setSimNow(DURING)
    d.update(1 / 60)
    const before = d.states()
    d.setSimNow(DURING)
    d.setTier('overview')
    d.update(1 / 60)
    expect(d.states()).toBe(before) // 引用不变 = 未重算
  })

  it('pickEvent:阈值内取最近者,不可见(level none)不命中', () => {
    const project = (at: { x: number; y: number; z: number }) => {
      if (at.x > 20) return { x: 100, y: 100 }
      return { x: 50, y: 50 }
    }
    const { d } = makeDisclosure(project)
    d.setEvents([
      makeEvent('near', { at: AT(10, 2, 10) }),
      makeEvent('far', { at: AT(30, 2, 10) }),
      makeEvent('low', { at: AT(10, 2, 10), importance: 'low' }),
    ])
    d.setSimNow(DURING)
    d.update(1 / 60) // overview:near=icon, far=icon, low=none
    expect(d.pickEvent(52, 48)).toBe('near')
    expect(d.pickEvent(98, 102)).toBe('far')
    expect(d.pickEvent(500, 500)).toBeNull()
  })

  it('iconCell 图集布局:类型序 × 2 + 留痕位', () => {
    expect(iconCell('celebration', false)).toBe(0)
    expect(iconCell('celebration', true)).toBe(1)
    expect(iconCell('daily', false)).toBe(2)
    expect(iconCell('turning', true)).toBe(5)
  })

  it('dispose 幂等:重复调用不抛错', () => {
    const { d } = makeDisclosure(() => null)
    d.setEvents([makeEvent('a')])
    d.dispose()
    expect(() => d.dispose()).not.toThrow()
  })
})
