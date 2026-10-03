import { useMemo } from 'react'
import type { AlignedAxis, AxisMarker } from '../../world/alignedTimeline'
import { formatWorldTime } from '../../lib/world-time'

export interface AlignedTimelineProps {
  axis: AlignedAxis
  leftTimeZone: string
  rightTimeZone: string
  /** 拖档对齐时刻;null = 自由模式(各看各的当前) */
  at: string | null
  onScrub?: (at: string | null) => void
  onSelect?: (marker: AxisMarker) => void
}

const fmt = (iso: string, timeZone: string) => formatWorldTime(iso, timeZone)
const SIDE_STYLE: Record<AxisMarker['side'], string> = {
  shared: 'bg-zinc-400',
  left: 'bg-woad-deep',
  right: 'bg-cinnabar-deep',
}
const SIDE_LABEL: Record<AxisMarker['side'], string> = { shared: '共同', left: '左线', right: '右线' }

/**
 * S1 共同时间轴:以分叉点为原点,共同过去 + 两线各自延伸。
 * 只渲染不计算(轴模型见 world/alignedTimeline.ts);拖档只回放事件记录。
 */
export default function AlignedTimeline({ axis, leftTimeZone, rightTimeZone, at, onScrub, onSelect }: AlignedTimelineProps) {
  const domain = useMemo(() => {
    const times = [
      ...axis.markers.map((m) => m.simTime),
      axis.origin, axis.leftNow, axis.rightNow,
    ].filter((t): t is string => !!t).map((t) => Date.parse(t)).filter(Number.isFinite)
    const start = times.length ? Math.min(...times) : Date.now()
    let end = times.length ? Math.max(...times) : start + 3_600_000
    if (end <= start) end = start + 3_600_000
    return { start, end }
  }, [axis])
  const pos = (iso: string) => `${(((Date.parse(iso) - domain.start) / (domain.end - domain.start)) * 100).toFixed(2)}%`
  const reviewing = at !== null
  const scrubMs = at ? Date.parse(at) : domain.end
  // 键盘逐事件移动:方向键在标记时刻之间跳跃
  const stepTo = (dir: 1 | -1) => {
    const times = [...new Set(axis.markers.map((m) => m.simTime))].sort()
    const current = at ?? axis.markers.at(-1)?.simTime ?? null
    const next = dir === 1
      ? times.find((t) => current === null || t > current)
      : [...times].reverse().find((t) => current !== null && t < current)
    if (next) onScrub?.(next)
  }

  return (
    <section aria-label="共同时间轴" data-testid="aligned-timeline" className="rounded-2xl bg-white/85 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#687a6b]">
        <p>
          共同时间轴
          {axis.origin
            ? <span className="ml-2 text-[#849184]">分叉点 {fmt(axis.origin, leftTimeZone)} · 左线 {fmt(axis.leftNow, leftTimeZone)} · 右线 {fmt(axis.rightNow, rightTimeZone)}</span>
            : <span className="ml-2 text-[#849184]">无法确认共同分叉来源;仅展示两线各自当前时刻 · 左线 {fmt(axis.leftNow, leftTimeZone)} · 右线 {fmt(axis.rightNow, rightTimeZone)}</span>}
        </p>
        <div className="flex items-center gap-2">
          {reviewing && (
            <span data-testid="aligned-timeline-review-badge" className="rounded-full bg-amber-100 px-2.5 py-1 text-[10px] text-amber-800">
              回看中 · 视口仍显示各线当前状态
            </span>
          )}
          {reviewing && (
            <button type="button" onClick={() => onScrub?.(null)} className="rounded-full border border-[#d7ded3] bg-white px-2.5 py-1 text-[10px] text-[#536558]">
              回到当下
            </button>
          )}
        </div>
      </div>
      <div className="relative mt-6 h-14" data-testid="aligned-timeline-track">
        {/* 轴与共同过去区间 */}
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[#dfe6dc]" />
        {axis.origin && (
          <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-zinc-400/70" style={{ width: pos(axis.origin) }} data-testid="aligned-timeline-shared-past" />
        )}
        {axis.origin && (
          <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: pos(axis.origin) }} data-testid="aligned-timeline-origin">
            <div className="h-3 w-0.5 bg-[#405447]" />
            <span className="absolute left-1/2 top-3 -translate-x-1/2 whitespace-nowrap text-[10px] text-[#405447]">分叉点</span>
          </div>
        )}
        {/* 三色事件标记 */}
        {axis.markers.map((marker) => {
          const isFirst = axis.firstDivergenceAt !== null && marker.simTime === axis.firstDivergenceAt && marker.side !== 'shared'
          return (
            <button
              key={`${marker.side}:${marker.eventId}`}
              type="button"
              title={`${SIDE_LABEL[marker.side]} · ${marker.title} · ${fmt(marker.simTime, marker.side === 'right' ? rightTimeZone : leftTimeZone)}`}
              onClick={() => onSelect?.(marker)}
              data-testid="aligned-timeline-marker"
              data-event-id={marker.eventId}
              data-side={marker.side}
              className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white transition-transform motion-reduce:transition-none hover:scale-125 ${SIDE_STYLE[marker.side]} ${isFirst ? 'h-3.5 w-3.5 ring-amber-400' : ''}`}
              style={{ left: pos(marker.simTime) }}
            />
          )
        })}
        {axis.firstDivergenceAt && (
          <span
            className="absolute -top-1 -translate-x-1/2 whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800"
            style={{ left: pos(axis.firstDivergenceAt) }}
            data-testid="aligned-timeline-first-divergence"
          >
            从这里开始不同
          </span>
        )}
        {/* 两线 simNow 常驻 */}
        <span className="absolute bottom-0 -translate-x-1/2 whitespace-nowrap text-[10px] text-woad-deep" style={{ left: pos(axis.leftNow) }} data-testid="aligned-timeline-left-now">
          左线 {fmt(axis.leftNow, leftTimeZone)}
        </span>
        <span className="absolute bottom-0 -translate-x-1/2 whitespace-nowrap text-[10px] text-cinnabar-deep" style={{ left: pos(axis.rightNow) }} data-testid="aligned-timeline-right-now">
          右线 {fmt(axis.rightNow, rightTimeZone)}
        </span>
      </div>
      <input
        type="range"
        aria-label="沿时间轴回看事件记录"
        data-testid="aligned-timeline-scrub"
        min={domain.start}
        max={domain.end}
        step={60_000}
        value={scrubMs}
        onChange={(e) => onScrub?.(new Date(Number(e.target.value)).toISOString())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { e.preventDefault(); stepTo(-1) }
          if (e.key === 'ArrowRight') { e.preventDefault(); stepTo(1) }
        }}
        className="mt-1 w-full accent-[#405447]"
      />
    </section>
  )
}
