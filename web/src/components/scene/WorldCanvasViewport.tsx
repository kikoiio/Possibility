import { useEffect, useRef, useState } from 'react'
import type { SceneDocument, SceneLifeOverlay, SceneMode, ScenePreviewResult } from '@possibility/scene-contract'
import { WorldCanvasRenderer } from '../../scene/renderer/WorldCanvasRenderer'
import type { SceneCamera } from '../../scene/renderer/WorldCanvasRenderer'
import type { SceneOperation } from '@possibility/scene-contract'
import { contemporaryTheme } from '@possibility/scene-contract'
import type { SceneThemeManifest } from '@possibility/scene-contract'

export interface WorldCanvasViewportProps {
  scene: SceneDocument
  mode: SceneMode
  overlay?: SceneLifeOverlay | null
  preview?: ScenePreviewResult | null
  selectedId?: string | null
  activeAssetId?: string | null
  camera?: SceneCamera | null
  onCameraChange?: (camera: SceneCamera) => void
  onCanvasClick?: (position: { x: number; y: number }) => void
  onCanvasStroke?: (cells: { x: number; y: number }[]) => void
  onSelect?: (id: string | null) => void
  onMove?: (operation: SceneOperation) => void
  onError?: (message: string) => void
  edgeToEdge?: boolean
  theme?: SceneThemeManifest
}
export function WorldCanvasViewport({ scene, mode, overlay = null, preview = null, selectedId = null, activeAssetId = null, camera = null, onCameraChange, onCanvasClick, onCanvasStroke, onSelect, onMove, onError, edgeToEdge = false, theme = contemporaryTheme }: WorldCanvasViewportProps) {
  const host = useRef<HTMLDivElement>(null)
  const renderer = useRef<WorldCanvasRenderer | null>(null)
  const [error, setError] = useState('')
  const select = useRef(onSelect); select.current = onSelect
  const move = useRef(onMove); move.current = onMove
  const placeCell = useRef(onCanvasClick); placeCell.current = onCanvasClick
  const paintStroke = useRef(onCanvasStroke); paintStroke.current = onCanvasStroke
  const reportError = useRef(onError); reportError.current = onError
  useEffect(() => {
    if (!host.current) return
    const mobile = matchMedia('(max-width: 767px)').matches
    const instance = new WorldCanvasRenderer({
      onSelect: id => select.current?.(id),
      onMove: operation => move.current?.(operation),
      onViewportChange: viewport => onCameraChange?.({ x: viewport.center.x, y: viewport.center.y, zoom: viewport.zoom }),
      onInvalidDrop: reason => { setError(reason); reportError.current?.(reason) },
      onCanvasClick: position => placeCell.current?.(position),
      onCanvasStroke: cells => paintStroke.current?.(cells),
    }, mobile)
    renderer.current = instance
    void instance.mount(host.current).then(() => instance.setCatalog(theme)).catch(e => setError(e instanceof Error ? e.message : '画布加载失败'))
    return () => { instance.destroy(); renderer.current = null }
  }, [theme])
  useEffect(() => { renderer.current?.setDocument(scene) }, [scene])
  useEffect(() => { renderer.current?.setOverlay(overlay) }, [overlay])
  useEffect(() => { renderer.current?.setMode(mode) }, [mode])
  useEffect(() => { renderer.current?.setPreview(preview) }, [preview])
  useEffect(() => { renderer.current?.setSelected(selectedId) }, [selectedId])
  useEffect(() => {
    const category = theme.assets.find(asset => asset.id === activeAssetId)?.category
    renderer.current?.setPaintMode(category === 'terrain' || category === 'road' || category === 'water')
  }, [activeAssetId, theme])
  useEffect(() => { if (camera) renderer.current?.setCamera(camera) }, [camera])
  return <div className={`overflow-hidden bg-[#e7eee7] ${edgeToEdge ? 'absolute inset-0' : 'relative min-h-0 flex-1 rounded-3xl'}`} data-testid="world-canvas" data-time-of-day={overlay?.timeOfDay ?? 'day'}>
    <div ref={host} className="absolute inset-0 touch-none" />
    {!edgeToEdge && <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between p-3 text-xs text-[#41594d]">
      <span className="rounded-full bg-white/75 px-3 py-1.5">固定等距视角 · {scene.size.columns} × {scene.size.rows}</span>
      <span className="rounded-full bg-white/75 px-3 py-1.5">{mode === 'create' ? '拖动场景对象以调整位置' : '拖动浏览 · 点选了解地点与居民'}</span>
    </div>}
    {error && <div role="status" className="absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-white px-4 py-2 text-sm text-red-700 shadow">{error}<button className="ml-3" onClick={() => setError('')}>知道了</button></div>}
  </div>
}
