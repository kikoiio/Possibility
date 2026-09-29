/** prefers-reduced-motion 检测（N8）：粒子密度与循环动画的全局降级开关 */
export class MotionPreference {
  private reduced: boolean
  private listeners = new Set<(reduced: boolean) => void>()
  private media: MediaQueryList | null = null

  constructor(query?: () => MediaQueryList | null) {
    const getMedia = query ?? (() => (
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null
    ))
    this.media = getMedia()
    this.reduced = this.media?.matches ?? false
    this.media?.addEventListener?.('change', this.handleChange)
  }

  private handleChange = (e: MediaQueryListEvent) => {
    this.reduced = e.matches
    for (const fn of this.listeners) fn(this.reduced)
  }

  isReduced(): boolean {
    return this.reduced
  }

  /** 粒子密度系数：降级时归零（AC8） */
  particleScale(): number {
    return this.reduced ? 0 : 1
  }

  /** 循环动画时间流速：降级时静止 */
  animationTimeScale(): number {
    return this.reduced ? 0 : 1
  }

  onChange(fn: (reduced: boolean) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  dispose(): void {
    this.media?.removeEventListener?.('change', this.handleChange)
    this.media = null
    this.listeners.clear()
  }
}
