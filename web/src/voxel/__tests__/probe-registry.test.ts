import { describe, expect, it } from 'vitest'
import type { VoxelEngine } from '../engine'
import { registerEngineProbe, unregisterEngineProbe, type VoxelProbeTarget } from '../probe-registry'

const fakeEngine = () => ({}) as VoxelEngine

describe('体素探针注册表(S1 视口实例化)', () => {
  it('双实例按 instanceId 隔离注册,互不覆盖', () => {
    const target: VoxelProbeTarget = {}
    const left = fakeEngine()
    const right = fakeEngine()
    registerEngineProbe(target, 'left', left, true)
    registerEngineProbe(target, 'right', right, false)
    expect(target.__voxelEngines?.left).toBe(left)
    expect(target.__voxelEngines?.right).toBe(right)
  })

  it('__voxelEngine 别名只跟随 primary 实例(向后兼容)', () => {
    const target: VoxelProbeTarget = {}
    const main = fakeEngine()
    const other = fakeEngine()
    registerEngineProbe(target, 'main', main, true)
    expect(target.__voxelEngine).toBe(main)
    registerEngineProbe(target, 'right', other, false)
    expect(target.__voxelEngine).toBe(main) // 非 primary 注册不抢别名
  })

  it('卸载按 id 摘除,不影响另一实例;primary 卸载才摘别名', () => {
    const target: VoxelProbeTarget = {}
    const left = fakeEngine()
    const right = fakeEngine()
    registerEngineProbe(target, 'left', left, true)
    registerEngineProbe(target, 'right', right, false)
    unregisterEngineProbe(target, 'right', right)
    expect(target.__voxelEngines?.right).toBeUndefined()
    expect(target.__voxelEngines?.left).toBe(left)
    expect(target.__voxelEngine).toBe(left) // 别名不受右侧卸载影响
    unregisterEngineProbe(target, 'left', left)
    expect(target.__voxelEngines?.left).toBeUndefined()
    expect(target.__voxelEngine).toBeUndefined()
  })

  it('StrictMode 双挂载:旧引擎清理不会误删同 id 新引擎', () => {
    const target: VoxelProbeTarget = {}
    const stale = fakeEngine()
    const fresh = fakeEngine()
    registerEngineProbe(target, 'main', stale, true)
    unregisterEngineProbe(target, 'main', stale) // 第一次卸载
    registerEngineProbe(target, 'main', fresh, true) // 第二次挂载
    unregisterEngineProbe(target, 'main', stale) // 迟到的旧清理不得误删
    expect(target.__voxelEngines?.main).toBe(fresh)
    expect(target.__voxelEngine).toBe(fresh)
  })
})
