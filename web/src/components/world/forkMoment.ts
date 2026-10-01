import type { HistoryRange } from '../../api/types'

/**
 * S4/F6 分叉时刻选择的纯逻辑(组件只负责渲染与调用)。
 * 世界时钟全程按 UTC 墙钟展示(simNow.slice(0,16)),datetime-local 输入同样按 UTC 解释,
 * 避免浏览器时区把世界时间换算成本地时间。
 */

export type MomentPlan =
  /** 默认当前时刻:不调用 checkMoment */
  | { kind: 'current' }
  /** 过去时刻:交服务端 checkMoment 吸附判定 */
  | { kind: 'check'; at: string }
  /** 本地即可判定不可用,原因直接展示 */
  | { kind: 'invalid'; reason: string }

/** ISO → datetime-local 输入值(UTC 墙钟,直接截取) */
export function toLocalInputValue(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? iso.slice(0, 16) : ''
}

/** datetime-local 输入值 → UTC ISO;非法输入返回 null */
export function fromLocalInputValue(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const iso = `${value}:00.000Z`
  return Number.isFinite(Date.parse(iso)) ? iso : null
}

/**
 * 提交/失焦时的本地判定:
 * - 空输入或恰等于当前时刻 → current(不调用 check);
 * - 未来、早于可回溯起点、该线不支持历史、格式非法 → invalid 附原因;
 * - 其余 → check,由服务端吸附到有效时刻。
 */
export function planMomentCheck(input: string, range: HistoryRange | null): MomentPlan {
  if (!input.trim()) return { kind: 'current' }
  if (!range || range.earliest === null) {
    return { kind: 'invalid', reason: '这条时间线没有可回溯的历史，只能从当前时刻分叉。' }
  }
  const at = fromLocalInputValue(input)
  if (!at) return { kind: 'invalid', reason: '时刻格式无效，请重新选择。' }
  if (Date.parse(at) > Date.parse(range.simNow)) return { kind: 'invalid', reason: '该时刻尚未发生，请以当前或过去时刻分叉。' }
  if (Date.parse(at) === Date.parse(range.simNow)) return { kind: 'current' }
  if (Date.parse(at) < Date.parse(range.earliest)) return { kind: 'invalid', reason: '该时刻早于这条线可回溯的起点。' }
  return { kind: 'check', at }
}
