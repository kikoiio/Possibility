import type { VoxelEngine } from './engine'

/**
 * 体素引擎 e2e 探针注册表(S1 视口实例化)。
 * - `__voxelEngines`:全实例注册表,按 instanceId 隔离,卸载按 id 摘除
 * - `__voxelEngine`:主实例别名(向后兼容,10+ 既有体素 e2e 依赖),仅 primary 实例写
 */
export interface VoxelProbeTarget {
  __voxelEngine?: VoxelEngine
  __voxelEngines?: Record<string, VoxelEngine>
}

export function registerEngineProbe(target: VoxelProbeTarget, instanceId: string, engine: VoxelEngine, primary: boolean): void {
  const registry = target.__voxelEngines ?? (target.__voxelEngines = {})
  registry[instanceId] = engine
  if (primary) target.__voxelEngine = engine
}

export function unregisterEngineProbe(target: VoxelProbeTarget, instanceId: string, engine: VoxelEngine): void {
  // 只摘除自己:StrictMode 双挂载/同 id 重挂载下,后挂载的实例不能被先卸载的清理误删
  if (target.__voxelEngines?.[instanceId] === engine) delete target.__voxelEngines[instanceId]
  if (target.__voxelEngine === engine) delete target.__voxelEngine
}
