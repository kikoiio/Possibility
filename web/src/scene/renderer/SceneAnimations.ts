import type { Container } from 'pixi.js'

export function reduceMotionEnabled(): boolean { return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches }
export function animateSceneArrival(layers: Container[], reduced = reduceMotionEnabled()): () => void {
  if (reduced) return () => {}
  let cancelled = false
  const frames = new Set<number>()
  layers.forEach((layer, index) => {
    layer.alpha = 0
    const start = performance.now() + index * 55; const tick = () => {
      if (cancelled || !layer.parent) return
      const progress = Math.max(0, Math.min(1, (performance.now() - start) / 260))
      layer.alpha = progress
      if (progress < 1) frames.add(requestAnimationFrame(tick))
    }
    frames.add(requestAnimationFrame(tick))
  })
  return () => { cancelled = true; frames.forEach(cancelAnimationFrame); frames.clear() }
}
