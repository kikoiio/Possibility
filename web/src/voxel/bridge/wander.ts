import type { VoxelCoord } from '@possibility/voxel-contract'

/**
 * S4 世界模拟 · 环境漫步(F5,确定性 ambient)。
 * 日程项内部,居民在当前 location 锚点附近做确定性漫步:
 * 种子 = personId × 世界日(同人同日同轨迹),客户端纯函数,零 LLM 零存储。
 * 这是「世界活着」的背景感,不是行为模拟——无需求/动机/交互。
 *
 * 整数数学(禁三角函数,跨环境确定性):路径点取自固定偏移环,
 * 起点与步长由种子决定;环长为素数,任意步长遍历全环。
 */

/** 锚点邻域偏移环(dx, dz):最近 2 格、最远约 3.6 格;长度 11(素数) */
const RING: ReadonlyArray<readonly [number, number]> = [
  [2, 0], [0, 2], [-2, 0], [0, -2],
  [3, 1], [-1, 3], [-3, -1], [1, -3],
  [3, -2], [-2, 3], [-3, 2],
]

/** FNV-1a 32 位(与 residents.ts 取色同源风格的稳定哈希) */
function hashSeed(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * 漫步目的地:anchor 邻域内第 slot 站。
 * - 同一 (personId, worldDay, anchor, slot) 恒得同一格(种子确定性);
 * - slot 递增 → 沿环换站(顺序由种子决定,次日重排);
 * - y 恒取 anchor.y(站立面由调用方 nearestStandable 校正)。
 */
export function wanderDestination(personId: string, worldDay: string, anchor: VoxelCoord, slot: number): VoxelCoord {
  const seed = hashSeed(`${personId}|${worldDay}`)
  const start = seed % RING.length
  const step = 1 + (seed >>> 8) % (RING.length - 1) // 1..10,与素数环长互质 → 遍历全环
  const index = (start + Math.floor(Math.abs(slot)) * step) % RING.length
  const [dx, dz] = RING[index]
  return { x: anchor.x + dx, y: anchor.y, z: anchor.z + dz }
}

/** simNow(ISO)→ 漫步槽位:每 30 世界分钟换一站 */
export function wanderSlot(simNow: string): number {
  const date = new Date(simNow)
  if (Number.isNaN(date.getTime())) return 0
  return Math.floor((date.getUTCHours() * 60 + date.getUTCMinutes()) / 30)
}

/** simNow(ISO)→ 世界日(种子另一半) */
export function wanderWorldDay(simNow: string): string {
  return simNow.slice(0, 10)
}
