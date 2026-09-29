import type { BlockRegistry } from '@possibility/voxel-contract'
import type { WorldModel } from './world-model'

/** 水面视觉高度（mesher 下沉后的 py 面）：入水判定与视觉水面严格一致 */
export const WATER_SURFACE_DROP = 0.875

/** 水下雾密度（FogExp2）：没入即起的基础值 + 随深度加深部分 */
export const UNDERWATER_FOG_BASE = 0.06
export const UNDERWATER_FOG_DEPTH = 0.06
/** 深度归一化跨度（格）：没入 1.2 格后雾密度打满 */
const DEPTH_SPAN = 1.2

export interface EyePos { x: number; y: number; z: number }

/**
 * 眼位是否没入水面：所在格为流体 且 眼位 y 低于该格下沉水面实际高度。
 * 出界/非流体安全返回 false（contract getBlock 越界返回 air）。
 */
export function isEyeUnderwater(world: WorldModel, registry: BlockRegistry, eye: EyePos): boolean {
  const gx = Math.floor(eye.x), gy = Math.floor(eye.y), gz = Math.floor(eye.z)
  const type = registry.get(world.getBlock({ x: gx, y: gy, z: gz }))
  if (!type || type.category !== 'fluid') return false
  return eye.y < gy + WATER_SURFACE_DROP
}

/** 没入深度 0~1：眼位低于下沉水面的距离按 DEPTH_SPAN 归一（未入水为 0） */
export function underwaterDepth(world: WorldModel, registry: BlockRegistry, eye: EyePos): number {
  const gx = Math.floor(eye.x), gy = Math.floor(eye.y), gz = Math.floor(eye.z)
  const type = registry.get(world.getBlock({ x: gx, y: gy, z: gz }))
  if (!type || type.category !== 'fluid') return 0
  const depth = gy + WATER_SURFACE_DROP - eye.y
  return Math.min(1, Math.max(0, depth / DEPTH_SPAN))
}

/**
 * 入水强度平滑（指数收敛，时间常数约 150ms）：避免穿面瞬间雾/扭曲跳变。
 * 单调收敛不超调；dt 为秒。
 */
export function smoothUnderwater(prev: number, target: number, dt: number): number {
  const k = 1 - Math.exp(-dt / 0.15)
  const next = prev + (target - prev) * k
  return Math.min(1, Math.max(0, next))
}
