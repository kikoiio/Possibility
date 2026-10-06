const POLL_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 8_000] as const

export interface CompatibilityPollingOptions {
  query(): Promise<unknown>
  isVisible(): boolean
  subscribeVisibility(listener: () => void): () => void
}

/** Query a pending request at most five times while its page remains visible. */
export function startCompatibilityPolling(options: CompatibilityPollingOptions): () => void {
  let active = true
  let inFlight = false
  let pollCount = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const schedule = () => {
    clearTimer()
    if (!active || inFlight || pollCount >= POLL_DELAYS_MS.length || !options.isVisible()) return
    timer = setTimeout(async () => {
      timer = null
      if (!active || !options.isVisible()) return
      pollCount += 1
      inFlight = true
      try { await options.query() } catch { /* queryResult publishes the unknown state */ }
      inFlight = false
      schedule()
    }, POLL_DELAYS_MS[pollCount])
  }
  const unsubscribe = options.subscribeVisibility(schedule)
  schedule()

  return () => {
    active = false
    clearTimer()
    unsubscribe()
  }
}
