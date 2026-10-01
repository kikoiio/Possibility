import type { VoxelCoord } from './types'

// ── S3b 事件披露:事件契约 + 披露裁决 ─────────────
// 事件由世界模拟(S4)涌现,本阶段静态注入;披露层级随缩放 continuum:
// 标记(全貌)→ 一句话预告(街区)→ 完整场景(近距,侧边面板)。

export type WorldEventType = 'celebration' | 'daily' | 'turning'   // 庆典 / 日常 / 转折
export type EventImportance = 'low' | 'medium' | 'high'

/** 世界事件(F1):随世界文档持久化,S4 模拟层产出同一形状 */
export interface WorldEvent {
  id: string                        // 事件唯一 id
  type: WorldEventType
  at: VoxelCoord                    // 锚定位置(图标挂点上移由渲染层定)
  importance: EventImportance
  /** ISO 8601 绝对世界时间窗,一次性事件;start < end */
  timeWindow: { start: string; end: string }
  label: string                     // marker 短标签(面板标题,0~4 字建议)
  teaser: string                    // district 档一句话预告
  scene: string                     // close 档完整场景文本
  participants?: string[]           // resident 引用(personId),面板展示用
  relatedAssetIds?: string[]        // 关联资产 id,面板展示用
}

// ── 披露裁决(F4, F5, F7;N5 纯函数) ───────────────
export type EventPhase = 'hidden' | 'trace' | 'active'   // 未来隐藏 / 过去留痕 / 窗内活跃
export type EventDisclosureLevel = 'none' | 'icon' | 'teaser'

export interface EventDisclosureState {
  eventId: string
  phase: EventPhase
  /** 当前渲染层级;trace 恒为 'icon'(去饱和渲染是引擎职责) */
  level: EventDisclosureLevel
}

/** tier 字面量与引擎 ZoomTier 对齐;契约包不依赖引擎类型 */
export type DisclosureTier = 'overview' | 'district' | 'close'

/**
 * 披露裁决:事件 × simNow × tier → 披露状态。
 * - simNow < start → hidden(防剧透)
 * - simNow > end   → trace(留痕,可回顾)
 * - 窗内 active:overview 仅 high 可见(icon);district/close → teaser
 * - simNow 不可解析 → hidden(防御)
 */
export function resolveEventDisclosure(event: WorldEvent, simNow: string, tier: DisclosureTier): EventDisclosureState {
  const now = Date.parse(simNow)
  if (Number.isNaN(now)) return { eventId: event.id, phase: 'hidden', level: 'none' }
  const start = Date.parse(event.timeWindow.start)
  const end = Date.parse(event.timeWindow.end)
  if (now < start) return { eventId: event.id, phase: 'hidden', level: 'none' }
  if (now > end) return { eventId: event.id, phase: 'trace', level: 'icon' }
  if (tier === 'overview') {
    return { eventId: event.id, phase: 'active', level: event.importance === 'high' ? 'icon' : 'none' }
  }
  return { eventId: event.id, phase: 'active', level: 'teaser' }
}

// ── 形状校验(deserialize 复用,仿 assetPlacements 风格) ──
type AssertFn = (condition: unknown, reason: string) => asserts condition

const EVENT_TYPES: readonly string[] = ['celebration', 'daily', 'turning']
const EVENT_IMPORTANCE: readonly string[] = ['low', 'medium', 'high']

/** 校验单个事件形状;assert 由 deserialize 注入以保持 VoxelDeserializeError 单一出口 */
export function assertWorldEvent(raw: unknown, index: number, assert: AssertFn): asserts raw is WorldEvent {
  const at = `events[${index}]`
  assert(typeof raw === 'object' && raw !== null, `${at} must be an object`)
  const e = raw as Record<string, unknown>
  assert(typeof e.id === 'string' && e.id.length > 0, `${at}.id must be a non-empty string`)
  assert(typeof e.type === 'string' && EVENT_TYPES.includes(e.type), `${at}.type must be one of ${EVENT_TYPES.join('/')}`)
  const coord = e.at as Record<string, unknown>
  assert(coord && Number.isInteger(coord.x) && Number.isInteger(coord.y) && Number.isInteger(coord.z),
    `${at}.at must be three integers`)
  assert(typeof e.importance === 'string' && EVENT_IMPORTANCE.includes(e.importance),
    `${at}.importance must be one of ${EVENT_IMPORTANCE.join('/')}`)
  const tw = e.timeWindow as Record<string, unknown>
  assert(tw && typeof tw.start === 'string' && typeof tw.end === 'string'
    && !Number.isNaN(Date.parse(tw.start)) && !Number.isNaN(Date.parse(tw.end)),
    `${at}.timeWindow start/end must be parseable ISO strings`)
  assert(Date.parse(tw.start as string) < Date.parse(tw.end as string), `${at}.timeWindow start must be before end`)
  assert(typeof e.label === 'string' && e.label.length > 0, `${at}.label must be a non-empty string`)
  assert(typeof e.teaser === 'string' && e.teaser.length > 0, `${at}.teaser must be a non-empty string`)
  assert(typeof e.scene === 'string' && e.scene.length > 0, `${at}.scene must be a non-empty string`)
  if (e.participants !== undefined) {
    assert(Array.isArray(e.participants) && e.participants.every((p: unknown) => typeof p === 'string'),
      `${at}.participants must be a string array`)
  }
  if (e.relatedAssetIds !== undefined) {
    assert(Array.isArray(e.relatedAssetIds) && e.relatedAssetIds.every((p: unknown) => typeof p === 'string'),
      `${at}.relatedAssetIds must be a string array`)
  }
}
