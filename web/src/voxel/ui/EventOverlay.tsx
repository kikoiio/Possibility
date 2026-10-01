import { useCallback, useEffect, useState } from 'react'
import type { EventPhase } from '@possibility/voxel-contract'
import type { VoxelEngine } from '../engine'

/**
 * S3b 事件披露(F4):district/close 档的一句话预告 HTML 浮层。
 * 每帧经 addUpdatable 取披露层投影锚点(变化才 setState);overview 档集合为空、零 DOM(N3)。
 */

interface Anchor { eventId: string; x: number; y: number; teaser: string }

export interface EventOverlayProps {
  engine: VoxelEngine | null
  /** 点击浮层:与画布点击同一条路由(district 飞向/close 开面板) */
  onSelect: (eventId: string) => void
}

export default function EventOverlay({ engine, onSelect }: EventOverlayProps) {
  const [anchors, setAnchors] = useState<Anchor[]>([])

  useEffect(() => {
    if (!engine) return
    let lastKey = ''
    return engine.addUpdatable({
      update: () => {
        const canvas = engine.renderer.canvas
        if (!canvas || !engine.disclosure) {
          if (lastKey) { lastKey = ''; setAnchors([]) }
          return
        }
        const rect = canvas.getBoundingClientRect()
        // 锚点为 client 坐标 → 容器相对坐标(浮层是画布兄弟节点,同容器定位)
        const list = engine.disclosure.screenAnchors(false).flatMap((a) => {
          // 相机补间中途投影可能暂不可解(NaN/Infinity)——跳过该帧,不渲染非法 style
          const x = a.x - rect.left
          const y = a.y - rect.top
          if (!Number.isFinite(x) || !Number.isFinite(y)) return []
          return [{ eventId: a.eventId, x, y, teaser: engine.getEventById(a.eventId)?.teaser ?? '' }]
        })
        const key = list.map((a) => `${a.eventId}:${Math.round(a.x)}:${Math.round(a.y)}`).join('|')
        if (key !== lastKey) {
          lastKey = key
          setAnchors(list)
        }
      },
    })
  }, [engine])

  if (anchors.length === 0) return null
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="event-overlay">
      {anchors.map((a) => (
        <button
          key={a.eventId}
          type="button"
          data-testid={`event-teaser-${a.eventId}`}
          className="pointer-events-auto absolute max-w-56 -translate-x-1/2 truncate rounded-full bg-black/70 px-3 py-1 text-xs text-zinc-100 shadow hover:bg-black/85"
          style={{ left: a.x, top: a.y - 40 }}
          onClick={() => onSelect(a.eventId)}
        >
          {a.teaser}
        </button>
      ))}
    </div>
  )
}

// ── 点击路由(VoxelViewport 与 dev-harness 共用) ──────────

export interface EventClickRouting {
  /** 画布坐标(client px)点击:命中事件则消费 */
  routeAt: (x: number, y: number) => boolean
  /** 按 id 路由(浮层点击) */
  routeById: (id: string) => boolean
  /** 当前面板事件 id(关闭传 null) */
  panelEventId: string | null
  setPanelEventId: (id: string | null) => void
  /** 面板事件相位(active/trace;事件消失 = null) */
  panelPhase: EventPhase | null
}

/**
 * 路由规则(F5/F6):残影事件任意档直接开面板;active 且 close 档开面板;
 * 其余飞向事件(相机补间落定 close 档后不自动开面板,行为分层)。
 */
export function useEventClickRouting(engine: VoxelEngine | null): EventClickRouting {
  const [panelEventId, setPanelEventId] = useState<string | null>(null)

  const routeById = useCallback((id: string): boolean => {
    if (!engine) return false
    const state = engine.getEventDisclosure().find((s) => s.eventId === id)
    if (!state || state.level === 'none') return false
    if (state.phase === 'trace' || engine.getZoomTier() === 'close') {
      setPanelEventId(id)
      return true
    }
    return engine.flyToEvent(id)
  }, [engine])

  const routeAt = useCallback((x: number, y: number): boolean => {
    const id = engine?.pickEventAt(x, y)
    return id ? routeById(id) : false
  }, [engine, routeById])

  const panelPhase = panelEventId
    ? (engine?.getEventDisclosure().find((s) => s.eventId === panelEventId)?.phase ?? null)
    : null

  return { routeAt, routeById, panelEventId, setPanelEventId, panelPhase }
}
