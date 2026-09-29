import { useEffect } from 'react'
import type { VoxelEngine } from '../engine'

export const CLICK_SLOP_PX = 6

/** 画布点击（位移小于阈值才算点击，避免与相机拖动冲突） */
export function useCanvasClick(engine: VoxelEngine | null, active: boolean, onClick: (x: number, y: number) => void): void {
  useEffect(() => {
    const canvas = engine?.renderer.canvas
    if (!canvas || !active) return
    let downX = 0
    let downY = 0
    const onPointerDown = (e: PointerEvent) => {
      downX = e.clientX
      downY = e.clientY
    }
    const onPointerUp = (e: PointerEvent) => {
      if (e.button !== 0) return
      if (Math.hypot(e.clientX - downX, e.clientY - downY) <= CLICK_SLOP_PX) onClick(e.clientX, e.clientY)
    }
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerup', onPointerUp)
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup', onPointerUp)
    }
  }, [engine, active, onClick])
}
